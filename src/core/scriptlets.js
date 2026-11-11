// Scriptlet filters (`example.com##+js(name, arg, …)`): parsing, and the small isolated-world script
// that hands a page its scriptlet calls. The scriptlets themselves are PrivaBlock's own code, in
// src/content/scriptlets-main.js (page world); this file only knows their names.
import { normalizeHost } from "./psl.js";

// Every name and alias PrivaBlock implements → the canonical name scriptlets-main.js runs.
const NAMES = {
  "set-constant": ["set"],
  "abort-on-property-read": ["aopr"],
  "abort-on-property-write": ["aopw"],
  "abort-current-script": ["acs", "abort-current-inline-script", "acis"],
  "abort-on-stack-trace": ["aost"],
  "json-prune": [],
  "no-setTimeout-if": ["nostif", "prevent-setTimeout", "setTimeout-defuser"],
  "no-setInterval-if": ["nosiif", "prevent-setInterval", "setInterval-defuser"],
  "adjust-setTimeout": ["nano-stb", "nano-setTimeout-booster"],
  "adjust-setInterval": ["nano-sib", "nano-setInterval-booster"],
  "addEventListener-defuser": ["aeld", "prevent-addEventListener"],
  "no-window-open-if": ["nowoif", "prevent-window-open", "window.open-defuser"],
  "no-fetch-if": ["prevent-fetch"],
  "no-xhr-if": ["prevent-xhr"],
  "noeval-if": ["prevent-eval-if"],
  "noeval": [],
  "nowebrtc": [],
  "remove-attr": ["ra"],
  "remove-class": ["rc"],
  "remove-node-text": ["rmnt"],
  "set-cookie": [],
  "remove-cookie": ["cookie-remover"],
  "set-local-storage-item": [],
  "set-session-storage-item": [],
  "json-prune-fetch-response": [],
  "json-prune-xhr-response": [],
  "json-edit": [],
  "json-edit-fetch-response": [],
  "json-edit-xhr-response": [],
  "edit-inbound-object": [],
  "prevent-bab": ["nobab", "bab-defuser"],
  "prevent-fab": ["nofab", "prevent-fab-3.2.0", "fuckadblock.js-3.2.0"],
  "popads-dummy": [],
};
// Only from trusted lists (see lists.js): they rewrite what the page receives or runs.
const TRUSTED_NAMES = {
  "trusted-replace-fetch-response": ["trusted-rpfr"],
  "trusted-replace-xhr-response": ["trusted-rpxr"],
  "trusted-json-edit": [],
  "trusted-json-edit-fetch-response": [],
  "trusted-json-edit-xhr-response": [],
  "trusted-edit-inbound-object": [],
  "trusted-prevent-dom-bypass": [],
  "replace-node-text": ["rpnt", "trusted-replace-node-text", "trusted-rpnt"],
};
const CANONICAL = new Map();
const TRUSTED = new Set();
for (const [table, trusted] of [[NAMES, false], [TRUSTED_NAMES, true]]) {
  for (const [name, aliases] of Object.entries(table)) {
    for (const n of [name, ...aliases]) CANONICAL.set(n.toLowerCase(), name);
    if (trusted) TRUSTED.add(name);
  }
}

/** The canonical scriptlet name, or "" when PrivaBlock doesn't implement it or it needs a trusted list. */
export function scriptletName(raw, trusted = false) {
  const name = CANONICAL.get(String(raw).trim().replace(/\.js$/, "").toLowerCase()) || "";
  return TRUSTED.has(name) && !trusted ? "" : name;
}

/**
 * The inside of `+js(…)` → [name, ...args], or null. Arguments are split on commas; `\,` is a literal
 * comma, and an argument wrapped in matching quotes keeps its commas.
 */
export function parseScriptletCall(body, trusted = false) {
  const args = [];
  let i = 0;
  while (i <= body.length) {
    while (body[i] === " ") i++;
    let arg = "";
    const quote = body[i] === '"' || body[i] === "'" || body[i] === "`" ? body[i] : "";
    if (quote) {
      const end = findQuoteEnd(body, i + 1, quote);
      if (end >= 0 && /^\s*(?:,|$)/.test(body.slice(end + 1))) {
        arg = body.slice(i + 1, end).replaceAll(`\\${quote}`, quote);
        i = body.indexOf(",", end + 1);
        args.push(arg);
        if (i < 0) break;
        i++;
        continue;
      }
    }
    for (; i < body.length; i++) {
      if (body[i] === "\\" && body[i + 1] === ",") {
        arg += ",";
        i++;
      } else if (body[i] === ",") break;
      else arg += body[i];
    }
    args.push(arg.trim());
    i++;
  }
  if (!args.length || !args[0]) return [];
  const name = scriptletName(args[0], trusted);
  return name ? [name, ...args.slice(1)] : null;
}

function findQuoteEnd(text, from, quote) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** A key that identifies one call, for exceptions (`#@#+js(…)`) and de-duplication. "" = every call. */
export const callKey = (call) => (call.length ? JSON.stringify(call) : "");

/**
 * Data for handoffCode: { h: host → [[call, excludedHosts]], x: host → [exception keys], g: [generic exception keys] }.
 * `rules` and `exceptions` are parsed scriptlet filters (see parseCosmeticFilter).
 */
export function scriptletData(rules, exceptions) {
  const h = {};
  const x = {};
  const g = [];
  for (const r of rules) for (const host of r.hosts) (h[host] ||= []).push(r.excludedHosts.length ? [r.call, r.excludedHosts] : [r.call]);
  for (const e of exceptions) {
    if (!e.hosts.length) g.push(callKey(e.call));
    for (const host of e.hosts) (x[host] ||= []).push(callKey(e.call));
  }
  return { h, x, g };
}

/** Match patterns for the hosts that have scriptlets (entity hosts like `google.*` are left out). */
export function hostMatches(hosts) {
  const out = [];
  for (const raw of hosts) {
    const h = normalizeHost(raw);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) out.push(`*://${h}/*`);
    else if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(h)) out.push(`*://*.${h}/*`);
  }
  return out;
}

/**
 * Split handoff data into shards of about `maxBytes` of JSON each, so a page loads only the shard for its
 * own host instead of every list's calls: [{ data, matches }]. Hosts stay sorted, so a site and its
 * subdomains mostly land in the same shard.
 */
export function scriptletShards(data, maxBytes = 48_000) {
  const shards = [];
  let current = null;
  for (const host of Object.keys(data.h).sort()) {
    const size = host.length + JSON.stringify(data.h[host]).length + 4;
    if (!current || (current.size + size > maxBytes && current.hosts.length)) {
      current = { hosts: [], size: 0 };
      shards.push(current);
    }
    current.hosts.push(host);
    current.size += size;
  }
  return shards.map(({ hosts }) => {
    const h = {};
    const x = {};
    for (const host of hosts) h[host] = data.h[host];
    // exceptions for these hosts and their parents
    for (const [host, keys] of Object.entries(data.x)) if (hosts.some((d) => d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`))) x[host] = keys;
    return { data: { h, x, g: data.g }, matches: hostMatches(hosts) };
  }).filter((s) => s.matches.length);
}

/**
 * Isolated-world code that picks the calls for this frame's host from `data` and hands them to the
 * page-world runner (scriptlets-main.js) through a documentElement attribute plus an event: both
 * scripts run at document_start, before any page script, in either order.
 */
export function handoffCode(data) {
  return `(${handoff})(${JSON.stringify(data)});`;
}

/** Also called directly by content.js for calls that arrive by message (Chromium user filters). */
export function handoff(data) {
  const host = location.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || !document.documentElement) return;
  const parents = [];
  for (let h = host; h; h = h.includes(".") ? h.slice(h.indexOf(".") + 1) : "") parents.push(h);
  const under = (d) => host === d || host.endsWith(`.${d}`);
  const excepted = new Set(data.g || []);
  for (const p of parents) for (const k of (data.x && data.x[p]) || []) excepted.add(k);
  if (excepted.has("")) return;
  const calls = [];
  for (const p of parents) {
    for (const [call, excluded] of (data.h && data.h[p]) || []) {
      if (excluded && excluded.some(under)) continue;
      if (!excepted.has(JSON.stringify(call))) calls.push(call);
    }
  }
  if (!calls.length) return;
  const root = document.documentElement;
  const ATTR = "data-privablock-sl";
  let queued = [];
  try {
    queued = JSON.parse(root.getAttribute(ATTR) || "[]");
  } catch {}
  root.setAttribute(ATTR, JSON.stringify(queued.concat(calls)));
  document.dispatchEvent(new Event("privablock-sl"));
}
