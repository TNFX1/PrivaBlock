// PrivaBlock for Chromium (MV3 service worker). Bundled lists are static DNR rulesets built by
// tools/build.mjs; user filters, custom lists and per-site switches are dynamic rules.
import { Engine } from "../core/engine.js";
import { parseList } from "../core/filters.js";
import { LISTS, PROFILES, enabledLists } from "../core/lists.js";
import { listToRules, siteDisabledRule } from "../core/dnr.js";
import { normalizeHost, domainMatches } from "../core/psl.js";
import { loadSettings, migrate, fetchList, siteForUrl, pickerFilter, withFilter, backupValues } from "../core/runtime.js";
import { hostMatches } from "../core/scriptlets.js";

const dnr = chrome.declarativeNetRequest;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_DYNAMIC = dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000;

let cosmetic = null; // Promise<Engine> for cosmetic rules, rebuilt lazily after a change

// ------------------------------------------------------------------ rules

async function applyStaticRulesets(settings) {
  const want = new Set(enabledLists(settings.profile, settings.listOverrides));
  const enabled = new Set(await dnr.getEnabledRulesets());
  const enableRulesetIds = [...want].filter((id) => !enabled.has(id));
  const disableRulesetIds = [...enabled].filter((id) => !want.has(id));
  try {
    if (enableRulesetIds.length || disableRulesetIds.length) await dnr.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    await chrome.storage.local.set({ staticError: "" });
  } catch (error) {
    // Chromium caps the total of enabled static rules shared by all extensions.
    await chrome.storage.local.set({ staticError: String(error.message || error) });
  }
}

async function customListText(list, force) {
  const key = `list:${list.id}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && !force && Date.now() - cached.updated < REFRESH_AFTER_MS) return cached;
  try {
    const entry = { text: await fetchList(list.url), updated: Date.now() };
    await chrome.storage.local.set({ [key]: entry });
    return entry;
  } catch (error) {
    if (cached) return { ...cached, error: String(error.message || error) };
    throw error;
  }
}

/** Rebuild every dynamic rule: per-site switches first, then user filters and custom lists. */
async function applyDynamicRules(settings, force = false) {
  const rules = settings.disabledSites.map((site, i) => siteDisabledRule(i + 1, site));
  const lists = {};
  const sources = [{ id: "user", text: settings.myFilters }];
  for (const list of Object.values(settings.customLists)) {
    if (list.enabled === false) continue;
    try {
      const got = await customListText(list, force);
      sources.push({ id: list.id, text: got.text });
      lists[list.id] = { ok: true, updated: got.updated, error: got.error };
    } catch (error) {
      lists[list.id] = { ok: false, error: String(error.message || error) };
    }
  }
  let truncated = 0;
  for (const { id, text } of sources) {
    const { rules: converted, skipped } = listToRules(parseList(text, id), rules.length + 1);
    const room = MAX_DYNAMIC - rules.length;
    rules.push(...converted.slice(0, Math.max(0, room)));
    truncated += Math.max(0, converted.length - room);
    lists[id] = { ...lists[id], ok: lists[id]?.ok ?? true, rules: converted.length, skipped };
  }
  const old = await dnr.getDynamicRules();
  await dnr.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules: rules });
  await chrome.storage.local.set({ dynamicStatus: { lists, truncated, count: rules.length, max: MAX_DYNAMIC, updated: Date.now() } });
}

async function applyAll(force = false) {
  const settings = await loadSettings(chrome.storage.local);
  await applyStaticRulesets(settings);
  await applyDynamicRules(settings, force);
  await applyScriptlets(settings);
  cosmetic = null;
}

// Each bundled list's scriptlets are handoff scripts built by tools/build.mjs (scriptlets/<id>-<n>.js, one per
// shard of hosts), registered for the hosts they have calls for, so the calls reach the page at document_start.
async function applyScriptlets(settings) {
  const counts = await bundledCounts();
  const excludeMatches = hostMatches(settings.disabledSites);
  const scripts = enabledLists(settings.profile, settings.listOverrides).flatMap((id) => (counts[id]?.scriptletShards || []).map((matches, i) => ({
    id: `sl-${id}-${i}`, js: [`scriptlets/${id}-${i}.js`], matches,
    ...(excludeMatches.length ? { excludeMatches } : {}), runAt: "document_start", allFrames: true, persistAcrossSessions: true,
  })));
  try {
    const old = (await chrome.scripting.getRegisteredContentScripts()).filter((c) => c.id.startsWith("sl-"));
    if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old.map((c) => c.id) });
    if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
  } catch (error) {
    console.error("PrivaBlock scriptlet registration failed", error);
  }
}

// ------------------------------------------------------------------ cosmetic filtering

async function cosmeticEngine() {
  cosmetic ??= (async () => {
    const settings = await loadSettings(chrome.storage.local);
    const engine = new Engine();
    for (const id of enabledLists(settings.profile, settings.listOverrides)) {
      try {
        const data = await (await fetch(chrome.runtime.getURL(`cosmetic/${id}.json`))).json();
        engine.addCosmetic(data.cosmetic, data.exceptions); // scriptlets of bundled lists are registered instead
        engine.addPopups(data.popups, data.popupExceptions);
        engine.addHideExceptions(data.hideExceptions);
      } catch {
        // list without cosmetic rules
      }
    }
    const texts = [settings.myFilters];
    for (const list of Object.values(settings.customLists)) {
      if (list.enabled === false) continue;
      const cached = (await chrome.storage.local.get(`list:${list.id}`))[`list:${list.id}`];
      if (cached) texts.push(cached.text);
    }
    for (const text of texts) {
      const parsed = parseList(text, "user");
      engine.addCosmetic(parsed.cosmetic, parsed.cosmeticExceptions);
      engine.addScriptlets(parsed.scriptlets, parsed.scriptletExceptions);
      engine.addPopups(parsed.popups, parsed.popupExceptions);
      engine.addHideExceptions(parsed.hideExceptions);
    }
    return { engine, disabledSites: settings.disabledSites };
  })();
  return cosmetic;
}

// ------------------------------------------------------------------ messages

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function updateSetting(values) {
  await chrome.storage.local.set(values);
  if ("showBadge" in values) await applyBadgeOption();
  await applyAll(false);
  return { ok: true };
}

// The popup's per-tab count, kept live from webRequest because getMatchedRules is limited to 20 calls per
// 10 minutes (declarativeNetRequestFeedback does not lift that) and the open popup asks once a second.
// tabId -> { doc: top document's documentId, n: requests blocked on it, known: n counts from the document's
// start, or was seeded from getMatchedRules, pre: { documentId: blocks seen while that document prerendered } }.
// Kept in storage.session so it outlives the worker's sleep.
let tabCounts = null;
function loadTabCounts() {
  tabCounts ??= chrome.storage.session.get("tabCounts").then(
    ({ tabCounts: saved = {} }) => new Map(Object.entries(saved).map(([id, c]) => [Number(id), c])),
    () => {
      tabCounts = null; // try the read again next time rather than keep the failure
      return new Map();
    });
  return tabCounts;
}
// Changes run in event order: each awaits the same loaded Map. Writes are gathered into one per half second,
// so a page blocking hundreds of requests doesn't make hundreds of writes.
let saveTimer = null;
async function changeTabCounts(change) {
  const counts = await loadTabCounts();
  change(counts);
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    chrome.storage.session.set({ tabCounts: Object.fromEntries(counts) }).catch(() => {});
  }, 500);
}

// A new top document starts the count again. tabs.onUpdated can't tell: it says "loading" for
// history.pushState too, where the page (and Chromium's toolbar count) carries on.
// known: the document's own start (content script), so the count is from the document's start.
function newDocument(counts, tabId, doc, known) {
  const c = counts.get(tabId);
  // doc null: counted before this worker learnt the document (subframe block or seed), so a top-frame block adopts it
  if (c && (c.doc === doc || (c.doc === null && !known))) return Object.assign(c, { doc, known: c.known || known });
  return counts.set(tabId, { doc, n: c?.pre?.[doc] || 0, known }).get(tabId); // blocks it made while prerendering
}
// A document becoming the page without starting there: a prerendered page activated, or one restored from the
// back/forward cache. Its count is what it blocked while prerendering (0 after a restore, as Chromium's own count).
function shownDocument(counts, tabId, doc) {
  const c = counts.get(tabId);
  if (c?.doc === doc && !c.known) c.known = true; // its first block got here first and started the count
  else counts.set(tabId, { doc, n: c?.pre?.[doc] || 0, known: true });
}

// Registered at the top level so a block wakes the sleeping worker.
// shortcut: ERR_BLOCKED_BY_CLIENT is what every blocker reports: other extensions (Helium bundles uBlock Origin,
// so on ad-heavy pages the popup number sitting above the toolbar number is the normal case there) and Chromium's
// own subresource filter and heavy-ad intervention. Nothing in the event names who blocked, so all are counted;
// count our own only if Chromium ever says whose.
chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (details.error !== "net::ERR_BLOCKED_BY_CLIENT" || details.tabId < 0) return;
  if (details.documentLifecycle === "prerender") {
    // shortcut: unproven in a browser (Helium refuses to prerender: PreloadingDisabled); frames nested two deep in a
    // prerendered page aren't traced to it, so their blocks are left out. Test in Chrome with speculation rules.
    const doc = details.frameType === "outermost_frame" ? details.documentId : details.parentDocumentId;
    if (doc) changeTabCounts((counts) => {
      const c = counts.get(details.tabId) ?? counts.set(details.tabId, { doc: null, n: 0, known: false }).get(details.tabId);
      c.pre = { ...c.pre, [doc]: (c.pre?.[doc] || 0) + 1 };
    });
    return;
  }
  if (details.documentLifecycle && details.documentLifecycle !== "active") return; // a page being left or cached
  changeTabCounts((counts) => {
    // A block in the top frame can name the new document before the content script does.
    const c = details.frameId === 0 && details.documentId ? newDocument(counts, details.tabId, details.documentId, false)
      : counts.get(details.tabId) ?? counts.set(details.tabId, { doc: null, n: 0, known: false }).get(details.tabId);
    c.n++;
  });
}, { urls: ["<all_urls>"] });
// A request answered with one of PrivaBlock's surrogates ($redirect) was blocked too; count it the same way.
const SURROGATES = chrome.runtime.getURL("redirects/");
chrome.webRequest.onBeforeRedirect.addListener((details) => {
  if (details.tabId < 0 || !details.redirectUrl?.startsWith(SURROGATES)) return;
  if (details.documentLifecycle && details.documentLifecycle !== "active") return;
  changeTabCounts((counts) => {
    const c = details.frameId === 0 && details.documentId ? newDocument(counts, details.tabId, details.documentId, false)
      : counts.get(details.tabId) ?? counts.set(details.tabId, { doc: null, n: 0, known: false }).get(details.tabId);
    c.n++;
  });
}, { urls: ["<all_urls>"] });
chrome.tabs.onRemoved.addListener((tabId) => changeTabCounts((counts) => counts.delete(tabId)));
chrome.tabs.onReplaced.addListener((added, removed) => changeTabCounts((counts) => counts.delete(removed)));

const SEED_RETRY_MS = 60_000; // a refused seed is tried again after this, well inside the 20 calls per 10 minutes
const seedTried = new Map(); // tabId -> when its seed last started; in memory, so a worker that died mid-seed retries

/** Requests blocked on the tab's current document; seeded from getMatchedRules for a tab opened before this worker counted it. */
async function pageBlockedOnTab(tabId) {
  const c = (await loadTabCounts()).get(tabId);
  if (c?.known || Date.now() - (seedTried.get(tabId) || 0) < SEED_RETRY_MS) return c?.n || 0;
  seedTried.set(tabId, Date.now());
  const doc = c?.doc ?? null;
  let seed;
  try {
    seed = (await matchedOnTab(tabId)).filter((m) => m.action === "block").length;
  } catch {
    return c?.n || 0; // refused (quota): ask again after SEED_RETRY_MS
  }
  seedTried.delete(tabId);
  await changeTabCounts((counts) => {
    const now = counts.get(tabId);
    if (!now) return counts.set(tabId, { doc, n: seed, known: true });
    if (now.known || (now.doc !== doc && doc !== null)) return; // a new document started meanwhile
    // The seed holds our own blocks only and the live count everyone's (see the shortcut above), so max mixes
    // the two; it keeps the number from going down, and the blocks counted while it was asked are in the seed.
    Object.assign(now, { n: Math.max(now.n, seed), known: true });
  });
  return (await loadTabCounts()).get(tabId)?.n ?? 0;
}

/** Rules Chromium matched on a tab since its last navigation, each marked block or allow. */
async function matchedOnTab(tabId) {
  const [{ rulesMatchedInfo }, staticIds, dynamic] = await Promise.all([dnr.getMatchedRules({ tabId }), staticAllowIds(), dnr.getDynamicRules()]);
  const dynamicAllow = new Set(dynamic.filter((r) => r.action.type === "allow" || r.action.type === "allowAllRequests").map((r) => `${dnr.DYNAMIC_RULESET_ID}:${r.id}`));
  const isAllow = (key) => staticIds.has(key) || dynamicAllow.has(key);
  return rulesMatchedInfo.map((m) => ({
    time: m.timeStamp, ruleId: m.rule.ruleId,
    action: isAllow(`${m.rule.rulesetId}:${m.rule.ruleId}`) ? "allow" : "block",
    source: m.rule.rulesetId === dnr.DYNAMIC_RULESET_ID ? "user" : m.rule.rulesetId,
  }));
}

// The toolbar number is Chromium's own count of matched rules. 3.0.0 never showed it: it called
// setExtensionActionOptions on chrome.action, where it does not exist, instead of declarativeNetRequest.
// Never rejects, so a browser without the option still starts the worker and runs the other steps.
async function applyBadgeOption() {
  try {
    const { showBadge } = await loadSettings(chrome.storage.local);
    await dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: showBadge });
  } catch (error) {
    console.error("PrivaBlock badge count option failed", error);
  }
}

const handlers = {
  getCapabilities: () => ({ browser: "chromium", fingerprint: false, dailyStats: false, fullLogger: false, benchmark: false, bundledLists: true }),

  // tabId: the popup asks about the active tab; the smoke test names one.
  async getStats({ tabId } = {}) {
    const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : await activeTab();
    const site = siteForUrl(tab?.url);
    const settings = await loadSettings(chrome.storage.local);
    const pageBlocked = tab ? await pageBlockedOnTab(tab.id) : 0;
    return {
      site, tabId: tab?.id, web: !!site,
      siteDisabled: !!site && settings.disabledSites.includes(site),
      pageBlocked,
      ruleCount: await enabledRuleCount(settings), loading: false,
    };
  },

  async getSettings() {
    const settings = await loadSettings(chrome.storage.local);
    const { dynamicStatus = {}, staticError = "" } = await chrome.storage.local.get(["dynamicStatus", "staticError"]);
    const counts = await bundledCounts();
    const lists = {};
    for (const id of Object.keys(LISTS)) lists[id] = { ok: true, bundled: true, rules: counts[id]?.rules ?? 0, cosmetic: counts[id]?.cosmetic ?? 0 };
    Object.assign(lists, dynamicStatus.lists || {});
    return {
      ...settings, enabled: enabledLists(settings.profile, settings.listOverrides), lists,
      ruleCount: await enabledRuleCount(settings), staticError,
      dynamic: { count: dynamicStatus.count || 0, max: dynamicStatus.max || MAX_DYNAMIC, truncated: dynamicStatus.truncated || 0 },
      updated: dynamicStatus.updated || 0, version: chrome.runtime.getManifest().version, loading: false,
    };
  },

  setProfile: ({ profile }) => (PROFILES[profile] ? updateSetting({ profile, listOverrides: {} }) : { ok: false }),
  async setList({ id, enabled }) {
    if (!LISTS[id]) return { ok: false };
    const { listOverrides = {} } = await chrome.storage.local.get("listOverrides");
    return updateSetting({ listOverrides: { ...listOverrides, [id]: !!enabled } });
  },
  async updateFilters() {
    await applyAll(true);
    return { ok: true };
  },
  async addCustomList({ name, url }) {
    if (!/^https?:\/\//i.test(String(url))) return { ok: false };
    const { customLists = {} } = await chrome.storage.local.get("customLists");
    const id = `custom_${Date.now().toString(36)}`;
    return updateSetting({ customLists: { ...customLists, [id]: { id, name: String(name).slice(0, 80), url: String(url), enabled: true } } });
  },
  async removeCustomList({ id }) {
    const { customLists = {} } = await chrome.storage.local.get("customLists");
    delete customLists[id];
    await chrome.storage.local.remove(`list:${id}`);
    return updateSetting({ customLists });
  },
  async toggleCustomList({ id, enabled }) {
    const { customLists = {} } = await chrome.storage.local.get("customLists");
    if (!customLists[id]) return { ok: false };
    customLists[id] = { ...customLists[id], enabled: !!enabled };
    return updateSetting({ customLists });
  },
  saveMyFilters: ({ text }) => updateSetting({ myFilters: String(text || "") }),
  setShowBadge: ({ enabled }) => updateSetting({ showBadge: !!enabled }),
  async setSiteEnabled({ site, enabled, tabId }) {
    site = normalizeHost(site);
    if (!site) return { ok: false };
    const settings = await loadSettings(chrome.storage.local);
    const sites = new Set(settings.disabledSites);
    if (enabled) sites.delete(site);
    else sites.add(site);
    await updateSetting({ disabledSites: [...sites] });
    if (Number.isInteger(tabId)) chrome.tabs.reload(tabId).catch(() => {});
    else await clearSiteBadges(site, enabled);
    return { ok: true };
  },
  async openLogger() {
    const tab = await activeTab();
    if (!tab) return { ok: false };
    await chrome.tabs.create({ url: chrome.runtime.getURL(`ui/logger.html?tabId=${tab.id}`) });
    return { ok: true };
  },
  getMatched: ({ tabId }) => matchedOnTab(Number(tabId)),
  recordCosmetic: () => ({ ok: true }), // the badge counts network blocks only on Chromium
  // From the top frame's content script when its document becomes the page without loading: see shownDocument.
  newDocument(message, sender) {
    // No frameId 0 test: a prerendered page's top frame has another frameId, and the content script sends this from the top frame only.
    if (sender.tab && sender.documentId) changeTabCounts((counts) => shownDocument(counts, sender.tab.id, sender.documentId));
    return { ok: true };
  },
  async getCosmetic({ host }, sender) {
    // The content script asks at document_start, so this is where a top document's count starts.
    if (sender.frameId === 0 && sender.tab && sender.documentId) changeTabCounts((counts) => newDocument(counts, sender.tab.id, sender.documentId, true));
    const h = normalizeHost(host);
    const { engine, disabledSites } = await cosmeticEngine();
    if (!h || disabledSites.some((d) => h === d || h.endsWith(`.${d}`))) return { enabled: false, selectors: [] };
    return {
      enabled: true, selectors: engine.cosmeticFor(h), procedural: engine.proceduralFor(h), scriptlets: engine.scriptletsFor(h),
      generic: engine.genericHighFor(h), genericOff: engine.hidingOff(h).generic,
    };
  },
  // The page's classes and ids → generic selectors that start with one of them.
  async getGeneric({ host, tokens }) {
    const h = normalizeHost(host);
    const { engine, disabledSites } = await cosmeticEngine();
    if (!h || disabledSites.some((d) => domainMatches(h, d)) || !Array.isArray(tokens)) return { selectors: [] };
    return { selectors: engine.genericFor(h, tokens.slice(0, 5000).map(String)) };
  },
  async startPicker() {
    return startPicker(await activeTab());
  },
  // From the picker in a page: the rule is built here, for the page the message came from.
  async pickerCreate({ selector }, sender) {
    const filter = sender.frameId === 0 && pickerFilter(sender.url, selector);
    if (!filter) return { ok: false };
    const { myFilters } = await loadSettings(chrome.storage.local);
    await updateSetting({ myFilters: withFilter(myFilters, filter) });
    return { ok: true, filter };
  },
  async importSettings({ data }) {
    const values = backupValues(data);
    if (!values) return { ok: false };
    delete values.fingerprint; // Firefox only
    await updateSetting(values);
    return { ok: true };
  },
};

let ruleTotals = null;
async function bundledCounts() {
  ruleTotals ??= fetch(chrome.runtime.getURL("rulesets/counts.json")).then((r) => r.json()).catch(() => ({}));
  return ruleTotals;
}
let staticAllow = null; // "rulesetId:ruleId" of every bundled allow rule; fixed for the build, so built once
async function staticAllowIds() {
  staticAllow ??= bundledCounts().then((counts) => {
    const ids = new Set();
    for (const [id, c] of Object.entries(counts)) for (const ruleId of c.allowIds || []) ids.add(`${id}:${ruleId}`);
    return ids;
  });
  return staticAllow;
}
async function enabledRuleCount(settings) {
  const counts = await bundledCounts();
  const { dynamicStatus = {} } = await chrome.storage.local.get("dynamicStatus");
  return enabledLists(settings.profile, settings.listOverrides).reduce((n, id) => n + (counts[id]?.rules || 0), 0) + (dynamicStatus.count || 0);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  const contentAllowed = ["getCosmetic", "getGeneric", "recordCosmetic", "newDocument", "pickerCreate"].includes(message?.type);
  const handler = handlers[message?.type];
  if (!handler || (!fromExtensionPage && !contentAllowed)) return false;
  Promise.resolve(handler(message, sender)).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true; // async response
});

// A site switched off from Settings reloads nothing, and Chromium keeps its automatic toolbar count for
// the open tabs. Text set for a tab wins over that count until the tab navigates; null hands it back.
async function clearSiteBadges(site, enabled) {
  for (const tab of await chrome.tabs.query({})) {
    const tabSite = siteForUrl(tab.url);
    if (!tabSite || !domainMatches(tabSite, site)) continue;
    // A browser that refuses null throws before returning a promise.
    await Promise.resolve().then(() => chrome.action.setBadgeText({ tabId: tab.id, text: enabled ? null : "" })).catch(() => {});
  }
}

// ------------------------------------------------------------------ popups

// A tab a page opens ($popup filters, which DNR can't express): its first web address is checked against
// the lists and the tab closed if they block it. Tabs opened by another tab in the last few seconds count.
const POPUP_WATCH_MS = 4000;
const popupWatch = new Map(); // tabId → { pageHost, until }

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!Number.isInteger(tab.openerTabId)) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  let pageHost = "";
  try {
    pageHost = new URL(opener?.url || "").hostname;
  } catch {}
  if (!pageHost) return;
  popupWatch.set(tab.id, { pageHost, until: Date.now() + POPUP_WATCH_MS });
  const url = tab.pendingUrl || tab.url || "";
  if (/^https?:/.test(url)) checkPopup(tab.id, url);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && popupWatch.has(tabId)) checkPopup(tabId, change.url);
});
chrome.tabs.onRemoved.addListener((tabId) => popupWatch.delete(tabId));

async function checkPopup(tabId, url) {
  const watch = popupWatch.get(tabId);
  if (!watch || Date.now() > watch.until) return popupWatch.delete(tabId);
  if (!/^https?:/.test(url)) return;
  popupWatch.delete(tabId); // only the first web address decides
  const { engine, disabledSites } = await cosmeticEngine();
  if (disabledSites.some((d) => domainMatches(watch.pageHost, d))) return;
  if (engine.popupBlocked({ url, pageHost: watch.pageHost })) chrome.tabs.remove(tabId).catch(() => {});
}

// ------------------------------------------------------------------ element picker & shortcuts

async function startPicker(tab) {
  const site = siteForUrl(tab?.url);
  const { disabledSites } = await loadSettings(chrome.storage.local);
  if (!site || disabledSites.some((d) => domainMatches(site, d))) return { ok: false };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/picker.js"] });
  return { ok: true };
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ??= await activeTab();
  if (command === "pick-element") startPicker(tab).catch(() => {});
  if (command === "toggle-site") {
    const site = siteForUrl(tab?.url);
    if (!site) return;
    const { disabledSites } = await loadSettings(chrome.storage.local);
    handlers.setSiteEnabled({ site, enabled: disabledSites.includes(site), tabId: tab.id }).catch(() => {});
  }
});

// ------------------------------------------------------------------ lifecycle

// On every worker start, not only onInstalled: a browser restart starts the worker without onInstalled.
applyBadgeOption();
chrome.action.setBadgeBackgroundColor({ color: "#2f5bea" }).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("refresh-lists", { periodInMinutes: 360 });
  await migrate(chrome.storage.local).catch((error) => console.error("PrivaBlock migration failed", error));
  await applyAll(false).catch((error) => console.error("PrivaBlock rule setup failed", error));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh-lists") applyAll(false).catch(() => {});
});
