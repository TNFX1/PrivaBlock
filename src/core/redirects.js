// $redirect= resources: uBO resource names (and their aliases) → PrivaBlock's own files in src/redirects/.
// A filter that names a resource missing here just blocks.
const FILES = {
  "noop.js": ["noopjs", "abp-resource:blank-js"],
  "noop.txt": ["nooptext", "noop.text"],
  "noop.html": ["noopframe", "noop-frame", "noop.htm"],
  "noop.css": ["noopcss"],
  "noop.json": ["noopjson"],
  "1x1.gif": ["1x1-transparent.gif", "1x1.gif"],
  "2x2.png": ["2x2-transparent.png"],
  "32x32.png": ["32x32-transparent.png"],
  "noop-0.1s.mp3": ["noopmp3-0.1s", "abp-resource:blank-mp3"],
  "noop-1s.mp4": ["noopmp4-1s", "abp-resource:blank-mp4"],
  "google-ima.js": ["google-ima3"],
  "googletagservices_gpt.js": ["googletagservices.com/gpt.js", "googletagservices-gpt"],
  "googletagmanager_gtm.js": ["googletagmanager.com/gtm.js", "google-tag-manager"],
  "google-analytics_analytics.js": ["google-analytics.com/analytics.js", "googletagmanager_gtag", "googletagmanager.com/gtag/js"],
  "googlesyndication_adsbygoogle.js": ["googlesyndication.com/adsbygoogle.js", "googlesyndication-adsbygoogle"],
  "amazon_apstag.js": ["amazon-adsystem.com/aax2/apstag.js", "amazon-apstag"],
  "fingerprint2.js": [],
  "fuckadblock.js": ["fuckadblock.js-3.2.0", "nofab"],
};
const BY_NAME = new Map();
for (const [file, aliases] of Object.entries(FILES)) for (const n of [file, ...aliases]) BY_NAME.set(n, file);

/** The file in redirects/ for a resource name, or "" when PrivaBlock has no such resource. */
export const redirectFile = (name) => BY_NAME.get(String(name || "").trim()) || "";
