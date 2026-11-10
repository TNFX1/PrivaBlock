// Firefox smoke test: a throwaway headless profile, the built extension installed over WebDriver BiDi,
// a local test page with real ad/tracker URLs, and screenshots of the UI pages.
//   npm run build && node tests/browser/firefox-smoke.mjs [--dark] [--shots DIR]
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { quillCount } from "../../src/core/quills.js";

const root = new URL("../..", import.meta.url).pathname;
const dark = process.argv.includes("--dark");
const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const UUID = "6f1b7c2e-0b9a-4c55-9a3e-5e2b4d1c0a01";
const BASE = `moz-extension://${UUID}`;
const PORT = 9333;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
};

// ---- test page -------------------------------------------------------------------------------
const PAGE = `<!doctype html><title>t</title>
<div class="pb-hide-me">cosmetic target</div>
<script>
window.results = {};
function probe(name, tag, url) {
  const el = document.createElement(tag);
  el.onload = () => (results[name] = "loaded");
  el.onerror = () => (results[name] = "blocked");
  el.src = url;
  document.body.appendChild(el);
}
probe("googleAnalytics", "script", "https://www.google-analytics.com/analytics.js");
probe("doubleclick", "script", "https://securepubads.g.doubleclick.net/tag/js/gpt.js");
probe("firstPartyImage", "img", "/pixel.png");
</script>`;
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const server = createServer((req, res) => {
  if (req.url === "/pixel.png") return res.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
  if (req.url === "/empty") return res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>e</title>nothing to block");
  res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ---- Firefox ---------------------------------------------------------------------------------
const profile = await mkdtemp(`${tmpdir()}/pb-ff-`);
await writeFile(`${profile}/user.js`, [
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ "@privablock": UUID }))});`,
  `user_pref("ui.systemUsesDarkTheme", ${dark ? 1 : 0});`,
  `user_pref("browser.shell.checkDefaultBrowser", false);`,
  `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
].join("\n"));
const ff = spawn("firefox", ["--headless", "--no-remote", "--profile", profile, `--remote-debugging-port=${PORT}`], { stdio: "ignore", env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } });

const ws = await (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
      await new Promise((ok, bad) => { sock.onopen = ok; sock.onerror = bad; });
      return sock;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Firefox remote protocol not reachable");
})();
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function bidi(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, bad) => pending.set(id, (msg) => (msg.type === "error" ? bad(new Error(`${method}: ${msg.error} ${msg.message}`)) : ok(msg.result))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await bidi("session.new", { capabilities: { alwaysMatch: { webSocketUrl: true } } });
  await bidi("webExtension.install", { extensionData: { type: "path", path: `${root}dist/firefox` } });
  const { context } = await bidi("browsingContext.create", { type: "tab" });
  await bidi("browsingContext.setViewport", { context, viewport: { width: 900, height: 900 } });
  const go = (url) => bidi("browsingContext.navigate", { context, url, wait: "complete" });
  const evaluate = async (expression, ctx = context) => (await bidi("script.evaluate", { expression, target: { context: ctx }, awaitPromise: true, resultOwnership: "none" })).result;
  const send = (type, data = {}, ctx = context) => evaluate(`browser.runtime.sendMessage(${JSON.stringify({ type, ...data })}).then(r => JSON.stringify(r))`, ctx).then((r) => JSON.parse(r.value));

  // Wait until the filter lists are downloaded and compiled.
  await go(`${BASE}/ui/settings.html`);
  let settings;
  for (let i = 0; i < 120; i++) {
    settings = await send("getSettings");
    if (settings.ruleCount > 1000 && !settings.loading) break;
    await sleep(1000);
  }
  check("filter lists load", settings.ruleCount > 1000, settings.ruleCount);
  check("balanced profile is the default", settings.profile === "balanced");
  check("fingerprint protection is off by default", settings.fingerprint === false);

  // The popup and settings page re-render straight after a change: the reply must already reflect it.
  await send("setSiteEnabled", { site: "example.com", enabled: false });
  const afterSwitch = await send("getSettings");
  check("site switch is visible as soon as it returns", afterSwitch.disabledSites.includes("example.com"), JSON.stringify(afterSwitch.disabledSites));
  await send("setSiteEnabled", { site: "example.com", enabled: true });

  // A change made while the lists are rebuilding must still be applied (not dropped).
  await send("setList", { id: "easyAnnoyances", enabled: true });
  await send("saveMyFilters", { text: "127.0.0.1##.pb-hide-me" });
  for (let i = 0; i < 120 && (await send("getSettings")).loading; i++) await sleep(1000);
  const afterRebuild = await send("getSettings");
  check("change during a rebuild is applied", afterRebuild.lists.easyAnnoyances?.ok && afterRebuild.lists.user?.cosmetic === 1, JSON.stringify(afterRebuild.lists.user));
  await send("setList", { id: "easyAnnoyances", enabled: false });
  for (let i = 0; i < 120 && (await send("getSettings")).loading; i++) await sleep(1000);

  await go(pageUrl);
  await sleep(2500);
  const probes = JSON.parse((await evaluate("JSON.stringify(window.results)")).value);
  check("Google Analytics blocked", probes.googleAnalytics === "blocked", probes.googleAnalytics);
  check("DoubleClick blocked", probes.doubleclick === "blocked", probes.doubleclick);
  check("first-party image allowed", probes.firstPartyImage === "loaded", probes.firstPartyImage);
  const hidden = (await evaluate("getComputedStyle(document.querySelector('.pb-hide-me')).display")).value;
  check("cosmetic rule from My filters hides the element", hidden === "none", hidden);

  // The popup in a background tab: the test tab stays active, so getStats and the popup describe it.
  const { context: popup } = await bidi("browsingContext.create", { type: "tab", background: true });
  await bidi("browsingContext.setViewport", { context: popup, viewport: { width: 290, height: 420 } });
  await bidi("browsingContext.navigate", { context: popup, url: `${BASE}/ui/popup.html`, wait: "complete" });
  const stats = await send("getStats", {}, popup);
  check("popup stats describe the test tab", stats.site === "127.0.0.1" && stats.pageBlocked >= 2, JSON.stringify(stats));
  const testTab = (await evaluate(`browser.tabs.query({}).then((tabs) => tabs.find((t) => t.url.startsWith(${JSON.stringify(pageUrl)})).id)`, popup)).value;
  const badge = async () => (await evaluate(`browser.browserAction.getBadgeText({ tabId: ${testTab} })`, popup)).value;

  await send("setShowBadge", { enabled: false }, popup);
  const badgeOff = (await send("getSettings", {}, popup)).showBadge;
  const textOff = await badge();
  check("badge setting off round-trips and clears the badge", badgeOff === false && textOff === "", JSON.stringify({ badgeOff, textOff }));
  await send("setShowBadge", { enabled: true }, popup);
  const badgeOn = (await send("getSettings", {}, popup)).showBadge;
  const textOn = await badge();
  check("badge setting on round-trips and shows the count", badgeOn === true && textOn !== "", JSON.stringify({ badgeOn, textOn }));

  const popupView = async () => {
    await sleep(2000); // the popup refreshes once a second
    return JSON.parse((await evaluate(`JSON.stringify({ state: document.body.dataset.state, site: document.getElementById("site").textContent })`, popup)).value);
  };
  await send("setSiteEnabled", { site: "127.0.0.1", enabled: false }, popup);
  const viewOff = await popupView();
  const textSiteOff = await badge();
  await send("setSiteEnabled", { site: "127.0.0.1", enabled: true }, popup);
  const viewOn = await popupView();
  const textSiteOn = await badge();
  const drawn = JSON.parse((await evaluate(`JSON.stringify({ quills: document.querySelectorAll("#quills polygon").length, count: document.getElementById("count").textContent })`, popup)).value);
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    const { data } = await bidi("browsingContext.captureScreenshot", { context: popup, origin: "document" });
    await writeFile(`${shotsDir}/firefox-popup-site-${dark ? "dark" : "light"}.png`, Buffer.from(data, "base64"));
  }
  check("site disabled: the popup shows the test site as off", viewOff.state === "off" && viewOff.site === "127.0.0.1" && viewOn.state === "on", JSON.stringify({ viewOff, viewOn }));
  check("site switched off without a reload: the badge is empty, and comes back", textSiteOff === "" && textSiteOn !== "", JSON.stringify({ textSiteOff, textSiteOn }));
  check("the popup draws one quill per blocked request in the current row", Number(drawn.count) > 0 && drawn.quills === quillCount(Number(drawn.count)), JSON.stringify(drawn));

  await go(`${pageUrl}empty`);
  await sleep(1000);
  const empty = await send("getStats", {}, popup);
  check("a page with nothing blocked counts zero", empty.pageBlocked === 0, JSON.stringify(empty));
  await bidi("browsingContext.close", { context: popup });

  // Per-site switch: turned off → the same page loads the trackers.
  await go(`${BASE}/ui/settings.html`);
  await send("setSiteEnabled", { site: "127.0.0.1", enabled: false });
  await go(pageUrl);
  await sleep(2500);
  const off = JSON.parse((await evaluate("JSON.stringify(window.results)")).value);
  check("site switch off: trackers load again", off.googleAnalytics === "loaded", off.googleAnalytics);
  await go(`${BASE}/ui/settings.html`);
  await send("setSiteEnabled", { site: "127.0.0.1", enabled: true });

  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    const theme = dark ? "dark" : "light";
    for (const [name, url, w, h] of [["settings", `${BASE}/ui/settings.html`, 900, 1400], ["popup", `${BASE}/ui/popup.html`, 290, 420]]) {
      await go(pageUrl); // the viewport can't be set while an extension page is shown
      await bidi("browsingContext.setViewport", { context, viewport: { width: w, height: h } });
      await go(url);
      await sleep(800);
      const { data } = await bidi("browsingContext.captureScreenshot", { context, origin: "document" });
      await writeFile(`${shotsDir}/firefox-${name}-${theme}.png`, Buffer.from(data, "base64"));
    }
    console.log(`screenshots in ${shotsDir}`);
  }
} catch (error) {
  check("test run", false, error.message);
} finally {
  ws.close();
  ff.kill();
  server.close();
  await sleep(500);
  await rm(profile, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
