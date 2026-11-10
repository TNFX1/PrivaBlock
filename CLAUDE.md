# PrivaBlock

Ad and tracker blocker for Firefox and Chromium browsers (MPL-2.0). Version 3.0.0, `main` branch, no release tag yet.

## Layout

- `src/core/`: shared engine (filter parser, matcher, public suffix list, list catalog, DNR conversion, settings)
- `src/firefox/`: MV2, blocking `webRequest`, persistent background page
- `src/chromium/`: MV3, declarativeNetRequest. Lists are compiled into static rulesets at build time. User filters, custom lists and per-site disable become dynamic rules.
- `src/content/`: cosmetic filtering
- `src/ui/`: popup, settings and logger pages. The popup is a blue field with the page's blocked count and a row of white quills (one per blocked request, at most 23), then (Firefox only) today's total. Ads and trackers are not shown separately. On Chromium the toolbar number is the browser's automatic action count. Settings is a page with a sidebar (Protection, Lists, My filters, Sites, About), one section shown at a time by URL hash. English and Turkish (`src/_locales`), same look as PrivaVault (IBM Plex, light and dark themes).
- `src/icons/`: `icon.svg` is the source of truth. The PNGs (16/32/48/96/128 px, plus unused `-off` variants) are rendered from it with `rsvg-convert`.
- `tools/build.mjs`: builds `dist/firefox` and `dist/chromium`. It makes zips only if `zip` is installed; CI makes them.
- Design spec: `docs/superpowers/specs/2026-11-08-privablock-3-design.md`

## Commands

- `npm test`: unit tests (node:test)
- `npm run build`: build both browsers into `dist/`
- `node tests/browser/firefox-smoke.mjs`: headless Firefox over WebDriver BiDi (needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`)
- `node tests/browser/chromium-smoke.mjs`: Chromium (helium-browser) over CDP
- `npm run update-psl`: refresh the public suffix list

Requires Node 22 or newer.

## Decisions (made by the owner)

- On Chromium, follow the uBlock Origin Lite model (static DNR rulesets).
- Fingerprinting protection (Firefox resistFingerprinting) is opt-in and off by default.
- The UI is English and Turkish, with light and dark themes.

## Conventions

- No Claude or AI attribution in commits or PRs (no `Co-Authored-By: Claude`, no "Generated with Claude Code").
- Commit only when asked, and push only when asked.

## Open items

- Tag v3.0.0 (CI creates the GitHub release with both zips).
- Store publishing: Firefox needs AMO signing for a permanent install; Chrome Web Store. Check each store's AI-content policy before submitting.
