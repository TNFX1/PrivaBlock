import { api, t, applyI18n, send, $, formatNumber } from "./common.js";

let stats = null;

async function render() {
  stats = await send("getStats");
  const caps = await send("getCapabilities");
  if (!stats) {
    $("state").textContent = t("popupUnavailable");
    $("state").classList.add("off");
    return;
  }
  const on = stats.web && !stats.siteDisabled;
  document.body.classList.toggle("off", !on);
  $("state").textContent = t(on ? "stateActive" : "stateOff");
  $("state").classList.toggle("off", !on);
  $("state").hidden = !stats.web; // nothing is filtered on browser pages: no on/off state to show
  $("site").textContent = stats.web ? stats.site : t("popupNotWebPage");
  $("pageBlocked").textContent = formatNumber(stats.pageBlocked);
  $("today").hidden = !caps?.dailyStats;
  $("dailyBlocked").textContent = formatNumber(stats.dailyBlocked);
  $("siteSwitch").checked = on;
  $("siteSwitch").disabled = !stats.web;
  $("siteHint").textContent = !stats.web ? t("popupNotWebPage") : on ? t("popupSiteOnHint") : t("popupSiteOffHint");
  $("rules").textContent = stats.loading ? t("rulesLoading") : t("rulesCount", formatNumber(stats.ruleCount));
}

$("siteSwitch").addEventListener("change", async (event) => {
  if (!stats?.web) return;
  event.target.disabled = true;
  await send("setSiteEnabled", { site: stats.site, enabled: event.target.checked, tabId: stats.tabId });
  await render();
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
$("version").textContent = `v${api.runtime.getManifest().version}`;
render();
