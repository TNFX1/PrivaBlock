// Request matching and cosmetic lookup over parsed filter lists (used by the Firefox background,
// and for cosmetic rules on Chromium). Pure JS: no browser APIs, so it is unit-tested in Node.
import { domainMatches, normalizeHost, sameSite } from "./psl.js";
import { patternToRegExp } from "./filters.js";
import { callKey, scriptletData } from "./scriptlets.js";

const TOKEN = /[a-z0-9%_-]{3,}/g;

/**
 * The longest token a matching URL is guaranteed to contain as a whole URL token: bounded on both
 * sides by a separator or an anchor. (A token next to `*` or an unanchored pattern edge may be just
 * part of a longer URL token, so it can't be used as a lookup key.)
 */
export function patternToken(pattern) {
  let body = pattern.toLowerCase();
  const anchoredStart = body.startsWith("|");
  body = body.replace(/^\|\|?/, "");
  const anchoredEnd = body.endsWith("|");
  if (anchoredEnd) body = body.slice(0, -1);
  let best = "";
  for (const m of body.matchAll(TOKEN)) {
    const end = m.index + m[0].length;
    const before = m.index === 0 ? (anchoredStart ? "" : null) : body[m.index - 1];
    const after = end === body.length ? (anchoredEnd ? "" : null) : body[end];
    if (before === null || after === null || before === "*" || after === "*") continue;
    if (m[0].length > best.length) best = m[0];
  }
  return best;
}

function allowedBy(constraint, host) {
  if (!constraint) return true;
  if (constraint.exclude.some((d) => domainMatches(host, d))) return false;
  return !constraint.include.length || constraint.include.some((d) => domainMatches(host, d));
}

/** Walk "a.b.example.com" → "b.example.com" → "example.com" → "com". */
function* hostAndParents(host) {
  let h = host;
  while (h) {
    yield h;
    const dot = h.indexOf(".");
    if (dot < 0) return;
    h = h.slice(dot + 1);
  }
}

class FilterIndex {
  constructor() {
    this.byDomain = new Map(); // filters anchored to a domain (||ads.example.com/…)
    this.byToken = new Map(); // other filters, keyed by one token they require
    this.unkeyed = []; // filters without a usable token (rare): always checked
  }
  add(filter) {
    filter.regex ??= patternToRegExp(filter.pattern, filter.matchCase);
    if (filter.requestDomain) return push(this.byDomain, filter.requestDomain, filter);
    const token = patternToken(filter.pattern);
    if (token) push(this.byToken, token, filter);
    else this.unkeyed.push(filter);
  }
  *candidates(requestHost, url) {
    for (const h of hostAndParents(requestHost)) yield* this.byDomain.get(h) || [];
    const seen = new Set();
    for (const token of url.toLowerCase().match(TOKEN) || []) {
      if (seen.has(token)) continue;
      seen.add(token);
      yield* this.byToken.get(token) || [];
    }
    yield* this.unkeyed;
  }
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export class Engine {
  constructor() {
    this.clear();
  }

  clear() {
    this.blocks = new FilterIndex();
    this.exceptions = new FilterIndex();
    this.replacers = new FilterIndex(); // $replace= filters: response bodies to rewrite (Firefox)
    this.blockedHosts = new Map(); // host → source list
    this.cosmeticByHost = new Map(); // host → rules
    this.cosmeticExceptionsByHost = new Map(); // host → Set(selector)
    this.genericCosmeticExceptions = new Set();
    this.scriptlets = []; // parsed +js rules; looked up per page by the handoff script (see scriptlets.js)
    this.scriptletExceptions = [];
    this.stats = { network: 0, hosts: 0, cosmetic: 0, scriptlets: 0, unsupported: 0 };
  }

  /** Add one parsed list (output of parseList). */
  add(parsed) {
    for (const f of parsed.network) this.blocks.add(f);
    for (const f of parsed.exceptions) this.exceptions.add(f);
    for (const f of parsed.replacers || []) this.replacers.add(f);
    for (const h of parsed.hosts) if (!this.blockedHosts.has(h)) this.blockedHosts.set(h, parsed.source);
    this.addCosmetic(parsed.cosmetic, parsed.cosmeticExceptions);
    this.addScriptlets(parsed.scriptlets, parsed.scriptletExceptions);
    this.stats.network += parsed.network.length;
    this.stats.hosts += parsed.hosts.length;
    this.stats.unsupported += parsed.unsupported || 0;
  }

  addCosmetic(rules, exceptions) {
    for (const rule of rules) for (const h of rule.hosts) push(this.cosmeticByHost, h, rule);
    for (const ex of exceptions) {
      if (!ex.hosts.length) this.genericCosmeticExceptions.add(ex.selector);
      for (const h of ex.hosts) {
        if (!this.cosmeticExceptionsByHost.has(h)) this.cosmeticExceptionsByHost.set(h, new Set());
        this.cosmeticExceptionsByHost.get(h).add(ex.selector);
      }
    }
    this.stats.cosmetic += rules.length;
  }

  addScriptlets(rules = [], exceptions = []) {
    this.scriptlets.push(...rules);
    this.scriptletExceptions.push(...exceptions);
    this.stats.scriptlets += rules.length;
  }

  /** All scriptlet rules as handoff data (see scriptletData). */
  scriptletData() {
    return scriptletData(this.scriptlets, this.scriptletExceptions);
  }

  /** Scriptlet calls for `host`, after host exclusions and exceptions. */
  scriptletsFor(value) {
    const host = normalizeHost(value);
    const scoped = (r) => (!r.hosts.length || r.hosts.some((d) => domainMatches(host, d))) && !r.excludedHosts.some((d) => domainMatches(host, d));
    const excepted = new Set(this.scriptletExceptions.filter(scoped).map((e) => callKey(e.call)));
    if (excepted.has("")) return [];
    const calls = new Map();
    for (const r of this.scriptlets) if (scoped(r) && !excepted.has(callKey(r.call))) calls.set(callKey(r.call), r.call);
    return [...calls.values()];
  }

  /**
   * Decide a request. `type` is a PrivaBlock resource type (see RESOURCE_TYPES), `pageHost` the
   * host of the document that made it. Returns { block, filter } where filter explains the decision.
   */
  match({ url, requestHost, pageHost, type }) {
    requestHost = normalizeHost(requestHost);
    pageHost = normalizeHost(pageHost);
    const ctx = { url, requestHost, pageHost, type, thirdParty: !!pageHost && !sameSite(requestHost, pageHost) };

    const important = this.first(this.blocks, ctx, (f) => f.important);
    if (important) return { block: true, filter: important };
    const exception = this.first(this.exceptions, ctx);
    if (exception) return { block: false, filter: exception };
    for (const h of hostAndParents(requestHost)) {
      if (this.blockedHosts.has(h)) return { block: true, filter: { pattern: `||${h}^`, source: this.blockedHosts.get(h) } };
    }
    const block = this.first(this.blocks, ctx, (f) => !f.important);
    return block ? { block: true, filter: block } : { block: false, filter: null };
  }

  /** $replace= filters that apply to a request (same arguments as match), in list order. */
  replacersFor({ url, requestHost, pageHost, type }) {
    requestHost = normalizeHost(requestHost);
    pageHost = normalizeHost(pageHost);
    const ctx = { url, requestHost, pageHost, type, thirdParty: !!pageHost && !sameSite(requestHost, pageHost) };
    return [...new Set(this.replacers.candidates(requestHost, url))].filter((f) => applies(f, ctx));
  }

  first(index, ctx, extra) {
    for (const f of index.candidates(ctx.requestHost, ctx.url)) {
      if ((!extra || extra(f)) && applies(f, ctx)) return f;
    }
    return null;
  }

  /** Selectors to hide on `host`, after host exclusions and #@# exceptions (plain CSS only). */
  cosmeticFor(value) {
    return this.cosmeticRulesFor(value).filter((r) => !r.procedural).map((r) => r.selector);
  }

  /** Procedural filters for `host` ({ tasks, action } each, see procedural.js). */
  proceduralFor(value) {
    return this.cosmeticRulesFor(value).filter((r) => r.procedural).map((r) => r.procedural);
  }

  cosmeticRulesFor(value) {
    const host = normalizeHost(value);
    const excepted = new Set(this.genericCosmeticExceptions);
    for (const h of hostAndParents(host)) for (const s of this.cosmeticExceptionsByHost.get(h) || []) excepted.add(s);
    const rules = new Map();
    for (const h of hostAndParents(host)) {
      for (const rule of this.cosmeticByHost.get(h) || []) {
        if (excepted.has(rule.selector) || rule.excludedHosts.some((x) => domainMatches(host, x))) continue;
        rules.set(rule.selector, rule);
      }
    }
    return [...rules.values()];
  }
}

function applies(f, ctx) {
  if (f.types.length && !f.types.includes(ctx.type)) return false;
  if (f.excludedTypes.includes(ctx.type)) return false;
  if (!f.types.includes("document") && ctx.type === "document") return false;
  if (f.party === "third" && !ctx.thirdParty) return false;
  if (f.party === "first" && ctx.thirdParty) return false;
  if (!allowedBy(f.pageDomains, ctx.pageHost)) return false;
  if (!allowedBy(f.to, ctx.requestHost)) return false;
  return f.regex.test(ctx.url);
}
