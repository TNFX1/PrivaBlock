// Convert parsed filter lists to Chromium declarativeNetRequest rules (MV3).
// Used at build time for the bundled lists and at run time for user filters / custom lists.

const TYPE_MAP = {
  script: "script", image: "image", stylesheet: "stylesheet", font: "font", media: "media",
  object: "object", xmlhttprequest: "xmlhttprequest", subdocument: "sub_frame", document: "main_frame",
  websocket: "websocket", ping: "ping", csp_report: "csp_report", other: "other",
};
export const PRIORITY = { block: 1, allow: 2, important: 3, siteDisabled: 100 };
const DOMAINS_PER_RULE = 1000;

/** Punycode a domain the way URLs carry it; null if it isn't a valid host. */
function asciiDomain(domain) {
  try {
    const host = new URL(`http://${domain}`).hostname;
    return /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function asciiDomains(list) {
  const out = [];
  for (const d of list) {
    const a = asciiDomain(d);
    if (!a) return null;
    out.push(a);
  }
  return out;
}

/** One network filter → a DNR rule (without id), or null when it can't be expressed. */
export function filterToRule(f) {
  const condition = {};
  if (f.requestDomain && f.pattern === `||${f.requestDomain}^`) {
    const d = asciiDomain(f.requestDomain);
    if (!d) return null;
    condition.requestDomains = [d];
  } else {
    if (!/^[\x20-\x7e]+$/.test(f.pattern) || f.pattern.startsWith("||*")) return null;
    condition.urlFilter = f.pattern;
  }
  if (f.matchCase) condition.isUrlFilterCaseSensitive = true;
  if (f.types.length) {
    condition.resourceTypes = [...new Set(f.types.map((t) => TYPE_MAP[t]))];
  } else if (f.excludedTypes.length) {
    // An explicit exclusion list replaces DNR's default exclusion of main_frame: keep it excluded.
    condition.excludedResourceTypes = [...new Set([...f.excludedTypes.map((t) => TYPE_MAP[t]), "main_frame"])];
  }
  if (f.party) condition.domainType = f.party === "third" ? "thirdParty" : "firstParty";
  if (f.pageDomains) {
    const inc = asciiDomains(f.pageDomains.include);
    const exc = asciiDomains(f.pageDomains.exclude);
    if (!inc || !exc) return null;
    if (inc.length) condition.initiatorDomains = inc;
    if (exc.length) condition.excludedInitiatorDomains = exc;
  }
  if (f.to) {
    // `||a.com^$to=b.com` would need AND semantics DNR can't express in requestDomains.
    if (condition.requestDomains) return null;
    const inc = asciiDomains(f.to.include);
    const exc = asciiDomains(f.to.exclude);
    if (!inc || !exc) return null;
    if (inc.length) condition.requestDomains = [...(condition.requestDomains || []), ...inc];
    if (exc.length) condition.excludedRequestDomains = exc;
  }
  const allow = f.exception;
  return {
    priority: allow ? PRIORITY.allow : f.important ? PRIORITY.important : PRIORITY.block,
    action: { type: allow ? "allow" : "block" },
    condition,
  };
}

/**
 * Parsed list → { rules, skipped }. Plain blocked domains are batched into `requestDomains`
 * rules (DOMAINS_PER_RULE each), which keeps domain-heavy lists far below Chromium's rule limits.
 * Ids start at `firstId`.
 */
export function listToRules(parsed, firstId = 1) {
  const rules = [];
  let skipped = 0;
  // Domain-only rules (`||a.com^…`) that differ only in their domain are merged: the key is the
  // rule without its single requestDomain. Lists like AdGuard Tracking Protection are mostly these.
  const byShape = new Map();
  const merge = (rule) => {
    const { requestDomains: [domain], ...rest } = rule.condition;
    const key = JSON.stringify([rule.priority, rule.action, rest]);
    if (!byShape.has(key)) byShape.set(key, { rule: { ...rule, condition: rest }, domains: new Set() });
    byShape.get(key).domains.add(domain);
  };
  for (const h of parsed.hosts) {
    const a = asciiDomain(h);
    if (a) merge({ priority: PRIORITY.block, action: { type: "block" }, condition: { requestDomains: [a] } });
    else skipped++;
  }
  const single = [];
  for (const f of [...parsed.network, ...parsed.exceptions]) {
    const rule = filterToRule(f);
    if (!rule) skipped++;
    else if (rule.condition.requestDomains?.length === 1 && !rule.condition.urlFilter && !rule.condition.excludedRequestDomains) merge(rule);
    else single.push(rule);
  }
  let id = firstId;
  for (const { rule, domains } of byShape.values()) {
    const list = [...domains];
    for (let i = 0; i < list.length; i += DOMAINS_PER_RULE) {
      rules.push({ id: id++, ...rule, condition: { requestDomains: list.slice(i, i + DOMAINS_PER_RULE), ...rule.condition } });
    }
  }
  for (const rule of single) rules.push({ id: id++, ...rule });
  return { rules, skipped };
}

/** Rule that turns PrivaBlock off for a whole site (every request made by its pages). */
export function siteDisabledRule(id, site) {
  return {
    id,
    priority: PRIORITY.siteDisabled,
    action: { type: "allowAllRequests" },
    condition: { requestDomains: [site], resourceTypes: ["main_frame", "sub_frame"] },
  };
}
