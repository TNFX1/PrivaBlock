// Adblock-style filter list parsing (EasyList / uBlock Origin / AdGuard / hosts syntax).
// Only what PrivaBlock can apply is returned; everything else is counted as unsupported.
import { normalizeHost, hasKnownTld } from "./psl.js";
import { parseScriptletCall } from "./scriptlets.js";
import { isProcedural, parseProcedural } from "./procedural.js";
import { LISTS } from "./lists.js";

/** True for uBlock Origin's own lists, the only ones allowed trusted-only filters. */
export const isTrusted = (source) => LISTS[source]?.trusted === true;

export const RESOURCE_TYPES = new Set([
  "script", "image", "stylesheet", "font", "media", "object", "xmlhttprequest", "subdocument",
  "document", "websocket", "ping", "csp_report", "other",
]);
const TYPE_ALIASES = { xhr: "xmlhttprequest", beacon: "ping", css: "stylesheet", frame: "subdocument", doc: "document" };
// @@…$generichide and friends: no generic / no cosmetic filtering at all on the matching pages.
const HIDE_OPTIONS = { generichide: "generic", ghide: "generic", elemhide: "all", ehide: "all", specifichide: "specific", shide: "specific" };
const PARTY_OPTIONS = new Set(["third-party", "3p", "first-party", "1p", "~third-party", "~3p", "~first-party", "~1p"]);
const FLAG_OPTIONS = new Set(["important", "match-case"]);
const VALUE_OPTIONS = new Set(["domain", "from", "to"]);
// HTML filtering (##^) is not implemented.
const UNSUPPORTED_COSMETIC = /^\^/;

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

/** `/pattern/replacement/flags` (slashes inside escaped as `\/`) → { regex, replacement }, or null. */
export function parseReplace(value) {
  const parts = [];
  let current = "";
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\" && value[i + 1] === "/") {
      current += "/";
      i++;
    } else if (value[i] === "/") {
      parts.push(current);
      current = "";
    } else current += value[i];
  }
  parts.push(current);
  if (!value.startsWith("/") || parts.length !== 3 || !parts[0] || !/^[gimsu]*$/.test(parts[2])) return null;
  try {
    return { regex: new RegExp(parts[0], parts[2]), replacement: parts[1] };
  } catch {
    return null;
  }
}

function parseOptions(text, trusted = false) {
  const types = [];
  const excludedTypes = [];
  const options = { important: false, matchCase: false, party: null, domain: null, from: null, to: null, replace: null, popup: false, redirect: null, hide: null };
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
    else if (eq < 0 && key === "popup") options.popup = true;
    else if (eq < 0 && HIDE_OPTIONS[key]) options.hide = HIDE_OPTIONS[key];
    else if (eq > 0 && (key === "redirect" || key === "redirect-rule") && !options.redirect) {
      // name[:priority]; the priority is dropped (one surrogate per request is enough)
      const resource = value.trim().replace(/:-?\d+$/, "");
      if (!resource || resource === "none") return null;
      options.redirect = { resource, rule: key === "redirect-rule" };
    } else if (key === "replace" && trusted && !options.replace) {
      options.replace = parseReplace(value); // response body rewriting: Firefox only, trusted lists only
      if (!options.replace) return null;
    }
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
  let options = { types: [], excludedTypes: [], important: false, matchCase: false, party: null, domain: null, from: null, to: null, replace: null, popup: false, redirect: null, hide: null };
  // $replace=/a/b/ can itself contain "$": the options start at the first "$" followed by a known-looking option list.
  const replaceAt = line.search(/\$(?:[^$]*,)?replace=\//);
  const dollar = replaceAt > 0 ? replaceAt : line.lastIndexOf("$");
  if (dollar > 0 && !/^\/.*\/$/.test(line)) {
    const parsed = parseOptions(line.slice(dollar + 1), isTrusted(source));
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

/**
 * A cosmetic rule, or null when generic, unsupported or malformed. Kinds: cosmetic / cosmeticException
 * (plain CSS, or `procedural` when the selector needs the content script's own matcher) and
 * scriptlet / scriptletException (`+js(…)`, `call` = [name, ...args]).
 */
export function parseCosmeticFilter(line, source) {
  const match = line.match(/^([^#]*?)(#@#|##|#\?#|#\$#|#%#|#@\$#|#@%#|#@\?#)(.+)$/);
  if (!match) return null;
  const [, hostPart, separator, selector] = match;
  const exception = separator.startsWith("#@");
  if (!["##", "#@#", "#?#", "#@?#"].includes(separator)) return null; // AdGuard CSS injection / JS rules
  const sel = selector.trim();
  // Scriptlet calls can carry code (uBO's YouTube replace-node-text is ~4 KB); selectors stay short.
  if (!sel || sel.length > (sel.startsWith("+js(") ? 20000 : 2000) || UNSUPPORTED_COSMETIC.test(sel)) return null;
  const { include, exclude } = parseDomains(hostPart, ",");
  // Generic (no host) rules: plain CSS hiding only, as uBO; scriptlets and procedural ones need a host.
  const generic = !exception && !include.length;
  if (generic && (sel.startsWith("+js(") || separator !== "##" || isProcedural(sel))) return null;
  const base = { hosts: include, excludedHosts: exclude, source, ...(generic ? { generic: true } : {}) };
  if (sel.startsWith("+js(")) {
    if (!sel.endsWith(")") || separator.includes("?")) return null;
    const call = parseScriptletCall(sel.slice(4, -1), isTrusted(source));
    if (!call || (!call.length && !exception)) return null;
    return { kind: exception ? "scriptletException" : "scriptlet", ...base, call };
  }
  const rule = { kind: exception ? "cosmeticException" : "cosmetic", ...base, selector: sel };
  if (isProcedural(sel)) {
    const procedural = parseProcedural(sel);
    if (!procedural) return null;
    rule.procedural = procedural;
  }
  return rule;
}

/**
 * Parse a filter list. Returns { network, exceptions, hosts, replacers, cosmetic, cosmeticExceptions,
 * scriptlets, scriptletExceptions, unsupported }. `replacers` are $replace= filters (Firefox only).
 * `hosts` are plain domains to block entirely (from hosts files and bare `||domain^` filters).
 */
export function parseList(text, source, badfilters = badfiltersOf(text)) {
  const out = {
    source, network: [], exceptions: [], hosts: [], replacers: [], cosmetic: [], cosmeticExceptions: [], scriptlets: [], scriptletExceptions: [],
    popups: [], popupExceptions: [], redirectRules: [], hideExceptions: [], unsupported: 0,
  };
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("!") || line.startsWith("[") || (line.startsWith("#") && !line.startsWith("##") && !line.startsWith("#@#"))) continue;
    if (badfilters.has(line) || /[$,]badfilter(?:,|$)/.test(line)) continue;
    if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s/.test(line)) {
      for (const host of line.split(/\s+/).slice(1)) {
        if (host.startsWith("#")) break;
        if (/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host) && host !== "localhost") out.hosts.push(normalizeHost(host));
      }
      continue;
    }
    if (/#[@?$%]*#/.test(line) && !line.startsWith("@@")) {
      const rule = parseCosmeticFilter(line, source);
      const into = { cosmetic: out.cosmetic, cosmeticException: out.cosmeticExceptions, scriptlet: out.scriptlets, scriptletException: out.scriptletExceptions };
      if (!rule) out.unsupported++;
      else into[rule.kind].push(rule);
      continue;
    }
    const exception = line.startsWith("@@");
    const filter = parseNetworkFilter(exception ? line.slice(2) : line, source, exception);
    if (!filter || ((filter.replace || filter.redirect) && exception) || (filter.hide && !exception)) out.unsupported++;
    else if (filter.hide) out.hideExceptions.push(filter);
    else if (filter.popup) (exception ? out.popupExceptions : out.popups).push(filter);
    else if (filter.replace) out.replacers.push(filter);
    else if (filter.redirect?.rule) out.redirectRules.push(filter);
    else if (exception) out.exceptions.push(filter);
    else if (isPlainDomainBlock(filter)) out.hosts.push(filter.requestDomain);
    else out.network.push(filter);
  }
  return out;
}

/**
 * The filters a list cancels with `$badfilter` (uBO): each `…$badfilter` line names the same filter without
 * that option. Lists pass the union of all enabled lists' sets, so one list can cancel another's filter.
 */
export function badfiltersOf(text, into = new Set()) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(.*)\$(.*)$/.exec(line);
    if (!m || !/(?:^|,)badfilter(?:,|$)/.test(m[2])) continue;
    const opts = m[2].split(",").filter((o) => o !== "badfilter");
    into.add(opts.length ? `${m[1]}$${opts.join(",")}` : m[1]);
  }
  return into;
}

/** `||example.com^` with no options: block every request to the domain. */
export function isPlainDomainBlock(filter) {
  return (
    !!filter.requestDomain &&
    filter.pattern === `||${filter.requestDomain}^` &&
    !filter.types.length && !filter.excludedTypes.length && !filter.party &&
    !filter.pageDomains && !filter.to && !filter.important && !filter.matchCase && !filter.redirect
  );
}
