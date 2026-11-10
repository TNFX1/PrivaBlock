// Chromium smoke test: a throwaway profile of a Chromium browser with the built MV3 extension loaded,
// driven over the DevTools protocol. Same checks as the Firefox test, plus a Turkish UI screenshot.
//   npm run build && node tests/browser/chromium-smoke.mjs [--browser helium-browser] [--dark] [--lang tr] [--shots DIR]
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { quillCount } from "../../src/core/quills.js";

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
// 30 blocked requests on one page: more than a quill row (23), and more getStats calls than Chromium's
// getMatchedRules quota (20 per 10 minutes) are made against it below.
const MANY = `<!doctype html><title>many</title><script>
window.done = 0;
const one = (i) => new Promise((ok) => { const s = document.createElement("script"); s.onload = s.onerror = () => ok(done++); s.src = "https://www.google-analytics.com/analytics.js?n=" + i; document.head.appendChild(s); });
window.more = (k) => Promise.all(Array.from({ length: k }, () => one(done + Math.random())));
more(30);
</script>`;
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const server = createServer((req, res) => {
  if (req.url === "/pixel.png") return res.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
  res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/many" ? MANY : PAGE);
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
    // shortcut: the first navigation from an extension page to the test page can come back net::ERR_ABORTED
    // (cause not found); one retry loads it. Drop the retry once that abort is understood.
    const first = (await page.call("Page.navigate", { url })).errorText;
    if (first) {
      console.log(`retry  navigation to ${url} returned ${first}; trying once more`);
      await sleep(1000);
      const second = (await page.call("Page.navigate", { url })).errorText;
      if (second) throw new Error(`navigation to ${url} failed twice: ${second}`);
    }
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
  let probes;
  for (let i = 0; i < 50 && Object.keys((probes = await evaluate("window.results")) || {}).length < 3; i++) await sleep(200);
  if (Object.keys(probes || {}).length < 3) throw new Error(`test page probes not finished after 10 s: ${JSON.stringify(probes)}`);
  check("Google Analytics blocked", probes.googleAnalytics === "blocked", probes.googleAnalytics);
  check("DoubleClick blocked", probes.doubleclick === "blocked", probes.doubleclick);
  check("first-party image allowed", probes.firstPartyImage === "loaded", probes.firstPartyImage);
  check("cosmetic rule from My filters hides the element", (await evaluate("getComputedStyle(document.querySelector('.pb-hide-me')).display")) === "none");

  // The popup's "blocked on this page" count, asked from an extension page about the test tab.
  const statsTarget = await json(`/json/new?${BASE}/ui/settings.html`, "PUT");
  const statsPage = await connect(statsTarget.webSocketDebuggerUrl);
  await sleep(1500);
  const evalIn = async (cdp, expression) => (await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  const sendIn = (cdp, type, data = {}) => evalIn(cdp, `chrome.runtime.sendMessage(${JSON.stringify({ type, ...data })})`);
  const stats = await evalIn(statsPage, `(async () => { const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(`${pageUrl}*`)} }); return chrome.runtime.sendMessage({ type: "getStats", tabId: tab.id }); })()`);
  check("popup counts blocked requests on the page", stats?.pageBlocked >= 2, JSON.stringify(stats));

  // getBadgeText can't read Chromium's automatic count, so read the option Chromium saves in the profile
  // (it writes Preferences about 10 s after a change).
  const countOption = async (want) => {
    let v;
    for (let i = 0; i < 30; i++) {
      v = (await readFile(`${profile}/Default/Preferences`, "utf8").catch(() => "")).match(/"dnr_use_action_count_as_badge_text":\s*(true|false)/)?.[1];
      if (v === want) break;
      await sleep(1000);
    }
    return v;
  };
  const optionAtStart = await countOption("true");
  await sendIn(statsPage, "setShowBadge", { enabled: false });
  const badgeOff = (await sendIn(statsPage, "getSettings")).showBadge;
  const optionOff = await countOption("false");
  await sendIn(statsPage, "setShowBadge", { enabled: true });
  const badgeOn = (await sendIn(statsPage, "getSettings")).showBadge;
  const optionOn = await countOption("true");
  check("badge setting round-trips", badgeOff === false && badgeOn === true, JSON.stringify({ badgeOff, badgeOn }));
  check("Chromium's toolbar count is on at start and follows the setting", optionAtStart === "true" && optionOff === "false" && optionOn === "true", JSON.stringify({ optionAtStart, optionOff, optionOn }));

  // The real popup page reads the active tab: open it in its own tab, then bring the test tab to the front.
  const popupTarget = await json(`/json/new?${BASE}/ui/popup.html`, "PUT");
  const popup = await connect(popupTarget.webSocketDebuggerUrl);
  await page.call("Page.bringToFront");
  const popupView = async () => {
    await sleep(2000); // the popup refreshes once a second
    return evalIn(popup, `({ state: document.body.dataset.state, site: document.getElementById("site").textContent })`);
  };
  await sendIn(statsPage, "setSiteEnabled", { site: "127.0.0.1", enabled: false });
  const viewOff = await popupView();
  await sendIn(statsPage, "setSiteEnabled", { site: "127.0.0.1", enabled: true });
  const viewOn = await popupView();
  const drawn = await evalIn(popup, `({ quills: document.querySelectorAll("#quills polygon").length, count: document.getElementById("count").textContent })`);
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await popup.call("Emulation.setDeviceMetricsOverride", { width: 290, height: 400, deviceScaleFactor: 1, mobile: false });
    if (dark) await popup.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(500);
    const { data } = await popup.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(`${shotsDir}/chromium-popup-site-${lang}-${dark ? "dark" : "light"}.png`, Buffer.from(data, "base64"));
  }
  check("site disabled: the popup shows the test site as off", viewOff?.state === "off" && viewOff.site === "127.0.0.1" && viewOn?.state === "on", JSON.stringify({ viewOff, viewOn }));
  check("the popup draws one quill per blocked request in the current row", Number(drawn?.count) > 0 && drawn.quills === quillCount(Number(drawn.count)), JSON.stringify(drawn));
  popup.close();
  await json(`/json/close/${popupTarget.id}`).catch(() => {});

  // The open popup asks once a second; past 20 asks Chromium refuses getMatchedRules for 10 minutes,
  // and the count must not fall back to 0 then.
  await go(`${pageUrl}many`);
  for (let i = 0; i < 50 && (await evaluate("window.done")) < 30; i++) await sleep(200);
  const manyTab = await evalIn(statsPage, `chrome.tabs.query({ url: ${JSON.stringify(`${pageUrl}many`)} }).then(([t]) => t.id)`);
  const asked = [];
  for (let i = 0; i < 25; i++) asked.push((await sendIn(statsPage, "getStats", { tabId: manyTab }))?.pageBlocked);
  check("the page count keeps counting past a quill row and past 20 asks", asked.every((n) => n === 30), JSON.stringify(asked));

  // New blocks on an open page show on the next ask, without waiting for getMatchedRules.
  await evaluate("more(5)");
  await sleep(1000);
  const live = (await sendIn(statsPage, "getStats", { tabId: manyTab }))?.pageBlocked;
  check("the page count rises live as more requests are blocked", live === 35, live);

  // The count survives the service worker going to sleep (read from storage.session, so a woken worker
  // re-counting from getMatchedRules can't pass for it), and a block wakes the worker to count.
  const stored = () => evalIn(statsPage, `chrome.storage.session.get("tabCounts").then((r) => r.tabCounts?.[${manyTab}]?.n ?? null)`);
  const storedBefore = await stored();
  const workerUp = async () => (await json("/json/list")).some((t) => t.type === "service_worker" && t.url.startsWith(BASE));
  await page.call("ServiceWorker.enable");
  await page.call("ServiceWorker.stopAllWorkers");
  for (let i = 0; i < 20 && (await workerUp()); i++) await sleep(250);
  const stopped = !(await workerUp());
  await evaluate("more(5)");
  await sleep(1000);
  const woken = await workerUp();
  const storedAfter = await stored();
  const afterSleep = (await sendIn(statsPage, "getStats", { tabId: manyTab }))?.pageBlocked;
  check("a sleeping worker wakes on a block and keeps the count", storedBefore === 35 && stopped && woken && storedAfter === 40 && afterSleep === 40,
    JSON.stringify({ storedBefore, stopped, woken, storedAfter, afterSleep }));

  // A pushState navigation keeps the count (as Chromium's toolbar count does); a same-URL reload starts it again.
  await evaluate(`history.pushState({}, "", "/many?route")`);
  await sleep(1000);
  const afterPush = (await sendIn(statsPage, "getStats", { tabId: manyTab }))?.pageBlocked;
  check("a pushState navigation keeps the count", afterPush === 40, afterPush);
  await page.call("Page.navigate", { url: `${pageUrl}many` });
  await sleep(500);
  for (let i = 0; i < 50 && (await evaluate("window.done")) < 30; i++) await sleep(200);
  await page.call("Page.reload");
  await sleep(500);
  for (let i = 0; i < 50 && (await evaluate("window.done")) < 30; i++) await sleep(200);
  const afterReload = (await sendIn(statsPage, "getStats", { tabId: manyTab }))?.pageBlocked;
  check("a same-URL reload starts the count again", afterReload === 30, afterReload);
  statsPage.close();
  await json(`/json/close/${statsTarget.id}`).catch(() => {});

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
    for (const [name, url, width, height] of [["settings", `${BASE}/ui/settings.html`, 900, 1400], ["popup", `${BASE}/ui/popup.html`, 290, 400]]) {
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
