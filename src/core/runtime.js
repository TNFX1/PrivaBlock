// Settings, 2.x migration and list downloads shared by the Firefox and Chromium backgrounds.
// `storage` is browser.storage.local / chrome.storage.local (promise-based in both).
import { LISTS, PROFILES, DEFAULT_PROFILE } from "./lists.js";
import { normalizeHost, siteOf } from "./psl.js";

export const DATA_VERSION = 3;

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function loadSettings(storage) {
  const s = await storage.get(["profile", "listOverrides", "customLists", "myFilters", "fingerprint", "disabledSites"]);
  return {
    profile: PROFILES[s.profile] ? s.profile : DEFAULT_PROFILE,
    listOverrides: s.listOverrides || {},
    customLists: s.customLists || {},
    myFilters: String(s.myFilters || ""),
    fingerprint: s.fingerprint === true,
    disabledSites: (s.disabledSites || []).map(normalizeHost).filter(Boolean),
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
