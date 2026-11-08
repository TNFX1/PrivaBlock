# PrivaBlock 3.0 — cross-browser rework (design)

Date: 2026-11-08. Status: approved by the owner ("do it the way you think is best").

## Goals
1. Fix the defects found in the 2.1.0 review (below).
2. Ship for Firefox **and** Chromium browsers (Chrome, Brave, Edge, Helium…) from one code base.
3. Rework the UI: English + Turkish, light/dark following the system, PrivaVault's visual language.

Non-goals: store publishing, new blocking features (scriptlets, procedural cosmetics, redirects),
generic cosmetic rules (`##.ad` without a host — dropped today too, kept out for performance).

## Decisions
| Topic | Decision | Why |
| --- | --- | --- |
| Chromium engine | MV3 `declarativeNetRequest`: filter lists converted to **static rulesets at build time**; user filters and custom lists as **dynamic rules** (30k cap, warned) | Chrome has no blocking webRequest; dynamic rules alone (30k) can't hold the lists. Same model as uBlock Origin Lite. Lists refresh with extension updates. |
| Firefox engine | Keep MV2 + blocking `webRequest` (today's engine, fixed) | More capable (per-request decisions, logger shows the matching filter); MV2 background is persistent, so the 100k+-filter index isn't rebuilt on every wake. |
| Fingerprinting | Off by default, opt-in toggle with a compatibility warning; never re-forced at startup; the empty "Strict" toggle is removed; hidden on Chromium | `resistFingerprinting` breaks sites (UTC, no dark mode) and the user's own browser setting must win. |
| Domain parties | Public Suffix List compiled into `src/core/psl-data.js` | `bbc.co.uk` vs `gov.co.uk`, `.com.tr` must be distinct sites for `$third-party`. |
| Chromium logger/stats | `declarativeNetRequestFeedback`: per-page count + logger of blocked requests with the list that matched; badge = Chrome's action count; no "blocked today" | MV3 exposes no allowed-request stream and no cheap daily total. |

## Defects fixed
1. Lists never refreshed automatically (cache used forever unless forced) → Firefox: `alarms` every 6 h, refresh lists older than 24 h; Chromium: custom lists likewise.
2. Content script re-requested and re-applied all cosmetic rules on every DOM mutation → rules fetched once per frame; the injected stylesheet covers later nodes, so there is no DOM observer at all. (Its built-in YouTube CSS never applied in 2.x: a trailing comma invalidated the whole rule.)
3. Storage write on every blocked request → stats persisted at most every 5 s.
4. Naive `baseDomain` → PSL (above).
5. Cosmetic host lists ignored `~exclusions` → honoured; `#@#` exceptions match per host.
6. Regex filters (`/…/`) were escaped into literal patterns → skipped explicitly (counted as unsupported).
8. HaGeZi lists were mislabelled ("NORMAL" was PRO, "PRO" was PRO++) → named after the files they load.
9. Bare host filters (`ads.example.com$image`) are host filters, as in uBlock Origin (keeps AdGuard Tracking Protection at ~10k DNR rules instead of 318k).
7. Stale `PrivaApp/PrivaBlock` links → `TNFX1/PrivaBlock`.

## Layout
```
src/core/        filters.js (parse), engine.js (match + cosmetic index), psl.js + psl-data.js, dnr.js (→ DNR rules), lists.js (catalogue + profiles)
src/firefox/     background.js, manifest.json (MV2)
src/chromium/    background.js (service worker, ES module), manifest.json (MV3)
src/content/     content.js (shared)
src/ui/          popup, settings, logger (HTML/CSS/JS), theme.css, fonts (IBM Plex Sans, OFL)
src/_locales/    en, tr
src/icons/
tools/build.mjs  → dist/firefox, dist/chromium (+ rulesets/ and cosmetic/ JSON), zips; --offline reuses downloaded lists
tools/update-psl.mjs
tests/*.test.mjs node:test
```
Browser API: `globalThis.browser ?? globalThis.chrome` (both promise-based for the APIs used).
Background message protocol stays the same for both browsers; the UI asks `getCapabilities` and hides what a browser can't do.

## DNR conversion
`||a.com^` without options → batched into `requestDomains` rules (1,000 domains each) — keeps HaGeZi-size lists small.
Other filters: `urlFilter` = ABP pattern (same syntax); types → `resourceTypes` / `excludedResourceTypes`; `$third-party`/`$first-party` → `domainType`; `domain=` → `initiatorDomains`/`excludedInitiatorDomains`; `to=` → `requestDomains`; `match-case` → `isUrlFilterCaseSensitive`.
Priorities: block 1, allow (`@@`) 2, `$important` block 3. Non-ASCII, regex and unsupported options are skipped and counted.

## Testing
Unit tests (node:test) for parsing, matching (incl. PSL parties, exceptions, `$important`, `~domain`), cosmetic lookup and DNR conversion.
Manual smoke test in Firefox and Helium (Chromium): ads blocked on a test page, popup count, per-site off, settings, both themes and languages.
CI: test + build both packages on every push; zips as artifacts.
