<div align="center">

<img src="src/icons/icon.svg" width="120" alt="PrivaBlock">

# PrivaBlock

**Blocks ads and trackers in Firefox and Chromium browsers. No account, no analytics.**

[![Build](https://github.com/TNFX1/PrivaBlock/actions/workflows/build.yml/badge.svg)](https://github.com/TNFX1/PrivaBlock/actions/workflows/build.yml)
[![License](https://img.shields.io/badge/license-MPL--2.0-2f5bea)](LICENSE)

[Install](#install) · [How it works](#how-it-works) · [Privacy](#privacy) · [Build](#build) · [Türkçe](#türkçe)

</div>

## What it does

- **Blocks ads and trackers** with well-known filter lists: uBlock filters, EasyList, EasyPrivacy, HaGeZi, AdGuard.
- **Hides leftover ad boxes** on pages (element hiding), including YouTube's ad slots.
- **Three profiles**: Light, Balanced (default) and Strict, or pick lists one by one.
- **Your own rules** in Adblock syntax, and any public filter list by URL.
- **Turn it off per site** from the toolbar button.
- **Logger** that shows what was blocked on a tab and which list blocked it.
- English and Turkish; light and dark theme follow your system.

## Install

Store listings are not published yet. Until then, download the zip for your browser from
[Releases](https://github.com/TNFX1/PrivaBlock/releases).

| Browser | How |
| --- | --- |
| Chrome, Brave, Edge, Vivaldi, Helium… | Unzip `privablock-chromium-*.zip`, open `chrome://extensions`, turn on *Developer mode*, *Load unpacked*, pick the folder. |
| Firefox | Firefox only installs signed add-ons permanently. For testing: `about:debugging` → *This Firefox* → *Load Temporary Add-on* → pick `manifest.json` from the unzipped `privablock-firefox-*.zip` (removed when Firefox restarts). |

## How it works

PrivaBlock works differently in the two browser families, because they give extensions different tools.

| | Firefox | Chromium |
| --- | --- | --- |
| Engine | Every request is checked by PrivaBlock (blocking `webRequest`, Manifest V2) | The browser applies rule sets compiled from the lists (`declarativeNetRequest`, Manifest V3) |
| Filter lists | Downloaded from their publishers, refreshed daily | Built into the extension, refreshed with each PrivaBlock release (rebuilt weekly) |
| Your filters & custom lists | Unlimited | Up to the browser's 30,000-rule limit (you're told when it's reached) |
| Logger | Every request, allowed or blocked, with the matching filter | Blocked requests and the list that blocked them (Chromium doesn't report the address) |
| Fingerprinting protection | Optional: turns on Firefox's own *resist fingerprinting* (off by default) | — |

Supported filter syntax: network filters (`||example.com^`, `$third-party`, `$domain=`, resource types,
`$important`, `@@` exceptions), hosts files, and site-specific element hiding (`example.com##.ad`).
Scriptlets, redirects, regex filters, procedural cosmetics and generic hiding rules are skipped.

## Privacy

PrivaBlock has no servers and collects nothing. Settings, statistics and the logger stay in your browser.
The only network requests it makes are downloads of the filter lists you enabled, sent straight to their
publishers (on Chromium only for your custom lists). See [PRIVACY.md](PRIVACY.md).

## Build

Needs Node.js 22 or newer. No dependencies.

```bash
npm test                    # unit tests: parsing, matching, Public Suffix List, rule conversion
npm run build               # dist/firefox and dist/chromium (+ zips when `zip` is installed)
node tools/build.mjs --offline chromium    # rebuild from the lists already downloaded to .cache/
node tests/browser/firefox-smoke.mjs       # real Firefox (headless): blocking, hiding, site switch
node tests/browser/chromium-smoke.mjs --browser chromium   # same in a Chromium browser
```

```
src/core/       filter parsing, matching, Public Suffix List, DNR conversion (no browser APIs)
src/firefox/    Firefox background (MV2) and manifest
src/chromium/   Chromium service worker (MV3) and manifest
src/content/    element hiding, shared
src/ui/         popup, settings, logger
src/_locales/   en, tr
```

## Türkçe

PrivaBlock, Firefox ve Chromium tabanlı tarayıcılarda (Chrome, Brave, Edge, Helium…) reklamları ve
izleyicileri engeller. Hesap, sunucu ve analitik yoktur; ayarlar ve istatistikler tarayıcınızda kalır.

- uBlock, EasyList, EasyPrivacy, HaGeZi ve AdGuard listeleri; Hafif, Dengeli ve Sıkı profiller
- Sayfadaki boş reklam kutularını gizleme (YouTube dahil)
- Kendi kurallarınız ve URL ile eklenen özel listeler
- Araç çubuğu düğmesinden site bazında kapatma
- Neyin engellendiğini gösteren kayıt defteri
- Türkçe ve İngilizce arayüz, sisteme uyan açık/koyu tema

Kurulum için yukarıdaki [Install](#install) tablosuna bakın.

## License

[MPL-2.0](LICENSE). The bundled IBM Plex Sans font is under the SIL Open Font License
([src/ui/fonts/LICENSE-OFL.txt](src/ui/fonts/LICENSE-OFL.txt)). Filter lists belong to their authors and
keep their own licenses.
