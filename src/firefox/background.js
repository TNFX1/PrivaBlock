// PrivaBlock for Firefox: blocking webRequest engine (MV2, persistent background page).
import { Engine } from "../core/engine.js";
import { parseList, RESOURCE_TYPES } from "../core/filters.js";
import { LISTS, PROFILES, enabledLists } from "../core/lists.js";
import { normalizeHost, sameSite, domainMatches } from "../core/psl.js";
import { loadSettings, migrate, today, fetchList, siteForUrl, listName } from "../core/runtime.js";

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

async function cachedOrFetched(id, url, force) {
  const key = `list:${id}`;
  const cached = (await browser.storage.local.get(key))[key];
  const fresh = cached && Date.now() - cached.updated < REFRESH_AFTER_MS;
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

/** Rebuild the engine from enabled lists. `force` re-downloads everything. */
function rebuild(force = false) {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    const s = state.settings;
    const next = new Engine();
    const lists = {};
    const sources = [
      ...enabledLists(s.profile, s.listOverrides).map((id) => ({ id, url: LISTS[id].url })),
      ...Object.values(s.customLists).filter((l) => l.enabled !== false).map((l) => ({ id: l.id, url: l.url })),
    ];
    for (const { id, url } of sources) {
      try {
        const got = await cachedOrFetched(id, url, force);
        const parsed = parseList(got.text, id);
        next.add(parsed);
        lists[id] = { ok: true, rules: parsed.network.length + parsed.hosts.length, cosmetic: parsed.cosmetic.length, updated: got.updated, source: got.source, error: got.error };
      } catch (error) {
        lists[id] = { ok: false, rules: 0, cosmetic: 0, error: String(error.message || error) };
      }
    }
    const mine = parseList(s.myFilters, "user");
    next.add(mine);
    lists.user = { ok: true, rules: mine.network.length + mine.hosts.length, cosmetic: mine.cosmetic.length };
    engine = next;
    state.lists = lists;
    state.ruleCount = next.stats.network + next.stats.hosts;
    state.cosmeticCount = next.stats.cosmetic;
    state.updated = Date.now();
  })().finally(() => {
    state.loading = null;
  });
  return state.loading;
}

// ------------------------------------------------------------------ blocking

const TYPE_FROM_FIREFOX = { main_frame: "document", sub_frame: "subdocument", beacon: "ping", imageset: "image", xslt: "other", xml_dtd: "other", web_manifest: "other", speculative: "other" };

function siteDisabled(pageHost) {
  return state.settings.disabledSites.some((d) => domainMatches(pageHost, d));
}

function onBeforeRequest(d) {
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
  if (!block) return {};
  countBlocked(d.tabId, 1);
  return { cancel: true };
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, ["blocking"]);

// ------------------------------------------------------------------ stats & badge

function countBlocked(tabId, n) {
  if (!Number.isInteger(tabId) || tabId < 0 || n < 1) return;
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

function updateBadge(tabId) {
  const n = state.tabCounts.get(tabId) || 0;
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
  await browser.storage.local.set({ fingerprint: !!enabled });
  // Off = give the user's own Firefox setting back, never force it to false.
  if (enabled) await browser.privacy.websites.resistFingerprinting.set({ value: true });
  else await browser.privacy.websites.resistFingerprinting.clear({});
}

// ------------------------------------------------------------------ messages

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const handlers = {
  getCapabilities: () => ({ browser: "firefox", fingerprint: true, dailyStats: true, fullLogger: true, benchmark: true, bundledLists: false }),

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
    await browser.storage.local.set({ profile, listOverrides: {} });
    return { ok: true };
  },
  async setList({ id, enabled }) {
    if (!LISTS[id]) return { ok: false };
    await browser.storage.local.set({ listOverrides: { ...state.settings.listOverrides, [id]: !!enabled } });
    return { ok: true };
  },
  async updateFilters() {
    await rebuild(true);
    return { ok: true, ruleCount: state.ruleCount };
  },
  async addCustomList({ name, url }) {
    if (!/^https?:\/\//i.test(String(url))) return { ok: false };
    const id = `custom_${Date.now().toString(36)}`;
    await browser.storage.local.set({ customLists: { ...state.settings.customLists, [id]: { id, name: String(name).slice(0, 80), url: String(url), enabled: true } } });
    return { ok: true };
  },
  async removeCustomList({ id }) {
    const customLists = { ...state.settings.customLists };
    delete customLists[id];
    await browser.storage.local.remove(`list:${id}`);
    await browser.storage.local.set({ customLists });
    return { ok: true };
  },
  async toggleCustomList({ id, enabled }) {
    const list = state.settings.customLists[id];
    if (!list) return { ok: false };
    await browser.storage.local.set({ customLists: { ...state.settings.customLists, [id]: { ...list, enabled: !!enabled } } });
    return { ok: true };
  },
  async saveMyFilters({ text }) {
    await browser.storage.local.set({ myFilters: String(text || "") });
    return { ok: true };
  },
  async setFingerprint({ enabled }) {
    await setFingerprint(enabled);
    return { ok: true };
  },
  async setSiteEnabled({ site, enabled, tabId }) {
    site = normalizeHost(site);
    if (!site) return { ok: false };
    const sites = new Set(state.settings.disabledSites);
    if (enabled) sites.delete(site);
    else sites.add(site);
    await browser.storage.local.set({ disabledSites: [...sites] });
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
    return { enabled: true, selectors: engine.cosmeticFor(h) };
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
  const contentAllowed = message?.type === "getCosmetic" || message?.type === "recordCosmetic";
  const handler = handlers[message?.type];
  if (!handler || (!fromExtensionPage && !contentAllowed)) return undefined;
  return Promise.resolve(handler(message, sender));
});

// ------------------------------------------------------------------ settings changes & start-up

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  const relevant = ["profile", "listOverrides", "customLists", "myFilters", "disabledSites", "fingerprint"];
  if (!relevant.some((k) => k in changes)) return;
  state.settings = await loadSettings(browser.storage.local);
  if (["profile", "listOverrides", "customLists", "myFilters"].some((k) => k in changes)) rebuild(false).catch(() => {});
});

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
  await rebuild(false);
}

init().catch((error) => console.error("PrivaBlock start-up failed", error));
