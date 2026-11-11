// PrivaBlock for Firefox: blocking webRequest engine (MV2, persistent background page).
import { Engine } from "../core/engine.js";
import { parseList, badfiltersOf, RESOURCE_TYPES } from "../core/filters.js";
import { redirectFile } from "../core/redirects.js";
import { LISTS, PROFILES, enabledLists } from "../core/lists.js";
import { normalizeHost, sameSite, domainMatches } from "../core/psl.js";
import { loadSettings, migrate, today, fetchList, siteForUrl, listName, pickerFilter, withFilter, backupValues } from "../core/runtime.js";
import { handoffCode, hostMatches, scriptletShards } from "../core/scriptlets.js";

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const STATS_FLUSH_MS = 5000;
const LOG_LIMIT = 1200;

let engine = new Engine();
const state = {
  settings: null,
  lists: {}, // id → { ok, rules, cosmetic, updated, error, source }
  ruleCount: 0,
  cosmeticCount: 0,
  updated: 0,
  loading: null,
  tabCounts: new Map(),
  day: today(),
  dailyBlocked: 0,
  statsTimer: null,
  log: new Map(), // tabId → entries (only while a logger is open for that tab)
  loggerPorts: new Map(), // tabId → Set(port)
};

// ------------------------------------------------------------------ filter lists

async function cachedOrFetched(id, url, force, anyAge = false) {
  const key = `list:${id}`;
  const cached = (await browser.storage.local.get(key))[key];
  const fresh = cached && (anyAge || Date.now() - cached.updated < REFRESH_AFTER_MS);
  if (cached && fresh && !force) return { text: cached.text, updated: cached.updated, source: "cache" };
  try {
    const text = await fetchList(url);
    const entry = { text, updated: Date.now() };
    await browser.storage.local.set({ [key]: entry });
    return { ...entry, source: "network" };
  } catch (error) {
    if (cached) return { text: cached.text, updated: cached.updated, source: "stale", error: String(error.message || error) };
    throw error;
  }
}

/**
 * Rebuild the engine from enabled lists. `force` re-downloads everything. A request that arrives
 * while a rebuild is running is queued (one follow-up run, with the newest settings), never dropped.
 */
let queued = null;
let queuedForce = false;
// anyAge: use cached lists however old (start-up, while pages wait); a later rebuild refreshes them.
function rebuild(force = false, anyAge = false) {
  if (state.loading) {
    queuedForce ||= force;
    queued ??= state.loading.then(() => {
      const f = queuedForce;
      queued = null;
      queuedForce = false;
      return rebuild(f);
    });
    return queued;
  }
  state.loading = (async () => {
    const s = state.settings;
    const next = new Engine();
    const lists = {};
    const sources = [
      ...enabledLists(s.profile, s.listOverrides).map((id) => ({ id, url: LISTS[id].url })),
      ...Object.values(s.customLists).filter((l) => l.enabled !== false).map((l) => ({ id: l.id, url: l.url })),
    ];
    const got = {};
    for (const { id, url } of sources) {
      try {
        got[id] = await cachedOrFetched(id, url, force, anyAge);
      } catch (error) {
        lists[id] = { ok: false, rules: 0, cosmetic: 0, error: String(error.message || error) };
      }
    }
    // $badfilter in any list (or My filters) cancels the filter in every list, as in uBO.
    const badfilters = badfiltersOf(s.myFilters);
    for (const g of Object.values(got)) badfiltersOf(g.text, badfilters);
    for (const [id, g] of Object.entries(got)) {
      const parsed = parseList(g.text, id, badfilters);
      next.add(parsed);
      lists[id] = { ok: true, rules: parsed.network.length + parsed.hosts.length, cosmetic: parsed.cosmetic.length, updated: g.updated, source: g.source, error: g.error };
    }
    const mine = parseList(s.myFilters, "user", badfilters);
    next.add(mine);
    lists.user = { ok: true, rules: mine.network.length + mine.hosts.length, cosmetic: mine.cosmetic.length };
    engine = next;
    state.lists = lists;
    state.ruleCount = next.stats.network + next.stats.hosts;
    state.cosmeticCount = next.stats.cosmetic;
    state.updated = Date.now();
    await registerScriptlets();
  })().finally(() => {
    state.loading = null;
  });
  return state.loading;
}

// ------------------------------------------------------------------ scriptlets

// Registered content scripts hand every page with scriptlet filters its calls at document_start (see
// src/core/scriptlets.js), one per shard of hosts. Registered again after each rebuild and per-site switch.
let scriptletRegistrations = [];
async function registerScriptlets() {
  const excludeMatches = hostMatches(state.settings.disabledSites);
  const results = await Promise.allSettled(scriptletShards(engine.scriptletData()).map(({ data, matches }) => browser.contentScripts.register({
    matches, ...(excludeMatches.length ? { excludeMatches } : {}),
    js: [{ code: handoffCode(data) }], runAt: "document_start", allFrames: true,
  })));
  // The new set is in place before the old one goes, so no page loads in between without scriptlets.
  const old = scriptletRegistrations;
  scriptletRegistrations = [];
  for (const r of results) {
    if (r.status === "fulfilled") scriptletRegistrations.push(r.value);
    else console.error("PrivaBlock scriptlet registration failed", r.reason);
  }
  await Promise.all(old.map((r) => r.unregister().catch(() => {})));
}

// ------------------------------------------------------------------ blocking

const TYPE_FROM_FIREFOX = { main_frame: "document", sub_frame: "subdocument", beacon: "ping", imageset: "image", xslt: "other", xml_dtd: "other", web_manifest: "other", speculative: "other" };

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function siteDisabled(pageHost) {
  return state.settings.disabledSites.some((d) => domainMatches(pageHost, d));
}

// Until the lists and scriptlets are in place after a browser start, web requests wait (as in uBlock
// Origin): a tab restored at start-up would otherwise load with nothing blocked and no scriptlets.
// Capped, so a start-up that hangs can't hold the browser.
const STARTUP_HOLD_MS = 15000;
let started = null; // promise of the first rebuild; null once it is done

function onBeforeRequest(d) {
  if (started && d.tabId >= 0) return started.then(() => onBeforeRequest(d));
  if (d.type === "main_frame" || !d.url) return {};
  let requestHost, pageHost;
  try {
    requestHost = new URL(d.url).hostname;
    pageHost = new URL(d.documentUrl || d.originUrl || d.url).hostname;
  } catch {
    return {};
  }
  if (siteDisabled(pageHost)) return {};
  const type = RESOURCE_TYPES.has(TYPE_FROM_FIREFOX[d.type] || d.type) ? TYPE_FROM_FIREFOX[d.type] || d.type : "other";
  const { block, filter } = engine.match({ url: d.url, requestHost, pageHost, type });
  if (state.loggerPorts.has(d.tabId)) log(d.tabId, { action: block ? "block" : "allow", type, url: d.url, filter, pageHost, requestHost });
  if (!block) {
    const replacers = engine.replacersFor({ url: d.url, requestHost, pageHost, type });
    if (replacers.length) rewriteResponse(d.requestId, replacers);
    return {};
  }
  countBlocked(d.tabId, 1);
  // A blocked script or media file can be answered with a harmless stand-in ($redirect / $redirect-rule).
  const file = redirectFile(filter.redirect?.resource || engine.redirectRuleFor({ url: d.url, requestHost, pageHost, type }));
  if (file) return { redirectUrl: browser.runtime.getURL(`redirects/${file}`) };
  return { cancel: true };
}

/** Apply $replace= filters to a response body (buffered whole; UTF-8 text only, anything else passes unchanged). */
function rewriteResponse(requestId, replacers) {
  let stream;
  try {
    stream = browser.webRequest.filterResponseData(requestId);
  } catch {
    return;
  }
  const chunks = [];
  stream.ondata = (event) => chunks.push(new Uint8Array(event.data));
  stream.onstop = () => {
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) bytes.set(c, (at += c.length) - c.length);
    try {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (const f of replacers) text = text.replace(f.replace.regex, f.replace.replacement);
      stream.write(new TextEncoder().encode(text));
    } catch {
      stream.write(bytes);
    }
    stream.close();
  };
  stream.onerror = () => {};
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, ["blocking"]);

// ------------------------------------------------------------------ popups

// A tab a page opens ($popup filters): its first web address is checked against the lists, and the tab
// closed if they block it. Tabs opened in the last few seconds by another tab are watched.
const POPUP_WATCH_MS = 4000;
const popupWatch = new Map(); // tabId → { opener page host, until }

browser.tabs.onCreated.addListener(async (tab) => {
  if (!Number.isInteger(tab.openerTabId)) return;
  const opener = await browser.tabs.get(tab.openerTabId).catch(() => null);
  const pageHost = hostOf(opener?.url || "");
  if (!pageHost || siteDisabled(pageHost)) return;
  popupWatch.set(tab.id, { pageHost, until: Date.now() + POPUP_WATCH_MS });
  if (/^https?:/.test(tab.url || "")) checkPopup(tab.id, tab.url);
});
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && popupWatch.has(tabId)) checkPopup(tabId, change.url);
});
browser.tabs.onRemoved.addListener((tabId) => popupWatch.delete(tabId));

function checkPopup(tabId, url) {
  const watch = popupWatch.get(tabId);
  if (!watch || Date.now() > watch.until) return popupWatch.delete(tabId);
  if (!/^https?:/.test(url)) return;
  popupWatch.delete(tabId); // only the first web address decides
  if (!engine.popupBlocked({ url, pageHost: watch.pageHost })) return;
  browser.tabs.remove(tabId).catch(() => {});
}

// ------------------------------------------------------------------ stats & badge

function countBlocked(tabId, n) {
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(n) || n < 1) return;
  const day = today();
  if (day !== state.day) {
    state.day = day;
    state.dailyBlocked = 0;
  }
  state.dailyBlocked += n;
  state.tabCounts.set(tabId, (state.tabCounts.get(tabId) || 0) + n);
  updateBadge(tabId);
  state.statsTimer ??= setTimeout(() => {
    state.statsTimer = null;
    browser.storage.local.set({ day: state.day, dailyBlocked: state.dailyBlocked }).catch(() => {});
  }, STATS_FLUSH_MS);
}

function updateBadge(tabId, siteOff = false) {
  const n = siteOff || state.settings?.showBadge === false ? 0 : state.tabCounts.get(tabId) || 0;
  browser.browserAction.setBadgeText({ tabId, text: n ? (n > 999 ? "999+" : String(n)) : "" }).catch(() => {});
}

browser.browserAction.setBadgeBackgroundColor({ color: "#2f5bea" }).catch(() => {});
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading" || !change.url) return;
  state.tabCounts.set(tabId, 0);
  updateBadge(tabId);
  if (state.log.has(tabId)) state.log.set(tabId, []);
});
browser.tabs.onRemoved.addListener((tabId) => {
  state.tabCounts.delete(tabId);
  state.log.delete(tabId);
});

// ------------------------------------------------------------------ logger

function log(tabId, { action, type, url, filter, pageHost, requestHost }) {
  const entry = {
    time: Date.now(), action, type, url,
    filter: filter?.pattern || "", source: listName(filter?.source, state.settings),
    context: pageHost, party: pageHost ? (sameSite(requestHost, pageHost) ? "1p" : "3p") : "",
  };
  const entries = state.log.get(tabId) || [];
  entries.push(entry);
  if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
  state.log.set(tabId, entries);
  for (const port of state.loggerPorts.get(tabId) || []) port.postMessage({ type: "entry", entry });
}

browser.runtime.onConnect.addListener((port) => {
  const tabId = Number(port.name.replace(/^logger:/, ""));
  if (!port.name.startsWith("logger:") || !Number.isInteger(tabId)) return;
  if (!state.loggerPorts.has(tabId)) state.loggerPorts.set(tabId, new Set());
  state.loggerPorts.get(tabId).add(port);
  if (!state.log.has(tabId)) state.log.set(tabId, []);
  for (const entry of state.log.get(tabId)) port.postMessage({ type: "entry", entry });
  port.onDisconnect.addListener(() => {
    const ports = state.loggerPorts.get(tabId);
    ports?.delete(port);
    if (!ports?.size) {
      state.loggerPorts.delete(tabId);
      state.log.delete(tabId);
    }
  });
});

// ------------------------------------------------------------------ fingerprinting (opt-in)

async function setFingerprint(enabled) {
  await updateSetting({ fingerprint: !!enabled });
  // Off = give the user's own Firefox setting back, never force it to false.
  if (enabled) await browser.privacy.websites.resistFingerprinting.set({ value: true });
  else await browser.privacy.websites.resistFingerprinting.clear({});
}

// ------------------------------------------------------------------ messages

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Save settings and apply them before replying, so the page that asked re-renders the new state. */
async function updateSetting(values) {
  await browser.storage.local.set(values);
  state.settings = await loadSettings(browser.storage.local);
  // Also when a site is switched off from Settings, which reloads nothing: its tabs show no count.
  if ("showBadge" in values || "disabledSites" in values) for (const tab of await browser.tabs.query({})) updateBadge(tab.id, siteDisabled(hostOf(tab.url)));
  if (["profile", "listOverrides", "customLists", "myFilters"].some((k) => k in values)) await rebuild(false).catch(() => {});
  else if ("disabledSites" in values) await registerScriptlets();
}

const handlers = {
  // Firefox for Android has no resistFingerprinting setting for extensions.
  getCapabilities: () => ({ browser: "firefox", fingerprint: !!browser.privacy?.websites?.resistFingerprinting, dailyStats: true, fullLogger: true, benchmark: true, bundledLists: false }),

  async getStats() {
    const tab = await activeTab();
    const site = siteForUrl(tab?.url);
    return {
      site, tabId: tab?.id, web: !!site,
      siteDisabled: !!site && siteDisabled(site),
      pageBlocked: state.tabCounts.get(tab?.id) || 0,
      dailyBlocked: state.day === today() ? state.dailyBlocked : 0,
      ruleCount: state.ruleCount, loading: !!state.loading,
    };
  },

  getSettings: () => ({
    ...state.settings,
    enabled: enabledLists(state.settings.profile, state.settings.listOverrides),
    lists: state.lists, ruleCount: state.ruleCount, cosmeticCount: state.cosmeticCount,
    updated: state.updated, loading: !!state.loading,
  }),

  async setProfile({ profile }) {
    if (!PROFILES[profile]) return { ok: false };
    await updateSetting({ profile, listOverrides: {} });
    return { ok: true };
  },
  async setList({ id, enabled }) {
    if (!LISTS[id]) return { ok: false };
    await updateSetting({ listOverrides: { ...state.settings.listOverrides, [id]: !!enabled } });
    return { ok: true };
  },
  async updateFilters() {
    await rebuild(true);
    return { ok: true, ruleCount: state.ruleCount };
  },
  async addCustomList({ name, url }) {
    if (!/^https?:\/\//i.test(String(url))) return { ok: false };
    const id = `custom_${Date.now().toString(36)}`;
    await updateSetting({ customLists: { ...state.settings.customLists, [id]: { id, name: String(name).slice(0, 80), url: String(url), enabled: true } } });
    return { ok: true };
  },
  async removeCustomList({ id }) {
    const customLists = { ...state.settings.customLists };
    delete customLists[id];
    await browser.storage.local.remove(`list:${id}`);
    await updateSetting({ customLists });
    return { ok: true };
  },
  async toggleCustomList({ id, enabled }) {
    const list = state.settings.customLists[id];
    if (!list) return { ok: false };
    await updateSetting({ customLists: { ...state.settings.customLists, [id]: { ...list, enabled: !!enabled } } });
    return { ok: true };
  },
  async saveMyFilters({ text }) {
    await updateSetting({ myFilters: String(text || "") });
    return { ok: true };
  },
  async setFingerprint({ enabled }) {
    await setFingerprint(enabled);
    return { ok: true };
  },
  async setShowBadge({ enabled }) {
    await updateSetting({ showBadge: !!enabled });
    return { ok: true };
  },
  async setSiteEnabled({ site, enabled, tabId }) {
    site = normalizeHost(site);
    if (!site) return { ok: false };
    const sites = new Set(state.settings.disabledSites);
    if (enabled) sites.delete(site);
    else sites.add(site);
    await updateSetting({ disabledSites: [...sites] });
    if (Number.isInteger(tabId)) browser.tabs.reload(tabId).catch(() => {});
    return { ok: true };
  },
  async openLogger() {
    const tab = await activeTab();
    if (!tab) return { ok: false };
    await browser.tabs.create({ url: browser.runtime.getURL(`ui/logger.html?tabId=${tab.id}`) });
    return { ok: true };
  },
  clearLog: ({ tabId }) => {
    if (state.log.has(tabId)) state.log.set(tabId, []);
    return { ok: true };
  },
  recordCosmetic: ({ count }, sender) => {
    countBlocked(sender.tab?.id, Number(count) || 0);
    return { ok: true };
  },
  getCosmetic: ({ host }) => {
    const h = normalizeHost(host);
    if (!h || siteDisabled(h)) return { enabled: false, selectors: [] };
    return { enabled: true, selectors: engine.cosmeticFor(h), procedural: engine.proceduralFor(h), generic: engine.genericHighFor(h), genericOff: engine.hidingOff(h).generic };
  },
  // The page's classes and ids → generic selectors that start with one of them.
  getGeneric: ({ host, tokens }) => {
    const h = normalizeHost(host);
    if (!h || siteDisabled(h) || !Array.isArray(tokens)) return { selectors: [] };
    return { selectors: engine.genericFor(h, tokens.slice(0, 5000).map(String)) };
  },
  async startPicker() {
    return startPicker(await activeTab());
  },
  // From the picker in a page: the rule is built here, for the page the message came from.
  async pickerCreate({ selector }, sender) {
    const filter = sender.frameId === 0 && pickerFilter(sender.url, selector);
    if (!filter) return { ok: false };
    await updateSetting({ myFilters: withFilter(state.settings.myFilters, filter) });
    return { ok: true, filter };
  },
  async importSettings({ data }) {
    const values = backupValues(data);
    if (!values) return { ok: false };
    const { fingerprint, ...rest } = values;
    await updateSetting(rest);
    if (fingerprint !== undefined && browser.privacy?.websites?.resistFingerprinting) await setFingerprint(fingerprint);
    return { ok: true };
  },
  benchmark: () => {
    const samples = ["https://doubleclick.net/ad.js", "https://www.google-analytics.com/analytics.js", "https://example.com/app.js", "https://cdn.example.com/lib.js", "https://connect.facebook.net/en_US/fbevents.js"];
    const start = performance.now();
    let blocked = 0;
    for (let i = 0; i < 25000; i++) {
      const url = samples[i % samples.length];
      if (engine.match({ url, requestHost: new URL(url).hostname, pageHost: "example.org", type: "script" }).block) blocked++;
    }
    return { ms: Math.round(performance.now() - start), checks: 25000, blocked };
  },
};

browser.runtime.onMessage.addListener((message, sender) => {
  // Settings-changing messages are only accepted from PrivaBlock's own pages.
  const fromExtensionPage = sender.url?.startsWith(browser.runtime.getURL(""));
  const contentAllowed = ["getCosmetic", "getGeneric", "recordCosmetic", "pickerCreate"].includes(message?.type);
  const handler = handlers[message?.type];
  if (!handler || (!fromExtensionPage && !contentAllowed)) return undefined;
  return Promise.resolve(handler(message, sender));
});

// ------------------------------------------------------------------ element picker & shortcuts

async function startPicker(tab) {
  if (!tab || !siteForUrl(tab.url) || siteDisabled(hostOf(tab.url))) return { ok: false };
  await browser.tabs.executeScript(tab.id, { file: "/content/picker.js", frameId: 0 });
  return { ok: true };
}

async function toggleSite(tab) {
  const site = siteForUrl(tab?.url);
  if (!site) return;
  await handlers.setSiteEnabled({ site, enabled: siteDisabled(site), tabId: tab.id });
}

// No commands on Firefox for Android.
browser.commands?.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (command === "pick-element") startPicker(tab).catch(() => {});
  if (command === "toggle-site") toggleSite(tab).catch(() => {});
});

// ------------------------------------------------------------------ start-up

browser.alarms.create("refresh-lists", { periodInMinutes: 360 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh-lists") rebuild(false).catch(() => {});
});

async function init() {
  const migration = await migrate(browser.storage.local);
  if (migration.resetFingerprint) await browser.privacy.websites.resistFingerprinting.clear({}).catch(() => {});
  state.settings = await loadSettings(browser.storage.local);
  const stats = await browser.storage.local.get(["day", "dailyBlocked"]);
  if (stats.day === state.day) state.dailyBlocked = Number(stats.dailyBlocked) || 0;
  await rebuild(false, true);
}

started = Promise.race([init(), new Promise((r) => setTimeout(r, STARTUP_HOLD_MS))])
  .catch((error) => console.error("PrivaBlock start-up failed", error))
  .finally(() => {
    started = null;
    // Lists that were too old to wait for are downloaded now.
    if (Object.values(state.lists).some((l) => l.updated && Date.now() - l.updated >= REFRESH_AFTER_MS)) rebuild(false).catch(() => {});
  });
