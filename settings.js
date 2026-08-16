const groups=["Core","Ads","Ads & Privacy","Privacy","Compatibility","Annoyances"];
const defaults={
 ublock:{name:"uBlock filters – Ads",group:"Core",description:"uBlock's optimized ad filters"},
 ublockQuick:{name:"uBlock filters – Quick fixes",group:"Core",description:"Current fixes for ads and website breakage"},
 ublockUnbreak:{name:"uBlock filters – Unbreak",group:"Compatibility",description:"Compatibility rules that reduce false positives"},
 easylist:{name:"EasyList",group:"Ads",description:"General advertising filters"},
 hagezi:{name:"HaGeZi Multi NORMAL",group:"Ads & Privacy",description:"Balanced ads, trackers, telemetry and scams"},
 hageziPro:{name:"HaGeZi Multi PRO",group:"Ads & Privacy",description:"More aggressive protection with more compatibility risk"},
 easyprivacy:{name:"EasyPrivacy",group:"Privacy",description:"Tracking and analytics protection"},
 ublockPrivacy:{name:"uBlock filters – Privacy",group:"Privacy",description:"uBlock privacy and tracker filters"},
 urlTracking:{name:"URL Tracking Protection",group:"Privacy",description:"Removes common tracking parameters"},
 adguard:{name:"AdGuard – Ads",group:"Ads",description:"Additional general advertising rules"},
 adguardPrivacy:{name:"AdGuard – Tracking Protection",group:"Privacy",description:"Additional tracker and analytics rules"},
 easyAnnoyances:{name:"EasyList – Annoyances",group:"Annoyances",description:"Popups, widgets and other annoyances"},
 easyCookie:{name:"EasyList – Cookie Notices",group:"Annoyances",description:"Cookie and consent notices"}
};
async function message(data){try{return await browser.runtime.sendMessage(data)}catch{return null}}
function messageText(text,error=false){const el=document.getElementById("message");el.textContent=text;el.className=error?"error":""}
function appendText(parent, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function renderProfiles(current) {
  const root = document.getElementById("profiles");
  root.replaceChildren();

  for (const [id, profile] of Object.entries(current)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile" + (id === window.currentProfile ? " selected" : "");
    button.dataset.id = id;

    appendText(button, "b", "", profile.name);
    appendText(button, "small", "", profile.description);
    appendText(button, "span", "profile-state", id === window.currentProfile ? "Active" : "Select");

    root.appendChild(button);
  }
}

function renderLists(settings) {
  const root = document.getElementById("lists");
  root.replaceChildren();

  for (const group of groups) {
    const entries = Object.entries(defaults).filter(([, item]) => item.group === group);
    if (!entries.length) continue;

    const box = document.createElement("div");
    box.className = "group";
    appendText(box, "div", "group-title", group);

    for (const [id, info] of entries) {
      const row = document.createElement("label");
      row.className = "list-row";

      const copy = document.createElement("span");
      copy.className = "copy";
      appendText(copy, "b", "", info.name);
      appendText(copy, "small", "", info.description);

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = settings[id] !== false;

      toggle.addEventListener("change", async () => {
        const stored = await browser.storage.local.get("filterSettings");
        const filters = stored.filterSettings || {};
        filters[id] = toggle.checked;
        messageText("Updating filters…");
        await message({ type: "saveFilterSettings", settings: filters });
        await refresh();
        messageText("Filters updated.");
      });

      row.append(copy, toggle);
      box.appendChild(row);
    }

    root.appendChild(box);
  }
}

function renderCustom(lists) {
  const root = document.getElementById("customLists");
  root.replaceChildren();

  const values = Object.values(lists || {});
  if (!values.length) {
    appendText(root, "div", "empty", "No custom lists added.");
    return;
  }

  for (const item of values) {
    const row = document.createElement("div");
    row.className = "custom-row";

    const copy = document.createElement("div");
    copy.className = "copy";
    appendText(copy, "b", "", item.name);
    appendText(copy, "small", "", item.url);

    const actions = document.createElement("div");
    actions.className = "custom-actions";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled !== false;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";

    actions.append(toggle, remove);
    row.append(copy, actions);
    root.appendChild(row);

    toggle.addEventListener("change", async () => {
      messageText("Updating filters…");
      await message({ type: "toggleCustomList", id: item.id, enabled: toggle.checked });
      await refresh();
      messageText("Filters updated.");
    });

    remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${item.name}?`)) return;
      messageText("Removing list…");
      await message({ type: "removeCustomList", id: item.id });
      await refresh();
      messageText("List removed.");
    });
  }
}

function renderDisabledSites(items) {
  const root = document.getElementById("disabledSites");
  root.replaceChildren();

  if (!items.length) {
    appendText(root, "div", "empty", "No disabled sites.");
    return;
  }

  for (const domain of items) {
    const row = document.createElement("div");
    row.className = "custom-row";

    const copy = document.createElement("div");
    copy.className = "copy";
    appendText(copy, "b", "", domain);
    appendText(copy, "small", "", "Protection is disabled for this domain");

    const enable = document.createElement("button");
    enable.type = "button";
    enable.textContent = "Enable";
    enable.addEventListener("click", async () => {
      await message({ type: "setSiteEnabled", domain, enabled: true });
      await refresh();
    });

    row.append(copy, enable);
    root.appendChild(row);
  }
}

async function refresh(){const s=await browser.storage.local.get(["filterSettings","customLists","myFilters","fingerprint","strictFingerprint","profile"]);window.currentProfile=s.profile||"balanced";renderLists(s.filterSettings||{});renderCustom(s.customLists||{});document.getElementById("myFilters").value=s.myFilters||"";document.getElementById("fingerprint").checked=s.fingerprint!==false;document.getElementById("strictFingerprint").checked=s.strictFingerprint===true;const stats=await message({type:"getStats"});document.getElementById("ruleCount").textContent=`${Number(stats?.filterCount||0).toLocaleString()} rules`;const enabled=Object.values(s.filterSettings||{}).filter(Boolean).length;const warning=document.getElementById("warning");if(enabled>=10||Number(stats?.filterCount||0)>500000){warning.className="warning";warning.textContent="Many filter lists are enabled. This can increase memory use and site breakage. Balanced is recommended unless you need stricter coverage."}else{warning.className="warning hidden";warning.textContent=""}renderDisabledSites(await message({type:"getDisabledSites"})||[]);renderProfiles(window.profiles||{})}
document.getElementById("profiles").addEventListener("click",async e=>{const b=e.target.closest("button[data-id]");if(!b)return;const id=b.dataset.id;if(id===window.currentProfile)return;window.currentProfile=id;document.querySelectorAll("#profiles .profile").forEach(x=>{const active=x.dataset.id===id;x.classList.toggle("selected",active);const st=x.querySelector(".profile-state");if(st)st.textContent=active?"Active":"Select"});document.getElementById("profiles").classList.add("applying");messageText(`Applying ${window.profiles[id]?.name||id} profile…`);const r=await message({type:"setProfile",profile:id});document.getElementById("profiles").classList.remove("applying");if(!r?.ok){window.currentProfile=safeProfileFallback();messageText("Profile change failed.",true);await refresh();return}messageText(`${window.profiles[id]?.name||id} profile selected. Protection is rebuilding in the background.`);setTimeout(refresh,120)});
function safeProfileFallback(){return "balanced"}
document.getElementById("update").addEventListener("click",async()=>{messageText("Downloading enabled filter lists…");const r=await message({type:"updateFilters"});await refresh();messageText(r?.filters?`${Number(r.filters).toLocaleString()} network rules loaded.`:"Some lists could not be updated.",!r?.filters)});
document.getElementById("addList").addEventListener("click",async()=>{const name=document.getElementById("listName").value.trim(),url=document.getElementById("listUrl").value.trim();if(!name||!/^https?:\/\//i.test(url)){messageText("Enter a name and a valid HTTP(S) URL.",true);return}messageText("Adding list…");await message({type:"addCustomList",name,url});document.getElementById("listName").value="";document.getElementById("listUrl").value="";await refresh();messageText("List added and updated.")});
document.getElementById("applyMyFilters").addEventListener("click",async()=>{messageText("Applying filters…");await message({type:"saveMyFilters",text:document.getElementById("myFilters").value});await refresh();messageText("My filters applied.")});
document.getElementById("fingerprint").addEventListener("change",async e=>{await message({type:"setFingerprint",enabled:e.target.checked});messageText(e.target.checked?"Fingerprinting protection enabled.":"Fingerprinting protection disabled.")});
document.getElementById("strictFingerprint").addEventListener("change",async e=>{await browser.storage.local.set({strictFingerprint:e.target.checked});if(e.target.checked)await message({type:"setFingerprint",enabled:true});messageText(e.target.checked?"Strict fingerprinting mode enabled.":"Strict fingerprinting mode disabled.")});
document.getElementById("openLogger").addEventListener("click",()=>message({type:"openLogger"}));
document.getElementById("benchmark").addEventListener("click",async()=>{const b=document.getElementById("benchmarkResult");b.textContent="Running…";const r=await message({type:"benchmark"});b.textContent=r?`${r.ms} ms for ${r.checks.toLocaleString()} indexed checks using ${r.filters.toLocaleString()} filters.`:"Benchmark unavailable."});
(async()=>{window.profiles=await message({type:"getProfiles"})||{};await refresh()})();
