import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOf, sameSite } from "../src/core/psl.js";
import { parseList, parseNetworkFilter } from "../src/core/filters.js";
import { Engine, patternToken } from "../src/core/engine.js";
import { listToRules, filterToRule } from "../src/core/dnr.js";
import { enabledLists, PROFILES } from "../src/core/lists.js";
import { quillCount, quillShape } from "../src/core/quills.js";
import { loadSettings, pickerFilter, withFilter, backupOf, backupValues } from "../src/core/runtime.js";
import { parseScriptletCall, scriptletData, scriptletShards, hostMatches } from "../src/core/scriptlets.js";
import { parseProcedural, isProcedural } from "../src/core/procedural.js";
import { parseCosmeticFilter } from "../src/core/filters.js";

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

test("quill row fills to 23 then starts again", () => {
  assert.deepEqual([0, 1, 22, 23, 24, 46, 47, 2300].map(quillCount), [0, 1, 22, 23, 1, 23, 1, 23]);
});

test("quillShape is stable and in range", () => {
  for (let i = 0; i < 23; i++) {
    const a = quillShape(i);
    assert.deepEqual(a, quillShape(i));
    assert.ok(a.h >= 11 && a.h <= 26 && a.lean >= 0.35 && a.lean <= 0.75);
  }
  assert.notEqual(quillShape(0).h, quillShape(1).h);
});

test("showBadge defaults on, also for 3.0.0 storage", async () => {
  const storage = (data) => ({ get: async () => data });
  assert.equal((await loadSettings(storage({}))).showBadge, true);
  assert.equal((await loadSettings(storage({ showBadge: false }))).showBadge, false);
});

test("scriptlet calls: aliases, escaped commas, quotes, unknown and trusted names", () => {
  assert.deepEqual(parseScriptletCall("set, a.b, true"), ["set-constant", "a.b", "true"]);
  assert.deepEqual(parseScriptletCall("acs, document.write, /ad\\,s/"), ["abort-current-script", "document.write", "/ad,s/"]);
  assert.deepEqual(parseScriptletCall("nostif.js, '1, 2', 500"), ["no-setTimeout-if", "1, 2", "500"]);
  assert.deepEqual(parseScriptletCall(""), []);
  assert.equal(parseScriptletCall("nobab"), null);
  assert.equal(parseScriptletCall("trusted-set-cookie, a, b"), null);
});

test("scriptlets: host scope, exclusions and #@#+js exceptions", () => {
  const e = engineFor(["example.com,~shop.example.com##+js(set, ads, false)", "example.com##+js(nowoif)", "blog.example.com#@#+js(nowoif)", "quiet.example.com#@#+js()", "##+js(nowoif)"].join("\n"));
  assert.deepEqual(e.scriptletsFor("www.example.com"), [["set-constant", "ads", "false"], ["no-window-open-if"]]);
  assert.deepEqual(e.scriptletsFor("shop.example.com"), [["no-window-open-if"]]);
  assert.deepEqual(e.scriptletsFor("blog.example.com"), [["set-constant", "ads", "false"]]);
  assert.deepEqual(e.scriptletsFor("quiet.example.com"), []);
  assert.deepEqual(e.scriptletsFor("other.org"), []); // the generic ##+js rule is not applied
});

test("scriptlet handoff data and shards keep every host and its exceptions", () => {
  const p = parseList(["a.com##+js(nowoif)", "b.a.com#@#+js(nowoif)", "c.org##+js(set, x, 1)"].join("\n"), "t");
  const data = scriptletData(p.scriptlets, p.scriptletExceptions);
  assert.deepEqual(Object.keys(data.h).sort(), ["a.com", "c.org"]);
  const shards = scriptletShards(data, 10);
  assert.equal(shards.length, 2);
  assert.deepEqual(shards[0].data.x, { "b.a.com": ['["no-window-open-if"]'] });
  assert.deepEqual(hostMatches(["a.com", "127.0.0.1", "google.*"]), ["*://*.a.com/*", "*://127.0.0.1/*"]);
});

test("procedural filters parse to tasks; plain CSS stays CSS", () => {
  assert.equal(isProcedural("div:has(> a):not(.x)"), false);
  assert.equal(parseCosmeticFilter("x.com##div:has(> a)", "t").procedural, undefined);
  assert.deepEqual(parseProcedural(".ad:has-text(Sponsored):upward(2)"), { tasks: [["css", ".ad"], ["has-text", "Sponsored"], ["upward", 2]], action: null });
  assert.deepEqual(parseProcedural("div:has(> span:-abp-contains(/Ad/i)) > a").tasks, [["css", "div"], ["has", [["css", "> span"], ["has-text", "/Ad/i"]]], ["spath", " > a"]]);
  assert.deepEqual(parseProcedural("div :has-text(x)").tasks, [["css", "div *"], ["has-text", "x"]]);
  assert.deepEqual(parseProcedural(".a:matches-css(before, content: /^Ad$/)").tasks[1], ["matches-css-before", "content", "/^Ad$/"]);
  assert.deepEqual(parseProcedural(".b:style(color: red)").action, ["style", "color: red"]);
  assert.deepEqual(parseProcedural(".b:remove()").action, ["remove"]);
  assert.equal(parseProcedural(".b:style(background: url(x))"), null);
  assert.equal(parseProcedural(".b:remove():has-text(x)"), null);
  assert.equal(parseProcedural(".b:others()"), null);
  assert.equal(parseCosmeticFilter("x.com##^script:has-text(ad)", "t"), null);
});

test("procedural rules and their exceptions in the engine", () => {
  const e = engineFor(["x.com##.ad:has-text(Ad)", "x.com##.plain", "y.x.com#@#.ad:has-text(Ad)"].join("\n"));
  assert.deepEqual(e.cosmeticFor("x.com"), [".plain"]);
  assert.equal(e.proceduralFor("x.com").length, 1);
  assert.deepEqual(e.proceduralFor("y.x.com"), []);
});

test("element picker rules: page host, one line, plain CSS only", () => {
  assert.equal(pickerFilter("https://www.x.com/a?b", "div.ad > span"), "www.x.com##div.ad > span");
  assert.equal(pickerFilter("https://x.com/", "a\n||evil.com^"), null);
  assert.equal(pickerFilter("https://x.com/", "+js(nowoif)"), null);
  assert.equal(pickerFilter("https://x.com/", ".a:has-text(b)"), null);
  assert.equal(pickerFilter("chrome://settings", ".a"), null);
  assert.equal(withFilter("a##.b\n", "a##.b"), "a##.b\n");
  assert.equal(withFilter("a##.b\n\n", "c##.d"), "a##.b\nc##.d");
  assert.equal(withFilter("", "c##.d"), "c##.d");
});

test("backups round-trip and reject anything else", () => {
  const settings = { profile: "strict", listOverrides: { easyCookie: true }, customLists: { custom_ab1: { id: "custom_ab1", name: "Mine", url: "https://e.com/l.txt", enabled: false } }, myFilters: "x##.y", disabledSites: ["a.com"], showBadge: false, fingerprint: true };
  const back = backupValues(JSON.parse(JSON.stringify(backupOf(settings))));
  assert.deepEqual(back, settings);
  assert.equal(backupValues({ profile: "strict" }), null);
  const hostile = backupValues({ app: "PrivaBlock", backup: 1, profile: "nope", listOverrides: { madeUp: true, easylist: "yes" }, customLists: { a: { id: "custom_x", url: "javascript:alert(1)" } }, disabledSites: ["<b>", "ok.com"] });
  assert.deepEqual(hostile, { listOverrides: {}, customLists: {}, disabledSites: ["ok.com"] });
});

test("trusted-only filters: $replace= and trusted scriptlets come from uBlock Origin's own lists only", () => {
  const text = ['||y.com/player?$xhr,1p,replace=/"adPlacements"/"no_ads"/', "y.com##+js(trusted-rpfr, a, b, player?)", "y.com##+js(rpnt, script, x, y)"].join("\n");
  const trusted = parseList(text, "ublockQuick");
  assert.equal(trusted.replacers.length, 1);
  assert.equal(trusted.scriptlets.length, 2);
  const e = new Engine();
  e.add(trusted);
  assert.equal(e.replacersFor({ url: "https://y.com/player?x=1", requestHost: "y.com", pageHost: "y.com", type: "xmlhttprequest" }).length, 1);
  assert.equal(e.replacersFor({ url: "https://y.com/player?x=1", requestHost: "y.com", pageHost: "y.com", type: "script" }).length, 0);
  for (const source of ["user", "custom_abc", "adguard"]) {
    const p = parseList(text, source);
    assert.equal(p.replacers.length + p.scriptlets.length, 0, source);
    assert.equal(p.unsupported, 3, source);
  }
});
