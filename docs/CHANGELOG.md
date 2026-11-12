# Changelog

## 3.1.2 — 2026-11-11

(3.1.1 was never released: the number had already been used on AMO.)

### Blocking
- Generic element hiding (`##.ad`), looked up from the classes and ids a page has, with
  `@@$generichide`, `$elemhide` and `$specifichide`.
- `$popup`: tabs a page opens to blocked addresses are closed.
- `$redirect` / `$redirect-rule` to PrivaBlock's own stand-in resources (empty files, silent media,
  Google IMA, GPT, GTM, Analytics, AdSense, apstag and more). On Chromium only `$redirect` is supported.
- `$badfilter` across lists.
- Adblock Warning Removal List against "turn off your ad blocker" walls, plus the `nobab`, `nofab` and
  `popads-dummy` scriptlets.

### Scriptlets
- Closer to uBlock Origin: wrapped functions still look native, XHR edits go through a subclass, legacy
  JSONPath rules behave as in uBO, `replace-node-text` patterns match uBO's.

### Fixes
- Firefox: at start-up, web requests wait until the lists and scriptlets are in place (at most 15 s);
  scriptlet sets are replaced without a gap.
- Chromium: requests answered with a stand-in resource count as blocked.

## 3.1.0 — 2026-11-11

- Scriptlets (`##+js(…)`) run inside the page: PrivaBlock's own implementation of the common uBO
  scriptlets, including `json-prune` / `json-edit` on fetch and XHR responses.
- Trusted-only filters, accepted only from uBlock Origin's own lists: `trusted-*` scriptlets,
  `replace-node-text` and `$replace=` (Firefox). Together they keep video ads off YouTube.
- Procedural cosmetic filters (`:has-text`, `:upward`, `:remove`, `:style`…).
- Element picker (popup or <kbd>Alt+Shift+H</kbd>) and a keyboard shortcut to switch a site off.
- Back up and restore settings, lists and filters (Settings > About).
- Firefox for Android.
- Chromium: a site switched off from Settings clears its toolbar count.
- The build falls back to the cached copy when a list download fails.

## 3.0.0 — 2026-11-10

A rewrite: one code base, two builds.

- **Firefox** keeps blocking `webRequest` (Manifest V2). **Chromium** browsers (Manifest V3) get the
  lists compiled to `declarativeNetRequest` rule sets at build time; your filters, custom lists and
  per-site switches become dynamic rules.
- New popup: the page's blocked count with a row of quills, one per blocked request. New settings page
  with a sidebar (Protection, Lists, My filters, Sites, About) and a "Show count on the icon" switch.
  New logger. English and Turkish, light and dark themes.
- New logo.
- Chromium: the blocked count is counted live per tab; the toolbar shows the browser's own count.
- Fixes from 2.x: lists now refresh daily; cosmetic rules are fetched once per frame instead of on every
  page change; statistics are written every 5 s instead of per request; first/third party uses the Public
  Suffix List (`.com.tr`, `.co.uk`); host exclusions in cosmetic rules work; regex filters are skipped
  instead of misapplied; mislabelled HaGeZi lists corrected.
- Fingerprinting protection (Firefox) is opt-in and no longer turned back on by itself.
- Firefox: setting changes apply before the popup or settings page re-renders, and a change made during
  a list rebuild is no longer dropped.
- 2.x settings are migrated.
