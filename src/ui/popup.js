import { api, t, applyI18n, send, $, formatNumber } from "./common.js";
import { ROW, quillCount, quillShape } from "../core/quills.js";

const SVG = "http://www.w3.org/2000/svg";
const CAPTIONS = { on: "popupCaption", empty: "popupCaptionEmpty", off: "popupCaptionOff", page: "popupCaptionPage", unavailable: "popupUnavailable" };

let stats = null;
let caps = null;
let drawn = null;
let pending = 0; // setSiteEnabled calls in flight
let flips = 0; // bumped on every switch flip, so a refresh that started before it is dropped

function render(s, c) {
  stats = s;
  const state = !s ? "unavailable" : !s.web ? "page" : s.siteDisabled ? "off" : !s.pageBlocked ? "empty" : "on";
  document.body.dataset.state = state;
  $("site").textContent = s?.web ? s.site : t("extName");
  $("siteSwitch").checked = state !== "off";
  $("count").textContent = state === "off" ? t("popupOff") : formatNumber(s?.pageBlocked);
  $("caption").textContent = t(CAPTIONS[state]);
  $("todayRow").hidden = !(s && c?.dailyStats);
  $("today").textContent = formatNumber(s?.dailyBlocked);
  drawQuills(state === "on" ? quillCount(s.pageBlocked) : 0);
}

function drawQuills(count) {
  if (count === drawn) return;
  drawn = count;
  const w = 300 / ROW;
  const r = (n) => Math.round(n * 10) / 10;
  $("quills").replaceChildren(...Array.from({ length: count }, (_, i) => {
    const { h, lean } = quillShape(i);
    const quill = document.createElementNS(SVG, "polygon");
    quill.setAttribute("points", `${r(i * w + 0.12 * w)},26 ${r(i * w + lean * w)},${26 - h} ${r((i + 1) * w - 0.12 * w)},26`);
    return quill;
  }));
}

async function refresh() {
  if (pending) return;
  const at = flips;
  const s = await send("getStats");
  caps ??= await send("getCapabilities");
  if (pending || at !== flips) return;
  render(s, caps);
}

async function tick() {
  try {
    await refresh();
  } finally {
    setTimeout(tick, 1000);
  }
}

$("siteSwitch").addEventListener("change", async (event) => {
  if (!stats?.web) return;
  pending++;
  flips++;
  await send("setSiteEnabled", { site: stats.site, enabled: event.target.checked, tabId: stats.tabId });
  pending--;
  await refresh();
});
$("logger").addEventListener("click", async () => {
  await send("openLogger");
  window.close();
});
$("settings").addEventListener("click", () => {
  api.runtime.openOptionsPage();
  window.close();
});

applyI18n();
tick();
