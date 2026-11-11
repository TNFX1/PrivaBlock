// Filter list catalogue and protection profiles (shared by both browsers and the build).
// trusted: uBlock Origin's own lists. As in uBO, only they may use filters that change what a page
// receives or runs (trusted-* scriptlets, replace-node-text, $replace=); never custom lists or My filters.
export const LISTS = {
  ublock: { trusted: true, group: "core", name: "uBlock filters – Ads", url: "https://ublockorigin.github.io/uAssets/filters/filters.txt" },
  ublockQuick: { trusted: true, group: "core", name: "uBlock filters – Quick fixes", url: "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt" },
  ublockUnbreak: { trusted: true, group: "compatibility", name: "uBlock filters – Unbreak", url: "https://ublockorigin.github.io/uAssets/filters/unbreak.txt" },
  easylist: { group: "ads", name: "EasyList", url: "https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt" },
  adguard: { group: "ads", name: "AdGuard – Ads", url: "https://filters.adtidy.org/extension/ublock/filters/2.txt" },
  hagezi: { group: "adsPrivacy", name: "HaGeZi Multi PRO", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt" },
  hageziPlus: { group: "adsPrivacy", name: "HaGeZi Multi PRO++", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt" },
  easyprivacy: { group: "privacy", name: "EasyPrivacy", url: "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt" },
  ublockPrivacy: { trusted: true, group: "privacy", name: "uBlock filters – Privacy", url: "https://ublockorigin.github.io/uAssets/filters/privacy.txt" },
  adguardPrivacy: { group: "privacy", name: "AdGuard – Tracking Protection", url: "https://filters.adtidy.org/extension/ublock/filters/3.txt" },
  easyAnnoyances: { group: "annoyances", name: "EasyList – Annoyances", url: "https://ublockorigin.github.io/uAssets/thirdparties/easylist-annoyances.txt" },
  easyCookie: { group: "annoyances", name: "EasyList – Cookie Notices", url: "https://ublockorigin.github.io/uAssets/thirdparties/easylist-cookies.txt" },
  antiAdblock: { group: "annoyances", name: "Adblock Warning Removal List", url: "https://easylist-downloads.adblockplus.org/antiadblockfilters.txt" },
};

export const GROUPS = ["core", "ads", "adsPrivacy", "privacy", "compatibility", "annoyances"];

const BASE = ["ublock", "ublockQuick", "ublockUnbreak", "easylist", "easyprivacy"];
export const PROFILES = {
  light: BASE,
  balanced: [...BASE, "hagezi", "ublockPrivacy", "antiAdblock"],
  strict: [...BASE, "hagezi", "hageziPlus", "ublockPrivacy", "adguard", "adguardPrivacy", "easyAnnoyances", "easyCookie", "antiAdblock"],
};
export const DEFAULT_PROFILE = "balanced";

/** Enabled list ids: explicit per-list choices win over the profile. */
export function enabledLists(profile, overrides = {}) {
  const base = new Set(PROFILES[profile] || PROFILES[DEFAULT_PROFILE]);
  for (const [id, on] of Object.entries(overrides)) {
    if (!(id in LISTS)) continue;
    if (on) base.add(id);
    else base.delete(id);
  }
  return Object.keys(LISTS).filter((id) => base.has(id));
}
