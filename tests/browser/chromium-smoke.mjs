// Chromium smoke test: a throwaway profile of a Chromium browser with the built MV3 extension loaded,
// driven over the DevTools protocol. Same checks as the Firefox test, plus a Turkish UI screenshot.
//   npm run build && node tests/browser/chromium-smoke.mjs [--browser helium-browser] [--dark] [--lang tr] [--shots DIR]
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

const root = new URL("../..", import.meta.url).pathname;
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const browserBin = arg("--browser", "helium-browser");
const lang = arg("--lang", "en");
const dark = process.argv.includes("--dark");
const shotsDir = arg("--shots", null);
const PORT = 9334;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== "" ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><title>t</title><div class="pb-hide-me">cosmetic target</div><script>
window.results = {};
function probe(name, tag, url) { const el = document.createElement(tag); el.onload = () => (results[name] = "loaded"); el.onerror = () => (results[name] = "blocked"); el.src = url; document.body.appendChild(el); }
probe("googleAnalytics", "script", "https://www.google-analytics.com/analytics.js");
probe("doubleclick", "script", "https://securepubads.g.doubleclick.net/tag/js/gpt.js");
probe("firstPartyImage", "img", "/pixel.png");
</script>`;
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const server = createServer((req, res) => {
  if (req.url === "/pixel.png") return res.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
  res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = await mkdtemp(`${tmpdir()}/pb-cr-`);
const browser = spawn(browserBin, [
  "--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--no-first-run",
  "--no-default-browser-check", `--load-extension=${root}dist/chromium`, `--lang=${lang}`,
  ...(dark ? ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"] : []), "about:blank",
], { stdio: "ignore", env: { ...process.env, LANGUAGE: lang } });

async function json(path, method = "GET") {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}${path}`, { method })).json();
    } catch {
      await sleep(500);
    }
  }
  throw new Error("DevTools endpoint not reachable");
}

/** Minimal CDP client for one target. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 1;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, bad } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
    }
  };
  const call = (method, params = {}) => new Promise((ok, bad) => {
    const n = id++;
    pending.set(n, { ok, bad });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { call, close: () => ws.close() };
}

try {
  let extId = "";
  for (let i = 0; i < 40 && !extId; i++) {
    const targets = await json("/json/list");
    const sw = targets.find((t) => t.type === "service_worker" && t.url.endsWith("/chromium/background.js"));
    extId = sw ? new URL(sw.url).host : "";
    if (!extId) await sleep(500);
  }
  check("extension service worker started", !!extId);
  const BASE = `chrome-extension://${extId}`;
  const target = await json(`/json/new?about:blank`, "PUT");
  const page = await connect(target.webSocketDebuggerUrl);
  await page.call("Page.enable");
  const go = async (url) => {
    await page.call("Page.navigate", { url });
    await sleep(1500);
  };
  const evaluate = async (expression) => (await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  const send = (type, data = {}) => evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...data })})`);

  await go(`${BASE}/ui/settings.html`);
  let settings;
  for (let i = 0; i < 30; i++) {
    settings = await send("getSettings");
    if (settings?.ruleCount > 1000) break;
    await sleep(1000);
  }
  check("bundled rulesets enabled", settings?.ruleCount > 1000, settings?.ruleCount);
  check("no static ruleset error", !settings?.staticError, settings?.staticError);
  check("balanced profile is the default", settings?.profile === "balanced");
  await send("saveMyFilters", { text: "127.0.0.1##.pb-hide-me" });

  await go(pageUrl);
  await sleep(2000);
  const probes = await evaluate("window.results");
  check("Google Analytics blocked", probes.googleAnalytics === "blocked", probes.googleAnalytics);
  check("DoubleClick blocked", probes.doubleclick === "blocked", probes.doubleclick);
  check("first-party image allowed", probes.firstPartyImage === "loaded", probes.firstPartyImage);
  check("cosmetic rule from My filters hides the element", (await evaluate("getComputedStyle(document.querySelector('.pb-hide-me')).display")) === "none");

  await go(`${BASE}/ui/settings.html`);
  await send("setSiteEnabled", { site: "127.0.0.1", enabled: false });
  await go(pageUrl);
  await sleep(2000);
  check("site switch off: trackers load again", (await evaluate("window.results.googleAnalytics")) === "loaded");
  await go(`${BASE}/ui/settings.html`);
  await send("setSiteEnabled", { site: "127.0.0.1", enabled: true });

  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    const tag = `${lang}-${dark ? "dark" : "light"}`;
    for (const [name, url, width, height] of [["settings", `${BASE}/ui/settings.html`, 900, 1400], ["popup", `${BASE}/ui/popup.html`, 330, 400]]) {
      await page.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      if (dark) await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
      await go(url);
      const { data } = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(`${shotsDir}/chromium-${name}-${tag}.png`, Buffer.from(data, "base64"));
    }
    console.log(`screenshots in ${shotsDir}`);
  }
  page.close();
} catch (error) {
  check("test run", false, error.message);
} finally {
  browser.kill();
  server.close();
  await sleep(800);
  await rm(profile, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
