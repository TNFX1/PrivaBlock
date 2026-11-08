import { api, t, applyI18n, send, $, el } from "./common.js";
import { LISTS } from "../core/lists.js";

const LIMIT = 1200;
const tabId = Number(new URLSearchParams(location.search).get("tabId"));
let entries = [];
let paused = false;
let caps = {};

function sourceName(source) {
  if (source === "user") return t("myFiltersTitle");
  return LISTS[source]?.name || source || "";
}

function render() {
  const q = $("filter").value.trim().toLowerCase();
  const visible = q ? entries.filter((e) => [e.url, e.filter, e.source, e.type, e.action].some((v) => String(v || "").toLowerCase().includes(q))) : entries;
  $("rows").replaceChildren(...visible.slice(-LIMIT).reverse().map((e) => el("tr", { class: e.action },
    el("td", { text: new Date(e.time).toLocaleTimeString(api.i18n.getUILanguage()) }),
    el("td", { text: t(e.action === "block" ? "loggerBlocked" : "loggerAllowed") }),
    el("td", { text: [e.type, e.party].filter(Boolean).join(" · ") }),
    el("td", { class: "url", text: e.url || t("loggerUrlUnavailable") }),
    el("td", { class: "filter" }, e.filter || (e.ruleId ? `#${e.ruleId}` : ""), el("small", { text: sourceName(e.source) })),
  )));
  $("empty").hidden = visible.length > 0;
}

function add(entry) {
  entries.push(entry);
  if (entries.length > LIMIT) entries.shift();
  if (!paused) render();
}

async function refreshChromium() {
  const matched = await send("getMatched", { tabId });
  entries = Array.isArray(matched) ? matched : [];
  render();
}

(async () => {
  applyI18n();
  if (!Number.isInteger(tabId)) {
    $("note").textContent = t("loggerNoTarget");
    return;
  }
  caps = (await send("getCapabilities")) || {};
  const tab = await api.tabs.get(tabId).catch(() => null);
  $("target").textContent = tab?.url || "";
  if (caps.fullLogger) {
    $("note").textContent = t("loggerNote");
    const port = api.runtime.connect({ name: `logger:${tabId}` });
    port.onMessage.addListener((m) => m.type === "entry" && add(m.entry));
  } else {
    $("note").textContent = t("loggerNoteChromium");
    $("pause").hidden = true;
    $("refresh").hidden = false;
    $("refresh").addEventListener("click", refreshChromium);
    await refreshChromium();
  }
  render();
})();

$("filter").addEventListener("input", render);
$("pause").addEventListener("click", (event) => {
  paused = !paused;
  event.currentTarget.textContent = t(paused ? "loggerResume" : "loggerPause");
  if (!paused) render();
});
$("clear").addEventListener("click", async () => {
  if (caps.fullLogger) await send("clearLog", { tabId });
  entries = [];
  render();
});
$("reload").addEventListener("click", () => api.tabs.reload(tabId));
