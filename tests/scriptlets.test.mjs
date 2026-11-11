// The page-world scriptlets (src/content/scriptlets-main.js) run in a Node vm context that stands in for a
// page: window is the context's global, document is a stub, fetch answers from a table.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { parseScriptletCall } from "../src/core/scriptlets.js";

const CODE = readFileSync(new URL("../src/content/scriptlets-main.js", import.meta.url), "utf8");

/** A fresh "page" that has run the given filter calls (`+js(...)` bodies, as a trusted list). */
function page(bodies, responses = {}) {
  const calls = bodies.map((b) => parseScriptletCall(b, true));
  for (const [i, c] of calls.entries()) assert.ok(c, `not parsed: ${bodies[i]}`);
  const attrs = { "data-privablock-sl": JSON.stringify(calls) };
  const ctx = vm.createContext({
    Response, Request, Headers, setTimeout, structuredClone,
    document: {
      documentElement: { getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] },
      addEventListener() {}, getElementById: () => null, readyState: "complete", cookie: "",
    },
    fetch: async (input) => new Response(responses[input instanceof Request ? input.url : String(input)] ?? "{}"),
  });
  vm.runInContext("globalThis.window = globalThis; globalThis.addEventListener = () => {};", ctx);
  vm.runInContext(CODE, ctx);
  return (code) => vm.runInContext(code, ctx);
}

test("json-prune: [-] removes the array item holding the path", () => {
  const run = page(["json-prune, entries.[-].command.isAd"]);
  const out = run(`JSON.stringify(JSON.parse('{"entries":[{"command":{"isAd":true}},{"command":{"v":1}},{"command":{"isAd":1}}]}'))`);
  assert.equal(out, '{"entries":[{"command":{"v":1}}]}');
});

test("json-edit-fetch-response: legacy jsonq removes matching items, only for matching URLs", async () => {
  const body = JSON.stringify({ a: { itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, { video: 1 }] } } });
  const run = page(["json-edit-fetch-response, ..itemSectionRenderer.contents.*[?.adSlotRenderer], propsToMatch, /get_watch"], { "https://y/get_watch?x": body, "https://y/other": body });
  const hit = await run(`fetch("https://y/get_watch?x").then((r) => r.text())`);
  const miss = await run(`fetch("https://y/other").then((r) => r.text())`);
  assert.equal(hit, '{"a":{"itemSectionRenderer":{"contents":[{"video":1}]}}}');
  assert.equal(miss, body);
});

test("json-prune-fetch-response with propsToMatch on a Request", async () => {
  const body = JSON.stringify({ adPlacements: [1], videoDetails: { id: "x" } });
  const run = page(["json-prune-fetch-response, adPlacements adSlots, , propsToMatch, /\\/player(\\?|$)/"], { "https://y/youtubei/v1/player?k=1": body });
  const out = await run(`fetch(new Request("https://y/youtubei/v1/player?k=1", { method: "POST", body: "{}" })).then((r) => r.json())`);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { videoDetails: { id: "x" } });
});

test("trusted-rpfr replaces text in matching responses", async () => {
  const run = page([`trusted-rpfr, '"adPlacements"', '"no_ads"', player?`], { "https://y/player?a": '{"adPlacements":[1]}' });
  assert.equal(await run(`fetch("https://y/player?a").then((r) => r.text())`), '{"no_ads":[1]}');
});

test("trusted-edit-inbound-object: filters, +=, repl and ${now} on a copy", () => {
  const run = page([
    `trusted-edit-inbound-object, JSON.stringify, 0, [?.attestationRequest][?.context.client.userAgent*="channel"].context.client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}`,
    `trusted-edit-inbound-object, JSON.stringify, 0, [?.attestationRequest][?.context.client.userAgent=/channel|inline/].playbackContext.lactMilliseconds="\${now}"`,
    `trusted-edit-inbound-object, JSON.stringify, 0, [?.attestationRequest].playbackContext.referer=repl({"regex":"(?:#reloadxhr)?$"\\,"replacement":"#reloadxhr"})`,
  ]);
  const out = JSON.parse(run(`
    window.req = { attestationRequest: {}, context: { client: { clientName: "WEB", userAgent: "Mozilla; channel" } }, playbackContext: { referer: "https://y/watch", lactMilliseconds: "-1" } };
    JSON.stringify(req)`));
  assert.equal(out.context.client.clientScreen, "CHANNEL");
  assert.match(out.playbackContext.lactMilliseconds, /^\d{13}$/);
  assert.equal(out.playbackContext.referer, "https://y/watch#reloadxhr");
  assert.equal(run("req.context.client.clientScreen"), undefined); // the page's own object is left alone
  const other = JSON.parse(run(`JSON.stringify({ context: { client: { clientName: "WEB", userAgent: "channel" } } })`));
  assert.equal(other.context.client.clientScreen, undefined); // no attestationRequest: not touched
  // as uBO, an assignment never creates a property that isn't there
  const noLact = JSON.parse(run(`JSON.stringify({ attestationRequest: {}, context: { client: { userAgent: "inline" } }, playbackContext: {} })`));
  assert.equal(noLact.playbackContext.lactMilliseconds, undefined);
});

test("assignments need a trusted list; untrusted json-edit only removes", () => {
  assert.equal(parseScriptletCall("trusted-edit-inbound-object, JSON.stringify, 0, .a=1"), null);
  assert.equal(parseScriptletCall("rpnt, script, x"), null);
  const run = page(["json-edit, .a=1", "json-edit, .b"]); // listed trusted here, but json-edit never assigns
  assert.equal(run(`JSON.stringify(JSON.parse('{"a":0,"b":2}'))`), '{"a":0}');
});

test("set-constant: several chains through the same root all apply", () => {
  const run = page(["set, yt.adSlots, undefined", "set, yt.adPlacements, undefined", "set, yt.playerAds, undefined"]);
  assert.equal(run(`var yt = { adPlacements: [1], adSlots: [2], playerAds: [3], videoDetails: 4 }; JSON.stringify(yt)`), '{"videoDetails":4}');
});

test("jsonq like uBO: a filter on an array picks its items; += appends to arrays", () => {
  const run = page(["json-edit, .items[?.ad==true]", `trusted-json-edit, .list+=["x"]`]);
  assert.equal(run(`JSON.stringify(JSON.parse('{"items":[{"ad":true},{"ad":false},{"v":1}]}'))`), '{"items":[{"ad":false},{"v":1}]}');
  assert.equal(run(`JSON.stringify(JSON.parse('{"list":["a"]}'))`), '{"list":["a","x"]}');
});

test("wrapped functions still look native", () => {
  const run = page(["json-prune, ads"]);
  assert.match(run("Function.prototype.toString.call(JSON.parse)"), /^function parse\(\) \{\s*\[native code\]\s*\}$/);
  assert.match(run("JSON.parse.toString()"), /\[native code\]/);
  assert.equal(run("JSON.parse.name"), "parse");
});

test("anti-adblock defusers: nobab skips BlockAdBlock code, nofab and popads-dummy fake the libraries", () => {
  const run = page(["nobab", "nofab", "popads-dummy"]);
  assert.equal(run(`window.ran = false; eval("window.ran = true; /* blockadblock */"); String(window.ran)`), "false");
  assert.equal(run(`eval("1 + 1")`), 2);
  assert.equal(run(`let said = ""; fuckAdBlock.onDetected(() => (said = "blocked")); typeof FuckAdBlock + typeof blockAdBlock.check`), "functionfunction");
  assert.equal(run(`JSON.stringify([typeof PopAds, popns])`), '["object","PopAds"]');
});
