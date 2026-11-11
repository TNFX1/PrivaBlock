// Settings, 2.x migration and list downloads shared by the Firefox and Chromium backgrounds.
// `storage` is browser.storage.local / chrome.storage.local (promise-based in both).
import { LISTS, PROFILES, DEFAULT_PROFILE } from "./lists.js";
import { normalizeHost, siteOf } from "./psl.js";
import { parseCosmeticFilter } from "./filters.js";

export const DATA_VERSION = 3;

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function loadSettings(storage) {
  const s = await storage.get(["profile", "listOverrides", "customLists", "myFilters", "fingerprint", "disabledSites", "showBadge"]);
  return {
    profile: PROFILES[s.profile] ? s.profile : DEFAULT_PROFILE,
    listOverrides: s.listOverrides || {},
    customLists: s.customLists || {},
    myFilters: String(s.myFilters || ""),
    fingerprint: s.fingerprint === true,
    disabledSites: (s.disabledSites || []).map(normalizeHost).filter(Boolean),
    showBadge: s.showBadge !== false,
  };
}

/**
 * Bring 2.x storage to the 3.0 layout once. 2.x forced Firefox's resistFingerprinting on and kept
 * every list in one huge `cachedLists` object; both are undone here.
 * Returns { resetFingerprint } so the Firefox background can hand the browser setting back.
 */
export async function migrate(storage) {
  const s = await storage.get(["dataVersion", "filterSettings", "cachedLists", "whitelist", "disabledSites", "fingerprint", "strictFingerprint", "enabled"]);
  if (s.dataVersion >= DATA_VERSION) return { resetFingerprint: false };
  const wasForced = s.dataVersion === undefined && s.fingerprint !== false && ("filterSettings" in s || "cachedLists" in s);
  const disabledSites = [...new Set([...(s.disabledSites || []), ...(s.whitelist || [])].map(normalizeHost).filter(Boolean))];
  await storage.remove(["filterSettings", "cachedLists", "whitelist", "strictFingerprint", "enabled", "loadedLists", "filterCount", "cosmeticCount", "filterUpdated"]);
  await storage.set({ dataVersion: DATA_VERSION, disabledSites, fingerprint: false, listOverrides: {} });
  return { resetFingerprint: wasForced };
}

export async function fetchList(url) {
  const res = await fetch(url, { cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 10) throw new Error("empty list");
  return text;
}

/** The site (registrable domain) of a web page URL, or "" for non-web pages. */
export function siteForUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? siteOf(u.hostname) : "";
  } catch {
    return "";
  }
}

export function listName(id, settings) {
  if (!id) return "";
  return LISTS[id]?.name || settings?.customLists?.[id]?.name || id;
}

/** The `host##selector` rule the element picker saves for a page, or null when the selector isn't usable. */
export function pickerFilter(url, selector) {
  let host = "";
  try {
    const u = new URL(url);
    if (/^https?:$/.test(u.protocol)) host = normalizeHost(u.hostname);
  } catch {}
  const sel = String(selector || "").trim();
  if (!host || !sel || sel.length > 1000 || /[\r\n]/.test(sel) || sel.startsWith("+js(")) return null;
  const filter = `${host}##${sel}`;
  const rule = parseCosmeticFilter(filter, "user");
  return rule?.kind === "cosmetic" && !rule.procedural ? filter : null;
}

/** My filters with `filter` added at the end, unless it is already there. */
export function withFilter(myFilters, filter) {
  const lines = String(myFilters || "").split(/\r?\n/);
  if (lines.some((l) => l.trim() === filter)) return myFilters;
  return `${String(myFilters || "").replace(/\s+$/, "")}${myFilters?.trim() ? "\n" : ""}${filter}`;
}

export const BACKUP_KEYS = ["profile", "listOverrides", "customLists", "myFilters", "disabledSites", "showBadge", "fingerprint"];

/** A backup file's content for the current settings. */
export function backupOf(settings) {
  const out = { app: "PrivaBlock", backup: 1, exported: new Date().toISOString() };
  for (const k of BACKUP_KEYS) out[k] = settings[k];
  return out;
}

/**
 * Storage values from a backup file, checked one by one (it comes from a file the person picked, so
 * nothing is trusted); null when it is not a PrivaBlock backup.
 */
export function backupValues(data) {
  if (!data || typeof data !== "object" || data.app !== "PrivaBlock" || data.backup !== 1) return null;
  const out = {};
  if (PROFILES[data.profile]) out.profile = data.profile;
  if (data.listOverrides && typeof data.listOverrides === "object") {
    out.listOverrides = {};
    for (const [id, on] of Object.entries(data.listOverrides)) if (LISTS[id] && typeof on === "boolean") out.listOverrides[id] = on;
  }
  if (data.customLists && typeof data.customLists === "object") {
    out.customLists = {};
    for (const l of Object.values(data.customLists).slice(0, 50)) {
      if (!l || !/^custom_[a-z0-9]{1,20}$/.test(l.id) || !/^https?:\/\/\S+$/i.test(String(l.url))) continue;
      out.customLists[l.id] = { id: l.id, name: String(l.name || l.url).slice(0, 80), url: String(l.url).slice(0, 2000), enabled: l.enabled !== false };
    }
  }
  if (typeof data.myFilters === "string") out.myFilters = data.myFilters.slice(0, 1_000_000);
  if (Array.isArray(data.disabledSites)) out.disabledSites = [...new Set(data.disabledSites.map(normalizeHost).filter((h) => /^[a-z0-9.-]+$/.test(h)))];
  if (typeof data.showBadge === "boolean") out.showBadge = data.showBadge;
  if (typeof data.fingerprint === "boolean") out.fingerprint = data.fingerprint;
  return out;
}
