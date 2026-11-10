# PrivaBlock UI redesign: the hedgehog's back

Date: 2026-11-10. Status: draft, waiting for owner review.

**Amendment, 2026-11-10.** After trying the redesign on Chromium (Helium), the owner decided the
split into ads and trackers is no longer shown: the popup shows only the blocked total, every quill
is white, there are no Ads/Trackers rows, and the daily sentence gives one total. The backgrounds no
longer keep the split either (`kindOf`, the per-kind tally and `dailyAds`/`dailyTrackers` are gone).
On Chromium the toolbar number is the browser's automatic action count
(`declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText })`, set on every
worker start and when "Show count on the icon" changes). It was missing before because 3.0.0 called
`setExtensionActionOptions` on `chrome.action`, where it does not exist, so the call threw and the
count was never switched on. Where the sections below talk about ads versus trackers, this
amendment wins.

## Goal

The 3.0 popup and settings page work but look generic, and the owner could not see at a glance
that trackers are being blocked. The redesign gives PrivaBlock a look that comes from its own
logo and puts the blocked count, split into ads and trackers, at the top of the popup and on the
toolbar icon.

Success: the owner opens the popup on a normal site and immediately reads how many ads and how
many trackers were blocked, and the UI no longer reads as a template.

Mockups approved in conversation: `.superpowers/brainstorm/4157-1794295032/content/popup-quills-v2.html`
and `settings-quill-style.html` (local only, not committed).

## Popup

Width 290 px. Two zones, no cards, no header bar.

**Field (top).** Flat brand blue `#2f5bea` in both themes, white text.

- Row 1: site hostname (left, ellipsis on overflow), site protection switch (right).
- The page's blocked count, 64 px, weight 600.
- Caption under it: "requests blocked on this page".
- Quill strip along the bottom edge (see below).

**List (bottom).** Panel colour (`#172238` dark, `#ffffff` light), plain rows separated by 1 px rules.

- Ads, with count. Small white triangle as the key.
- Trackers, with count. Small pale-blue triangle as the key.
- Today, with count, muted. Firefox only (Chromium has no daily counter; row hidden as today).
- Request log (opens the logger).
- Settings (opens the options page).

Removed from the popup: logo header, status pill, rule count, version, the two-button action row.
Rule count and version live in settings.

### States

| State | Field | Number | Quills | Ads/Trackers rows |
|---|---|---|---|---|
| On, n > 0 | blue | n | yes | shown |
| On, n = 0 | blue | 0, caption "Nothing to block on this page yet" | flat edge | hidden |
| Off for this site | grey (`#3a465c` dark, `#8a96aa` light) | the word "Off", 40 px, caption "Nothing is blocked on this site" | flat edge | hidden |
| Not a web page | grey | caption "Browser pages can't be filtered", no number | flat edge | hidden, switch hidden |
| Background not reachable | grey | caption with the existing `popupUnavailable` text | flat edge | hidden |

### Quill strip

Each blocked request is one quill: a narrow triangle standing on the field's bottom edge.
Ad quills are white, tracker quills pale blue (`#c3d1ff` dark theme, `#9db4ff` light theme).

- A full row holds 23 quills.
- Quills fill left to right in the order the requests were blocked.
- When the row is full and another request is blocked, the row clears and starts again:
  quills shown = `((n - 1) mod 23) + 1` for n > 0, and they are the most recent that many requests.
  The big number keeps counting (30 blocked shows 30 and 7 quills).
- Quill height (11 to 26 px) and lean are derived from the quill's index, so the same count always
  draws the same shape and nothing jitters between refreshes.
- The strip is an inline SVG built with DOM calls, `aria-hidden`; the numbers carry the information.
- While the popup is open it refreshes once a second, so quills appear as the page keeps loading.

## Ads versus trackers

A blocked request is a tracker when the list that blocked it is in group `privacy` or `adsPrivacy`;
everything else is an ad (groups `core`, `ads`, `annoyances`, `compatibility`, custom lists, the
user's own filters).

`adsPrivacy` (HaGeZi) is a mixed list that blocks both ad and tracking hosts. It counts as tracker
here. When a request matches both an ad list and HaGeZi, which one is credited depends on the
engine's match order (Firefox) or on Chromium's choice among equal-priority rules; that order is
not verified yet and must be checked while planning. The split is an approximation and is named
as such in the About section.

One shared function in `src/core/lists.js`: `kindOf(sourceId) → "ad" | "tracker"`.

## Data

`getStats` gains one field on both browsers and keeps the rest:

```
recent: ["ad", "tracker", ...]   // kinds of the blocked requests on this tab, oldest first, at most 23:
                                 // exactly the quills to draw
ads: number, trackers: number    // page totals; pageBlocked = ads + trackers
```

- **Firefox.** Per tab, the background keeps `{ ads, trackers, recent }` instead of a single number.
  `recent` is cleared when it holds 23 and a new block arrives. Cleared on navigation like the
  count is today. Cosmetic hits count as ads, as they do in the total today.
- **Chromium.** `matchedOnTab` (from the pending count fix) already returns each match with its
  ruleset id and time. Sort by time, map through `kindOf`, derive the same three fields. The pending
  count fix (`getMatchedRules` minus allow rules, `allowIds` in `rulesets/counts.json`) ships with
  this work.

## Toolbar badge

Unchanged behaviour: total blocked on the page, brand blue background. New setting
`showBadge` (default on):

- Firefox: when off, `updateBadge` sets empty text.
- Chromium: `setExtensionActionOptions({ displayActionCountAsBadgeText: showBadge })`.

## Settings page

One page, two columns.

**Sidebar (200 px).** Brand blue, logo and name on top, five links, version at the bottom.
The current section is white and bold with a 3 px white bar on the left edge; the others pale blue.
Below 640 px the sidebar becomes a horizontal row on top.

**Content.** Panel colour, no cards: section title (22 px), then plain rows with 1 px rules.
One section visible at a time, chosen by the URL hash (`#lists`), default `#protection`.

| Section | Contents (all existing controls, moved) |
|---|---|
| Protection | Firefox only: one sentence "Today N requests were blocked: A ads, T trackers." Protection level as three radio rows (Light, Balanced, Strict). "Show count on the icon" switch (new). Fingerprinting protection switch (Firefox only). |
| Lists | Rule count and "Update filters" button, list toggles by group, custom lists form and rows. |
| My filters | The textarea, dynamic-rule limit notice, Apply button. |
| Sites | Sites where protection is off. |
| About | Version, the ads/trackers explanation, diagnostics and benchmark. |

The daily sentence needs the daily counter split too: Firefox stores `dailyAds` and
`dailyTrackers` next to `dailyBlocked`.

## Shared styling

`theme.css` keeps its tokens, fonts and controls (switch, button, input). The `.card` look is no
longer used by popup or settings. The logger page is not redesigned; it keeps working with the
same tokens.

Strings: English and Turkish for every new label. No uppercase labels.

Accessibility: real `input type=radio` and `role=switch` controls, visible focus, sidebar links
are a `nav` with `aria-current`, colour is never the only carrier (rows have text labels),
`prefers-reduced-motion` needs nothing because there is no animation.

## Not in this change

- All-time totals (only page and today counts exist).
- A theme picker (the UI follows the system theme, as now).
- A "report a problem" action.
- A grey toolbar icon for disabled sites.
- Daily counts on Chromium.
- Logger redesign.

## Testing

- Unit (`npm test`): `kindOf` for each list group, custom list and user filters; the quill window
  (`n = 0, 1, 23, 24, 46, 47`); Firefox per-tab counters reset on navigation.
- Firefox smoke: popup shows ads + trackers equal to the total; switch turns the field grey.
- Chromium smoke: same, plus the existing count check from the pending fix.
- Manual: both themes, both languages, a page with more than 23 blocks, a browser page.
