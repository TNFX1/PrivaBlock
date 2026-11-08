// PrivaBlock for Chromium (MV3 service worker). Bundled lists are static DNR rulesets built by
// tools/build.mjs; user filters, custom lists and per-site switches are dynamic rules.
import { Engine } from "../core/engine.js";
import { parseList } from "../core/filters.js";
import { LISTS, PROFILES, enabledLists } from "../core/lists.js";
import { listToRules, siteDisabledRule } from "../core/dnr.js";
import { normalizeHost } from "../core/psl.js";
import { loadSettings, migrate, fetchList, siteForUrl } from "../core/runtime.js";

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
  cosmetic = null;
}

// ------------------------------------------------------------------ cosmetic filtering

async function cosmeticEngine() {
  cosmetic ??= (async () => {
    const settings = await loadSettings(chrome.storage.local);
    const engine = new Engine();
    for (const id of enabledLists(settings.profile, settings.listOverrides)) {
      try {
        const data = await (await fetch(chrome.runtime.getURL(`cosmetic/${id}.json`))).json();
        engine.addCosmetic(data.cosmetic, data.exceptions);
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
  await applyAll(false);
  return { ok: true };
}

const handlers = {
  getCapabilities: () => ({ browser: "chromium", fingerprint: false, dailyStats: false, fullLogger: false, benchmark: false, bundledLists: true }),

  async getStats() {
    const tab = await activeTab();
    const site = siteForUrl(tab?.url);
    const settings = await loadSettings(chrome.storage.local);
    // With declarativeNetRequestFeedback the badge holds Chromium's own blocked count, quota-free.
    const badge = tab ? await chrome.action.getBadgeText({ tabId: tab.id }).catch(() => "") : "";
    return {
      site, tabId: tab?.id, web: !!site,
      siteDisabled: !!site && settings.disabledSites.includes(site),
      pageBlocked: Number.parseInt(badge, 10) || 0,
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
  async setSiteEnabled({ site, enabled, tabId }) {
    site = normalizeHost(site);
    if (!site) return { ok: false };
    const settings = await loadSettings(chrome.storage.local);
    const sites = new Set(settings.disabledSites);
    if (enabled) sites.delete(site);
    else sites.add(site);
    await updateSetting({ disabledSites: [...sites] });
    if (Number.isInteger(tabId)) chrome.tabs.reload(tabId).catch(() => {});
    return { ok: true };
  },
  async openLogger() {
    const tab = await activeTab();
    if (!tab) return { ok: false };
    await chrome.tabs.create({ url: chrome.runtime.getURL(`ui/logger.html?tabId=${tab.id}`) });
    return { ok: true };
  },
  async getMatched({ tabId }) {
    const { rulesMatchedInfo } = await dnr.getMatchedRules({ tabId: Number(tabId) });
    return rulesMatchedInfo.map((m) => ({
      time: m.timeStamp, action: "block", ruleId: m.rule.ruleId,
      source: m.rule.rulesetId === dnr.DYNAMIC_RULESET_ID ? "user" : m.rule.rulesetId,
    }));
  },
  recordCosmetic: () => ({ ok: true }), // the badge counts network blocks only on Chromium
  async getCosmetic({ host }) {
    const h = normalizeHost(host);
    const { engine, disabledSites } = await cosmeticEngine();
    if (!h || disabledSites.some((d) => h === d || h.endsWith(`.${d}`))) return { enabled: false, selectors: [] };
    return { enabled: true, selectors: engine.cosmeticFor(h) };
  },
};

let ruleTotals = null;
async function bundledCounts() {
  ruleTotals ??= fetch(chrome.runtime.getURL("rulesets/counts.json")).then((r) => r.json()).catch(() => ({}));
  return ruleTotals;
}
async function enabledRuleCount(settings) {
  const counts = await bundledCounts();
  const { dynamicStatus = {} } = await chrome.storage.local.get("dynamicStatus");
  return enabledLists(settings.profile, settings.listOverrides).reduce((n, id) => n + (counts[id]?.rules || 0), 0) + (dynamicStatus.count || 0);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  const contentAllowed = message?.type === "getCosmetic" || message?.type === "recordCosmetic";
  const handler = handlers[message?.type];
  if (!handler || (!fromExtensionPage && !contentAllowed)) return false;
  Promise.resolve(handler(message, sender)).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true; // async response
});

// ------------------------------------------------------------------ lifecycle

chrome.runtime.onInstalled.addListener(async () => {
  await migrate(chrome.storage.local);
  await chrome.action.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  await chrome.action.setBadgeBackgroundColor({ color: "#2f5bea" });
  await applyAll(false);
  chrome.alarms.create("refresh-lists", { periodInMinutes: 360 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh-lists") applyAll(false).catch(() => {});
});
