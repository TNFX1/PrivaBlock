// Registrable domain ("site") of a host, using the Public Suffix List.
// bbc.co.uk and gov.co.uk are different sites; so are a.github.io and b.github.io.
import RULES from "./psl-data.js";

const exact = new Set();
const wildcard = new Set(); // "*.ck" stored as "ck"
const exception = new Set(); // "!www.ck" stored as "www.ck"
for (const rule of RULES) {
  if (rule.startsWith("!")) exception.add(rule.slice(1));
  else if (rule.startsWith("*.")) wildcard.add(rule.slice(2));
  else exact.add(rule);
}

const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/** Normalise a host name: lower case, no leading/trailing dots. */
export function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

/** True when the last label of `host` is a real top-level domain ("com", "tr", not "js"). */
export function hasKnownTld(host) {
  return exact.has(host.slice(host.lastIndexOf(".") + 1).toLowerCase());
}

/** The public suffix of `host` (e.g. "co.uk" for "www.bbc.co.uk"). */
export function publicSuffix(host) {
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (exception.has(candidate)) return labels.slice(i + 1).join(".");
    if (exact.has(candidate)) return candidate;
    if (i + 1 < labels.length && wildcard.has(labels.slice(i + 1).join("."))) return candidate;
  }
  return labels[labels.length - 1]; // unknown TLD: treat the last label as the suffix
}

/** The registrable domain of `host`, e.g. "bbc.co.uk" for "www.bbc.co.uk". */
export function siteOf(value) {
  const host = normalizeHost(value);
  if (!host || IP.test(host) || !host.includes(".")) return host;
  const suffix = publicSuffix(host);
  if (suffix === host) return host;
  const rest = host.slice(0, -suffix.length - 1);
  return `${rest.slice(rest.lastIndexOf(".") + 1)}.${suffix}`;
}

/** True when both hosts belong to the same site. */
export function sameSite(a, b) {
  return siteOf(a) === siteOf(b);
}

/** True when `host` is `domain` or one of its subdomains. */
export function domainMatches(host, domain) {
  host = normalizeHost(host);
  domain = normalizeHost(domain);
  return !!domain && (host === domain || host.endsWith(`.${domain}`));
}
