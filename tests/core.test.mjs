import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOf, sameSite } from "../src/core/psl.js";
import { parseList, parseNetworkFilter } from "../src/core/filters.js";
import { Engine, patternToken } from "../src/core/engine.js";
import { listToRules, filterToRule } from "../src/core/dnr.js";
import { enabledLists, PROFILES } from "../src/core/lists.js";

const engineFor = (text) => {
  const e = new Engine();
  e.add(parseList(text, "test"));
  return e;
};
const req = (url, page, type = "script") => ({ url, requestHost: new URL(url).hostname, pageHost: page, type });

test("sites follow the Public Suffix List", () => {
  assert.equal(siteOf("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteOf("haber.example.com.tr"), "example.com.tr");
  assert.equal(siteOf("a.github.io"), "a.github.io");
  assert.equal(siteOf("x.y.ck"), "x.y.ck"); // *.ck
  assert.equal(siteOf("www.ck"), "www.ck"); // !www.ck
  assert.equal(siteOf("192.168.1.10"), "192.168.1.10");
  assert.equal(sameSite("bbc.co.uk", "gov.co.uk"), false);
  assert.equal(sameSite("cdn.example.com.tr", "www.example.com.tr"), true);
});

test("$third-party distinguishes .com.tr sites", () => {
  const e = engineFor("||tracker.com.tr^$third-party");
  assert.equal(e.match(req("https://tracker.com.tr/t.js", "news.example.com.tr")).block, true);
  assert.equal(e.match(req("https://tracker.com.tr/t.js", "www.tracker.com.tr")).block, false);
});

test("exceptions beat blocks, $important beats exceptions", () => {
  const e = engineFor(["||ads.example.com^", "@@||ads.example.com/ok.js", "||evil.example^$important", "@@||evil.example^"].join("\n"));
  assert.equal(e.match(req("https://ads.example.com/x.js", "site.org")).block, true);
  assert.equal(e.match(req("https://ads.example.com/ok.js", "site.org")).block, false);
  assert.equal(e.match(req("https://evil.example/x.js", "site.org")).block, true);
});

test("types, domain= and hosts files", () => {
  const e = engineFor(["/banner/*$image,domain=news.com|~sports.news.com", "0.0.0.0 tracker.net # comment"].join("\n"));
  assert.equal(e.match(req("https://cdn.org/banner/a.png", "news.com", "image")).block, true);
  assert.equal(e.match(req("https://cdn.org/banner/a.png", "news.com", "script")).block, false);
  assert.equal(e.match(req("https://cdn.org/banner/a.png", "sports.news.com", "image")).block, false);
  assert.equal(e.match(req("https://sub.tracker.net/p", "x.com")).block, true);
});

test("token index only uses whole tokens (no misses next to * or edges)", () => {
  assert.equal(patternToken("ad*banner"), "");
  assert.equal(patternToken("/ads/banner."), "banner");
  assert.equal(patternToken("||doubleclick.net^"), "doubleclick");
  const e = engineFor("ad*banner");
  assert.equal(e.match(req("https://x.com/adsbanner.js", "y.com")).block, true);
});

test("bare host names are host filters (uBlock Origin semantics)", () => {
  assert.equal(parseNetworkFilter("email.shop.example.com$image", "t").pattern, "||email.shop.example.com^");
  assert.equal(parseNetworkFilter("ads.js", "t").pattern, "ads.js"); // a file name, not a host
  const { rules } = listToRules(parseList("a.tracker.com$image\nb.tracker.com$image", "t"));
  assert.deepEqual(rules, [{ id: 1, priority: 1, action: { type: "block" }, condition: { requestDomains: ["a.tracker.com", "b.tracker.com"], resourceTypes: ["image"] } }]);
});

test("regex filters and unknown options are skipped, not misapplied", () => {
  assert.equal(parseNetworkFilter("/ad[0-9]+/", "t"), null);
  assert.equal(parseNetworkFilter("||x.com^$redirect=noop.js", "t"), null);
  const p = parseList("/ad[0-9]+/\n||x.com^$removeparam=utm\n##.generic\nexample.com##+js(nobab)", "t");
  assert.equal(p.unsupported, 4);
});

test("cosmetic: host exclusions and #@# exceptions", () => {
  const e = engineFor(["example.com,~shop.example.com##.ad", "example.com##.promo", "blog.example.com#@#.promo"].join("\n"));
  assert.deepEqual(e.cosmeticFor("www.example.com").sort(), [".ad", ".promo"]);
  assert.deepEqual(e.cosmeticFor("shop.example.com"), [".promo"]);
  assert.deepEqual(e.cosmeticFor("blog.example.com"), [".ad"]);
  assert.deepEqual(e.cosmeticFor("other.org"), []);
});

test("DNR: domains are batched, options map, priorities order", () => {
  const p = parseList(["||a.com^", "||b.com^", "0.0.0.0 c.com", "||d.com/x.js$script,third-party,domain=e.com|~f.e.com", "@@||g.com^$image", "||h.com^$important"].join("\n"), "t");
  const { rules, skipped } = listToRules(p, 10);
  assert.equal(skipped, 0);
  assert.deepEqual(rules[0], { id: 10, priority: 1, action: { type: "block" }, condition: { requestDomains: ["a.com", "b.com", "c.com"] } });
  const d = rules.find((r) => r.condition.urlFilter === "||d.com/x.js");
  assert.deepEqual(d.condition, { urlFilter: "||d.com/x.js", resourceTypes: ["script"], domainType: "thirdParty", initiatorDomains: ["e.com"], excludedInitiatorDomains: ["f.e.com"] });
  const allow = rules.find((r) => r.action.type === "allow");
  assert.equal(allow.priority, 2);
  assert.deepEqual(allow.condition, { requestDomains: ["g.com"], resourceTypes: ["image"] });
  assert.equal(rules.find((r) => r.condition.requestDomains?.[0] === "h.com").priority, 3);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
});

test("DNR: excluded types keep main_frame excluded; non-ASCII skipped", () => {
  assert.deepEqual(filterToRule(parseNetworkFilter("/track/*$~image", "t")).condition.excludedResourceTypes, ["image", "main_frame"]);
  assert.equal(filterToRule(parseNetworkFilter("/reklamı.js", "t")), null);
});

test("profiles and per-list overrides", () => {
  assert.deepEqual(enabledLists("light"), PROFILES.light);
  assert.ok(enabledLists("balanced", { easyCookie: true }).includes("easyCookie"));
  assert.ok(!enabledLists("strict", { adguard: false }).includes("adguard"));
});
