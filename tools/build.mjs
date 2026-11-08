// Build dist/firefox and dist/chromium from src/.
//   node tools/build.mjs [--offline] [firefox|chromium]
// Chromium: every list in src/core/lists.js is downloaded (cached in .cache/lists; --offline reuses
// the cache), converted to a static declarativeNetRequest ruleset and a cosmetic-rule file.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseList } from "../src/core/filters.js";
import { listToRules } from "../src/core/dnr.js";
import { LISTS, PROFILES, DEFAULT_PROFILE } from "../src/core/lists.js";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const browsers = args.filter((a) => !a.startsWith("--"));
const targets = browsers.length ? browsers : ["firefox", "chromium"];
const { version } = JSON.parse(await readFile(`${root}package.json`, "utf8"));

async function copySources(browser, out) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const dir of ["core", "content", "ui", "icons", "_locales", browser]) await cp(`${root}src/${dir}`, `${out}/${dir}`, { recursive: true });
  await rm(`${out}/${browser}/manifest.json`);
  const manifest = JSON.parse(await readFile(`${root}src/${browser}/manifest.json`, "utf8"));
  manifest.version = version;
  return manifest;
}

async function listText(id, url) {
  const cache = `${root}.cache/lists/${id}.txt`;
  if (offline && existsSync(cache)) return readFile(cache, "utf8");
  if (offline) throw new Error(`--offline: ${id} is not cached yet`);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await mkdir(`${root}.cache/lists`, { recursive: true });
      await writeFile(cache, text);
      return text;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw new Error(`${id}: ${lastError.message}`);
}

async function buildChromiumRulesets(out, manifest) {
  await mkdir(`${out}/rulesets`);
  await mkdir(`${out}/cosmetic`);
  const counts = {};
  for (const [id, { url }] of Object.entries(LISTS)) {
    const parsed = parseList(await listText(id, url), id);
    const { rules, skipped } = listToRules(parsed);
    await writeFile(`${out}/rulesets/${id}.json`, JSON.stringify(rules));
    const slim = (r) => ({ hosts: r.hosts, excludedHosts: r.excludedHosts, selector: r.selector });
    await writeFile(`${out}/cosmetic/${id}.json`, JSON.stringify({ cosmetic: parsed.cosmetic.map(slim), exceptions: parsed.cosmeticExceptions.map(slim) }));
    counts[id] = { rules: parsed.network.length + parsed.hosts.length + parsed.exceptions.length, dnr: rules.length, cosmetic: parsed.cosmetic.length, skipped: skipped + parsed.unsupported };
    console.log(`  ${id.padEnd(16)} ${String(rules.length).padStart(7)} DNR rules  ${String(parsed.cosmetic.length).padStart(6)} cosmetic  ${counts[id].skipped} skipped`);
  }
  await writeFile(`${out}/rulesets/counts.json`, JSON.stringify(counts));
  manifest.declarative_net_request.rule_resources = Object.keys(LISTS).map((id) => ({
    id, enabled: PROFILES[DEFAULT_PROFILE].includes(id), path: `rulesets/${id}.json`,
  }));
}

function zip(dir, file) {
  try {
    execFileSync("zip", ["-qr", file, "."], { cwd: dir });
    console.log(`  → ${file}`);
  } catch {
    console.log("  (zip not available: package skipped)");
  }
}

for (const browser of targets) {
  const out = `${root}dist/${browser}`;
  console.log(`${browser} ${version}`);
  const manifest = await copySources(browser, out);
  if (browser === "chromium") await buildChromiumRulesets(out, manifest);
  await writeFile(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  zip(out, `${root}dist/privablock-${browser}-${version}.zip`);
}
