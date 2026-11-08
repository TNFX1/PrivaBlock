// Adblock-style filter list parsing (EasyList / uBlock Origin / AdGuard / hosts syntax).
// Only what PrivaBlock can apply is returned; everything else is counted as unsupported.
import { normalizeHost, hasKnownTld } from "./psl.js";

export const RESOURCE_TYPES = new Set([
  "script", "image", "stylesheet", "font", "media", "object", "xmlhttprequest", "subdocument",
  "document", "websocket", "ping", "csp_report", "other",
]);
const TYPE_ALIASES = { xhr: "xmlhttprequest", beacon: "ping", css: "stylesheet", frame: "subdocument" };
const PARTY_OPTIONS = new Set(["third-party", "3p", "first-party", "1p", "~third-party", "~3p", "~first-party", "~1p"]);
const FLAG_OPTIONS = new Set(["important", "match-case"]);
const VALUE_OPTIONS = new Set(["domain", "from", "to"]);
// Procedural / scriptlet / HTML-filtering syntax and pseudo-classes PrivaBlock does not implement.
const UNSUPPORTED_COSMETIC = /^\+js\(|^\^|:(?:has-text|-abp-|matches-css|matches-attr|matches-path|min-text-length|upward|remove|style|xpath|watch-attr|others|if|if-not|nth-ancestor|contains)\b/;

/** Split "a.com|~b.com" or "a.com,~b.com" into included and excluded domains. */
export function parseDomains(value, separator = "|") {
  const include = [];
  const exclude = [];
  for (const part of String(value || "").split(separator)) {
    const negated = part.trim().startsWith("~");
    const host = normalizeHost(part.trim().replace(/^~/, ""));
    if (host && host !== "*") (negated ? exclude : include).push(host);
  }
  return { include, exclude };
}

function parseOptions(text) {
  const types = [];
  const excludedTypes = [];
  const options = { important: false, matchCase: false, party: null, domain: null, from: null, to: null };
  for (const raw of text.split(",")) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    const eq = item.indexOf("=");
    const key = eq < 0 ? item : item.slice(0, eq);
    const value = eq < 0 ? "" : raw.trim().slice(eq + 1);
    const negated = key.startsWith("~");
    const name = negated ? key.slice(1) : key;
    const type = TYPE_ALIASES[name] || name;
    if (eq < 0 && RESOURCE_TYPES.has(type)) (negated ? excludedTypes : types).push(type);
    else if (eq < 0 && PARTY_OPTIONS.has(key)) {
      const third = name === "third-party" || name === "3p";
      options.party = third !== negated ? "third" : "first";
    } else if (eq < 0 && FLAG_OPTIONS.has(key)) options[key === "important" ? "important" : "matchCase"] = true;
    else if (eq > 0 && VALUE_OPTIONS.has(key)) options[key] = parseDomains(value);
    else return null; // unknown or unsupported option: skipping beats misapplying the filter
  }
  return { types, excludedTypes, ...options };
}

/** Compile an ABP pattern (||, |, ^, *) to a RegExp over lower-cased URLs (unless match-case). */
export function patternToRegExp(pattern, matchCase = false) {
  let body = pattern;
  let prefix = "";
  let suffix = "";
  if (body.startsWith("||")) {
    prefix = "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?";
    body = body.slice(2);
  } else if (body.startsWith("|")) {
    prefix = "^";
    body = body.slice(1);
  }
  if (body.endsWith("|")) {
    suffix = "$";
    body = body.slice(0, -1);
  }
  let source = "";
  for (const ch of body) {
    if (ch === "*") source += ".*";
    else if (ch === "^") source += "(?:[^a-zA-Z0-9_.%-]|$)";
    else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(prefix + source + suffix, matchCase ? "" : "i");
}

/** A network filter, or null when it can't be applied faithfully. */
export function parseNetworkFilter(line, source, exception = false) {
  let pattern = line;
  let options = { types: [], excludedTypes: [], important: false, matchCase: false, party: null, domain: null, from: null, to: null };
  const dollar = line.lastIndexOf("$");
  if (dollar > 0 && !/^\/.*\/$/.test(line)) {
    const parsed = parseOptions(line.slice(dollar + 1));
    if (!parsed) return null;
    options = parsed;
    pattern = line.slice(0, dollar);
  }
  pattern = pattern.trim();
  // Regex filters (/…/) and empty / match-everything patterns are not supported.
  if (!pattern || pattern === "*" || pattern === "|" || pattern === "||" || /^\/.*\/$/.test(pattern)) return null;
  if (pattern.length > 2048 || /\s/.test(pattern)) return null;
  // A bare host name ("ads.example.com$image") means that host, as in uBlock Origin.
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(pattern) && hasKnownTld(pattern)) pattern = `||${pattern}^`;
  const types = options.types.filter((t) => !options.excludedTypes.includes(t));
  if (options.types.length && !types.length) return null;
  const domainMatch = pattern.match(/^\|\|([a-z0-9.-]+)(?:\^|\/|$)/i);
  return {
    kind: "network",
    pattern,
    exception,
    source,
    requestDomain: domainMatch ? normalizeHost(domainMatch[1]) : "",
    ...options,
    types,
    pageDomains: options.domain || options.from,
  };
}

/** A cosmetic (element hiding) rule, or null when generic, procedural or malformed. */
export function parseCosmeticFilter(line, source) {
  const match = line.match(/^([^#]*?)(#@#|##|#\?#|#\$#|#%#|#@\$#|#@%#|#@\?#)(.+)$/);
  if (!match) return null;
  const [, hostPart, separator, selector] = match;
  if (separator !== "##" && separator !== "#@#") return null; // procedural / CSS injection / scriptlets
  const sel = selector.trim();
  if (!sel || sel.length > 2000 || UNSUPPORTED_COSMETIC.test(sel)) return null;
  const { include, exclude } = parseDomains(hostPart, ",");
  if (separator === "##" && !include.length) return null; // generic rules: too costly to apply everywhere
  return { kind: separator === "#@#" ? "cosmeticException" : "cosmetic", hosts: include, excludedHosts: exclude, selector: sel, source };
}

/**
 * Parse a filter list. Returns { network, exceptions, hosts, cosmetic, cosmeticExceptions, unsupported }.
 * `hosts` are plain domains to block entirely (from hosts files and bare `||domain^` filters).
 */
export function parseList(text, source) {
  const out = { source, network: [], exceptions: [], hosts: [], cosmetic: [], cosmeticExceptions: [], unsupported: 0 };
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("!") || line.startsWith("[") || (line.startsWith("#") && !line.startsWith("##") && !line.startsWith("#@#"))) continue;
    if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s/.test(line)) {
      for (const host of line.split(/\s+/).slice(1)) {
        if (host.startsWith("#")) break;
        if (/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host) && host !== "localhost") out.hosts.push(normalizeHost(host));
      }
      continue;
    }
    if (/#[@?$%]*#/.test(line) && !line.startsWith("@@")) {
      const rule = parseCosmeticFilter(line, source);
      if (!rule) out.unsupported++;
      else (rule.kind === "cosmetic" ? out.cosmetic : out.cosmeticExceptions).push(rule);
      continue;
    }
    const exception = line.startsWith("@@");
    const filter = parseNetworkFilter(exception ? line.slice(2) : line, source, exception);
    if (!filter) out.unsupported++;
    else if (exception) out.exceptions.push(filter);
    else if (isPlainDomainBlock(filter)) out.hosts.push(filter.requestDomain);
    else out.network.push(filter);
  }
  return out;
}

/** `||example.com^` with no options: block every request to the domain. */
export function isPlainDomainBlock(filter) {
  return (
    !!filter.requestDomain &&
    filter.pattern === `||${filter.requestDomain}^` &&
    !filter.types.length && !filter.excludedTypes.length && !filter.party &&
    !filter.pageDomains && !filter.to && !filter.important && !filter.matchCase
  );
}
