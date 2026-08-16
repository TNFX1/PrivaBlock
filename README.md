<div align="center">

<img src="icons/icon.png" width="128" alt="PrivaBlock logo">

# PrivaBlock

**Private browsing. Cleaner web.**

A privacy-focused ad, tracker, and fingerprinting protection extension for Firefox.

[![Firefox](https://img.shields.io/badge/Firefox-WebExtension-orange?logo=firefox)](https://www.mozilla.org/firefox/)
[![License](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[GitHub](https://github.com/PrivaApp/PrivaBlock) · [Issues](https://github.com/PrivaApp/PrivaBlock/issues)

</div>

---

## Overview

PrivaBlock is an open-source privacy extension for Firefox designed to reduce unwanted advertising, tracking, and fingerprinting while keeping browsing fast and under the user's control.

It combines network-level filtering with cosmetic filtering and user-configurable rules.

> **Privacy should be the default, not a premium feature.**

## Features

- Ad blocking
- Tracker blocking
- Cosmetic filtering
- Fingerprinting protection
- Per-site protection controls
- Custom filter rules
- Custom filter lists
- Light, Balanced, and Strict filtering profiles
- Filter-list management
- Built-in request logger
- Per-page blocking statistics
- Daily blocking statistics
- Filter caching and optimization
- Site-specific protection settings

## Filtering

PrivaBlock supports compatible filtering syntax used by widely adopted ad-blocking lists.

Depending on the selected configuration, lists may include:

- EasyList
- EasyPrivacy
- uBlock-compatible lists
- AdGuard filtering lists
- HaGeZi lists
- Peter Lowe's list
- User-defined lists

Available lists and their default states can change between releases.

## Filtering Profiles

### Light

A smaller ruleset designed for lower filtering overhead.

Recommended when compatibility and performance are the priority.

### Balanced

The default profile.

Designed to balance blocking coverage, privacy, compatibility, and performance.

### Strict

A more aggressive filtering configuration.

Strict mode can increase memory/CPU usage and may cause more website compatibility issues.

For most users, **Balanced** is recommended.

## Custom Filters

Users can add their own filtering rules.

Examples:

```text
||ads.example.com^
example.com##.advertisement
@@||trusted.example.com^
```

Custom filter lists can also be added through the settings interface.

## Per-Site Protection

Protection can be disabled for an individual website without disabling PrivaBlock globally.

For example:

```text
youtube.com     Protection disabled
github.com      Protection enabled
example.com     Protection enabled
```

The setting is stored locally in Firefox.

## Fingerprinting Protection

PrivaBlock includes fingerprinting protection intended to reduce browser fingerprinting surfaces.

Where possible, PrivaBlock relies on Firefox's own privacy mechanisms instead of attempting fragile browser-identity spoofing.

Some privacy protections may affect website compatibility.

## Logger

PrivaBlock includes a request logger for debugging and transparency.

The logger can display information such as:

- Blocked requests
- Allowed requests
- Request type
- First-party / third-party status
- Matching filter
- Filter source
- Request URL

The logger is intended to help users understand why a request was blocked or allowed.

## Privacy

PrivaBlock does not require an account and does not include advertising, analytics, or user profiling.

Blocking statistics and configuration are stored locally in Firefox.

Filter lists may be downloaded from their configured third-party sources. Those requests are made to the respective list providers and are subject to their own network and privacy policies.

See [PRIVACY.md](PRIVACY.md) for details.

## Performance

PrivaBlock is designed to avoid reparsing filter lists for every network request.

Filter data is cached and indexed locally to reduce unnecessary processing during normal browsing.

Enabling a very large number of filter lists can increase memory and CPU usage and can also increase the chance of website compatibility issues.

## Installation

### Temporary installation

1. Clone the repository.
2. Open Firefox.
3. Navigate to `about:debugging#/runtime/this-firefox`.
4. Select **Load Temporary Add-on**.
5. Select `manifest.json`.

### Firefox Add-ons

A signed Firefox release can be distributed through Mozilla Add-ons once the project is ready for public release.

## Development

Clone the repository:

```bash
git clone https://github.com/PrivaApp/PrivaBlock.git
cd PrivaBlock
```

PrivaBlock is developed as a Firefox WebExtension.

The project intentionally keeps its source code reviewable and self-contained.

## Project Structure

```text
PrivaBlock/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.js
├── popup.css
├── settings.html
├── settings.js
├── settings.css
├── icons/
├── README.md
├── LICENSE
└── PRIVACY.md
```

## Compatibility

PrivaBlock is currently developed for Firefox.

Browser behavior, filter syntax support, and website compatibility may change as the project evolves.

## Contributing

Contributions, bug reports, and suggestions are welcome.

Before opening an issue:

1. Make sure you are using the latest version.
2. Check whether the issue is reproducible with the **Balanced** profile.
3. Check the built-in logger when reporting filtering problems.
4. Include the affected website and relevant filter information.
5. Do not include private browsing data or personal information in bug reports.

## Disclaimer

PrivaBlock is an independent open-source project.

It is not affiliated with or endorsed by Mozilla, uBlock Origin, EasyList, EasyPrivacy, AdGuard, HaGeZi, or Peter Lowe.

PrivaBlock may use or support third-party filter lists whose licenses and terms remain the responsibility of their respective authors.

## License

PrivaBlock is licensed under the Mozilla Public License 2.0.

See [LICENSE](LICENSE).

---

<div align="center">

**Made by [PrivaApp](https://github.com/PrivaApp)**

</div>
