<div align="center">

<img src="icons/icon.png" width="140" alt="PrivaBlock">

# PrivaBlock

### Private browsing. Cleaner web.

A privacy-focused ad, tracker, and fingerprinting protection extension for Firefox.

<br>

[![Firefox](https://img.shields.io/badge/Firefox-WebExtension-orange?logo=firefox)](https://www.mozilla.org/firefox/)
[![License](https://img.shields.io/badge/License-MPL--2.0-blue)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-PrivaBlock-181717?logo=github)](https://github.com/PrivaApp/PrivaBlock)
[![Issues](https://img.shields.io/github/issues/PrivaApp/PrivaBlock)](https://github.com/PrivaApp/PrivaBlock/issues)

<br>

**[GitHub](https://github.com/PrivaApp/PrivaBlock) · [Report an Issue](https://github.com/PrivaApp/PrivaBlock/issues)**

</div>

---

## Overview

**PrivaBlock** is an open-source privacy extension for Firefox designed to block unwanted advertising and tracking while reducing browser fingerprinting.

It combines network-level filtering, cosmetic filtering, fingerprinting protection, and user-controlled filter lists in a single lightweight extension.

> **Privacy should be the default, not a premium feature.**

---

## Features

| Feature | Description |
|---|---|
| 🛡️ **Ad Blocking** | Blocks unwanted advertising requests and elements. |
| 👁️ **Tracker Blocking** | Reduces tracking and third-party requests. |
| 🎨 **Cosmetic Filtering** | Removes blocked elements from webpages. |
| 🕵️ **Fingerprinting Protection** | Helps reduce browser fingerprinting surfaces. |
| 🌐 **Per-Site Protection** | Enable or disable protection for individual websites. |
| 📋 **Custom Filters** | Create your own filtering rules. |
| 📚 **Custom Filter Lists** | Add and manage external filter lists. |
| 📊 **Blocking Statistics** | View blocked requests for the current site and over time. |
| 🔎 **Request Logger** | Inspect requests and understand why they were blocked or allowed. |
| ⚡ **Filter Caching** | Reduces unnecessary filter processing during browsing. |
| 🎛️ **Filtering Profiles** | Choose between Light, Balanced, and Strict modes. |

---

## Filtering Profiles

PrivaBlock provides three filtering profiles designed for different levels of protection.

| Profile | Protection | Performance | Compatibility |
|---|---|---|---|
| **Light** | Basic | 🟢 High | 🟢 High |
| **Balanced** | Recommended | 🟢 High | 🟢 High |
| **Strict** | Aggressive | 🟡 Moderate | 🟡 Moderate |

### Light

A smaller ruleset designed for users who prioritize compatibility and performance.

### Balanced

The default profile.

Provides a balance between blocking coverage, privacy, compatibility, and performance.

### Strict

A more aggressive configuration with broader filtering coverage.

Strict mode can increase memory and CPU usage and may cause some websites to behave differently.

> **Recommended:** Balanced

---

## Filter Lists

PrivaBlock supports compatible filtering syntax used by widely adopted content-blocking lists.

Depending on the selected configuration, users can enable lists such as:

- EasyList
- EasyPrivacy
- AdGuard filtering lists
- HaGeZi lists
- Peter Lowe's list
- uBlock-compatible lists
- User-defined lists

Filter lists can be individually enabled or disabled from the settings interface.

The available lists and their default configuration may change between releases.

---

## Custom Filters

PrivaBlock allows users to create their own filtering rules.

Example:

```text
||ads.example.com^
example.com##.advertisement
@@||trusted.example.com^
```

Custom filter lists can also be added through the settings interface.

This makes it possible to customize PrivaBlock for websites and use cases that are not covered by the default filter configuration.

---

## Per-Site Protection

Protection can be disabled for an individual website without disabling PrivaBlock globally.

For example:

```text
youtube.com     Protection disabled
github.com      Protection enabled
example.com     Protection enabled
```

Site-specific settings are stored locally in Firefox.

When protection is disabled for a website, the extension clearly reflects its disabled state in the browser interface.

---

## Fingerprinting Protection

PrivaBlock includes fingerprinting protection designed to reduce browser fingerprinting surfaces.

Where possible, PrivaBlock relies on Firefox's own privacy mechanisms instead of attempting fragile browser-identity spoofing.

Fingerprinting protection may affect compatibility on some websites.

---

## Request Logger

PrivaBlock includes a built-in request logger for debugging and transparency.

The logger can display information such as:

- Blocked requests
- Allowed requests
- Request type
- First-party / third-party status
- Matching filter
- Filter source
- Request URL

The logger helps users understand what PrivaBlock is doing on a webpage instead of hiding the filtering process behind the scenes.

---

## Privacy

PrivaBlock is designed with a local-first approach.

### No account required

You do not need to create an account to use PrivaBlock.

### No analytics

PrivaBlock does not include an analytics system or user profiling.

### Local configuration

Settings, blocking statistics, site-specific preferences, and logger data are stored locally in Firefox.

### Third-party filter lists

Filter lists may be downloaded directly from their configured providers.

These requests are made to the respective filter-list providers and are subject to their own privacy policies.

For complete details, see:

**[Privacy Policy](PRIVACY.md)**

---

## Performance

PrivaBlock is designed to minimize unnecessary processing during normal browsing.

Filter data is cached and indexed locally instead of being reparsed for every network request.

However, enabling a very large number of filter lists can increase:

- Memory usage
- CPU usage
- Filter processing time
- The possibility of website compatibility issues

For most users, the **Balanced** profile is recommended.

---

## Installation

### Temporary Installation

1. Clone the repository.

```bash
git clone https://github.com/PrivaApp/PrivaBlock.git
cd PrivaBlock
```

2. Open Firefox.

3. Navigate to:

```text
about:debugging#/runtime/this-firefox
```

4. Select **Load Temporary Add-on**.

5. Select the project's `manifest.json`.

### Firefox Add-ons

PrivaBlock is distributed through Mozilla Add-ons for Firefox.

---

## Development

PrivaBlock is developed as a Firefox WebExtension.

The project intentionally keeps its source code reviewable and self-contained.

### Project Structure

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
├── logger.html
├── logger.js
├── icons/
├── README.md
├── PRIVACY.md
└── LICENSE
```

No bundler, minifier, or external build system is required.

---

## Contributing

Contributions, bug reports, and suggestions are welcome.

Before opening an issue:

1. Make sure you are using the latest version.
2. Test the issue with the **Balanced** profile.
3. Check the built-in request logger.
4. Include the affected website and relevant filter information.
5. Never include private browsing data or personal information.

### Bug Reports

When reporting a filtering problem, please include:

- Website URL
- PrivaBlock version
- Firefox version
- Active filtering profile
- Relevant logger information

---

## Disclaimer

PrivaBlock is an independent open-source project.

It is not affiliated with or endorsed by:

- Mozilla
- uBlock Origin
- EasyList
- EasyPrivacy
- AdGuard
- HaGeZi
- Peter Lowe

Third-party filter lists remain the responsibility of their respective authors and are subject to their own licenses and terms.

---

## License

PrivaBlock is licensed under the **Mozilla Public License 2.0**.

See the [LICENSE](LICENSE) file for the complete license text.

---

<div align="center">

### Built with privacy in mind.

**[PrivaApp](https://github.com/PrivaApp)**

<br>

[![GitHub](https://img.shields.io/github/stars/PrivaApp/PrivaBlock?style=for-the-badge&logo=github)](https://github.com/PrivaApp/PrivaBlock)
[![Issues](https://img.shields.io/github/issues/PrivaApp/PrivaBlock?style=for-the-badge)](https://github.com/PrivaApp/PrivaBlock/issues)

</div>
