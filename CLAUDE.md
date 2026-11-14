# PrivaBlock

Ad and tracker blocker for Firefox and Chromium browsers (MPL-2.0). Current release: 3.1.2 (tag `v3.1.2`, GitHub release with both zips; Firefox build on AMO). Changes are listed in `docs/CHANGELOG.md`.

## Layout

- `src/core/`: shared engine (filter parser, matcher, public suffix list, list catalog, DNR conversion, settings)
- `src/firefox/`: MV2, blocking `webRequest`, persistent background page
- `src/chromium/`: MV3, declarativeNetRequest. Lists are compiled into static rulesets at build time. User filters, custom lists and per-site disable become dynamic rules.
- `src/content/`: cosmetic filtering (`content.js`), procedural filters (`procedural.js`, same isolated world), scriptlets (`scriptlets-main.js`, world MAIN; the calls reach it through a `data-privablock-sl` attribute + event from the isolated-world handoff in `src/core/scriptlets.js`), element picker (`picker.js`, injected on demand; the background builds the `host##selector` rule from the sender's URL).
- Scriptlet delivery: Firefox registers handoff code per shard of hosts with `contentScripts.register`; Chromium registers `scriptlets/<list>-<n>.js` (built by `tools/build.mjs`) with `scripting.registerContentScripts`. Chromium user filters/custom lists send their scriptlets with the `getCosmetic` reply (late). Only names in `src/core/scriptlets.js` are parsed; `trusted-*` is never.
- `src/ui/`: popup, settings and logger pages. The popup is a blue field with the page's blocked count and a row of white quills (one per blocked request, at most 23), then (Firefox only) today's total. Ads and trackers are not shown separately. On Chromium the toolbar number is the browser's automatic action count. Settings is a page with a sidebar (Protection, Lists, My filters, Sites, About), one section shown at a time by URL hash. English and Turkish (`src/_locales`), same look as PrivaVault (IBM Plex, light and dark themes).
- `src/icons/`: `icon.svg` is the source of truth. The PNGs (16/32/48/96/128 px, plus unused `-off` variants) are rendered from it with `rsvg-convert`.
- `tools/build.mjs`: builds `dist/firefox` and `dist/chromium`. It makes zips only if `zip` is installed; CI makes them.
- Design spec: `docs/superpowers/specs/2026-11-08-privablock-3-design.md`

## Commands

- `npm test`: unit tests (node:test)
- `npm run build`: build both browsers into `dist/`
- `node tests/browser/firefox-smoke.mjs`: headless Firefox over WebDriver BiDi (needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`)
- `node tests/browser/chromium-smoke.mjs`: Chromium over CDP. For blocking measurements use Playwright's Chromium (`~/.cache/ms-playwright/`): Helium bundles uBO, which skews counts.
- `node tools/build.mjs --offline`: build from the cached lists when `filters.adtidy.org` is flaky
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

- Releases: bump `version` in `package.json` (the manifests say 0.0.0; the build fills it in), add a `docs/CHANGELOG.md` entry, push a `v*` tag; CI creates the GitHub release with both zips. AMO refuses a version number it has seen before, so never reuse one.
- Weekly CI run (Monday 04:00 UTC, or a manual run on `main`): rebuilds Chromium with fresh lists and publishes a `lists-<version>.<YYDDD>` release with only the Chromium zip, not marked latest. Firefox fetches lists itself. CI also runs both smoke tests (Chrome for Testing via `browser-actions/setup-chrome`).
- Chrome Web Store: not published yet, needs the owner's developer account. Check its AI-content policy before submitting.
- The popup's live count on Chromium also counts requests blocked by other blockers, so it can be higher than the toolbar number.
- Chromium: clearing the toolbar count when a site is switched off from Settings > Sites has not been checked by eye.
