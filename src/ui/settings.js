import { api, t, applyI18n, send, $, el, formatNumber, formatTime, switchControl } from "./common.js";
import { LISTS, GROUPS, PROFILES } from "../core/lists.js";

let caps = {};
let settings = null;
let toastTimer = null;

function toast(text, error = false) {
  const box = $("toast");
  box.textContent = text;
  box.className = `toast${error ? " error" : ""}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 3500);
}

/** Run a change, keep the page responsive, then re-render from the background's state. */
async function change(type, data, done) {
  document.body.classList.add("busy");
  toast(t("working"));
  const res = await send(type, data);
  document.body.classList.remove("busy");
  if (res?.ok === false) toast(t("actionFailed"), true);
  else if (done) toast(done);
  else $("toast").hidden = true;
  await refresh();
  return res;
}

function listStatus(id) {
  const s = settings.lists[id];
  if (!s) return { text: "" };
  if (!s.ok) return { text: t("listFailed", s.error || ""), error: true };
  const parts = [];
  if (s.rules) parts.push(t("listRules", formatNumber(s.rules)));
  if (s.cosmetic) parts.push(t("listCosmetic", formatNumber(s.cosmetic)));
  if (s.bundled) parts.push(t("listBundled"));
  else if (s.updated) parts.push(t("listUpdated", formatTime(s.updated)));
  if (s.source === "stale") parts.push(t("listStale"));
  return { text: parts.join(" · ") };
}

const SECTIONS = ["protection", "lists", "filters", "sites", "about"];

function showSection(name) {
  if (!SECTIONS.includes(name)) name = "protection";
  for (const section of document.querySelectorAll("section[data-section]")) section.hidden = section.dataset.section !== name;
  for (const link of document.querySelectorAll(".side a")) {
    if (link.hash === `#${name}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  scrollTo(0, 0); // "#lists" is also the id of the list container, which the browser would scroll to
}

function renderProfiles() {
  const root = $("profiles");
  // Built once and only re-checked afterwards, so keyboard focus stays on the radio after a change.
  if (!root.childElementCount) {
    for (const id of Object.keys(PROFILES)) {
      root.append(el("label", { class: "row opt" },
        el("input", {
          type: "radio", name: "profile", value: id,
          onchange: () => change("setProfile", { profile: id }, t("profileApplied", t(`profile_${id}`))),
        }),
        el("span", {}, el("b", { text: t(`profile_${id}`) }), el("small", { text: t(`profile_${id}_hint`) }))));
    }
  }
  const custom = Object.keys(settings.listOverrides).length > 0;
  for (const input of root.querySelectorAll("input")) input.checked = !custom && settings.profile === input.value;
}

function renderLists() {
  const root = $("lists");
  root.replaceChildren();
  const enabled = new Set(settings.enabled);
  for (const group of GROUPS) {
    const ids = Object.keys(LISTS).filter((id) => LISTS[id].group === group);
    root.append(el("div", { class: "group-title", text: t(`group_${group}`) }));
    for (const id of ids) {
      const status = listStatus(id);
      root.append(el("div", { class: "list-row" },
        el("div", {}, el("b", { text: LISTS[id].name }), el("small", { text: status.text, class: status.error ? "error" : "" })),
        switchControl(enabled.has(id), (on) => change("setList", { id, enabled: on }), LISTS[id].name)));
    }
  }
  const many = settings.enabled.length >= 10;
  $("listWarning").hidden = !many && !settings.staticError;
  $("listWarning").textContent = settings.staticError ? t("staticLimit") : t("manyLists");
}

function renderCustomLists() {
  const root = $("customLists");
  root.replaceChildren();
  const lists = Object.values(settings.customLists);
  if (!lists.length) root.append(el("div", { class: "empty", text: t("customEmpty") }));
  for (const list of lists) {
    const status = listStatus(list.id);
    root.append(el("div", { class: "row" },
      el("div", {}, el("b", { text: list.name }), el("span", { class: "url", text: list.url }), el("small", { text: status.text, class: status.error ? "error" : "" })),
      el("div", { class: "actions" },
        switchControl(list.enabled !== false, (on) => change("toggleCustomList", { id: list.id, enabled: on }), list.name),
        el("button", {
          type: "button", class: "btn danger", text: t("remove"),
          onclick: () => confirm(t("customRemoveConfirm", list.name)) && change("removeCustomList", { id: list.id }, t("customRemoved")),
        }))));
  }
}

function renderDisabledSites() {
  const root = $("disabledSites");
  root.replaceChildren();
  if (!settings.disabledSites.length) root.append(el("div", { class: "empty", text: t("disabledEmpty") }));
  for (const site of settings.disabledSites) {
    root.append(el("div", { class: "row" },
      el("div", {}, el("b", { text: site })),
      el("button", { type: "button", class: "btn", text: t("enable"), onclick: () => change("setSiteEnabled", { site, enabled: true }) })));
  }
}

async function refresh() {
  settings = await send("getSettings");
  if (!settings) return toast(t("backgroundUnavailable"), true);
  $("ruleCount").textContent = settings.loading ? t("rulesLoading") : t("rulesCount", formatNumber(settings.ruleCount));
  renderProfiles();
  renderLists();
  renderCustomLists();
  renderDisabledSites();
  if (document.activeElement !== $("myFilters")) $("myFilters").value = settings.myFilters;
  const d = settings.dynamic;
  $("dynamicLimit").hidden = !d?.truncated;
  if (d?.truncated) $("dynamicLimit").textContent = t("dynamicLimit", formatNumber(d.max), formatNumber(d.truncated));
  $("fingerprint").checked = settings.fingerprint;
  $("showBadge").checked = settings.showBadge;
  if (caps.dailyStats) {
    const s = await send("getStats");
    $("today").hidden = !s;
    if (s) $("today").textContent = t("settingsToday", formatNumber(s.dailyBlocked));
  }
}

$("update").addEventListener("click", () => change("updateFilters", {}, t("filtersUpdated")));
$("addListForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const res = await change("addCustomList", { name: $("listName").value.trim(), url: $("listUrl").value.trim() }, t("customAdded"));
  if (res?.ok) event.target.reset();
});
$("saveMyFilters").addEventListener("click", () => change("saveMyFilters", { text: $("myFilters").value }, t("myFiltersApplied")));
$("fingerprint").addEventListener("change", (event) => change("setFingerprint", { enabled: event.target.checked }));
$("showBadge").addEventListener("change", (event) => change("setShowBadge", { enabled: event.target.checked }));
addEventListener("hashchange", () => showSection(location.hash.slice(1)));
$("benchmark").addEventListener("click", async () => {
  $("benchmarkResult").textContent = t("working");
  const r = await send("benchmark");
  $("benchmarkResult").textContent = r ? t("benchmarkResult", formatNumber(r.checks), r.ms) : t("actionFailed");
});

(async () => {
  applyI18n();
  showSection(location.hash.slice(1));
  for (const node of document.querySelectorAll(".version")) node.textContent = t("settingsVersion", api.runtime.getManifest().version);
  caps = (await send("getCapabilities")) || {};
  $("privacySection").hidden = !caps.fingerprint;
  $("benchmark").hidden = !caps.benchmark;
  $("listsHint").textContent = t(caps.bundledLists ? "listsHintBundled" : "listsHint");
  $("diagnosticsHint").textContent = t(caps.fullLogger ? "diagnosticsHint" : "diagnosticsHintChromium");
  $("update").title = t(caps.bundledLists ? "updateFiltersHintBundled" : "updateFiltersHint");
  await refresh();
})();
