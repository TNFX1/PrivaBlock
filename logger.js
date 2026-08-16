let port = null;
let paused = false;
let entries = [];

const targetTabId = Number(new URLSearchParams(location.search).get("tabId"));

function addText(parent, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function renderEmpty(message, detail) {
  const root = document.getElementById("log");
  root.replaceChildren();
  const box = document.createElement("div");
  box.className = "empty";
  addText(box, "strong", "", message);
  addText(box, "span", "", detail);
  root.appendChild(box);
}

function render() {
  const root = document.getElementById("log");
  const query = document.getElementById("filter").value.trim().toLowerCase();
  const visible = query
    ? entries.filter(e => Object.values(e).some(v => String(v).toLowerCase().includes(query)))
    : entries;

  document.getElementById("count").textContent = `${visible.length.toLocaleString()} entries`;
  root.replaceChildren();

  if (!visible.length) {
    renderEmpty("No requests yet", "Reload the target page to capture its network activity.");
    return;
  }

  visible.slice(-1200).reverse().forEach(e => {
    const article = document.createElement("article");
    article.className = `row ${e.action === "block" ? "blocked" : "allowed"}`;

    addText(article, "span", "time", new Date(e.time).toLocaleTimeString());
    addText(article, "span", "action", e.action === "block" ? "BLOCK" : "ALLOW");
    addText(article, "span", "type", e.type || "");
    addText(article, "span", "party", e.party || "");

    const detail = document.createElement("div");
    detail.className = "detail";
    addText(detail, "b", "", e.filter || "No matching filter");
    addText(detail, "small", "", e.source || "No list match");
    addText(detail, "code", "", e.url || "");
    article.appendChild(detail);

    addText(article, "span", "context", e.context || "");
    root.appendChild(article);
  });
}

async function init() {
  if (!Number.isInteger(targetTabId) || targetTabId < 0) {
    renderEmpty("Logger target unavailable", "Open Logger from the PrivaBlock popup while viewing a website.");
    return;
  }

  const result = await browser.runtime.sendMessage({ type: "getLog", tabId: targetTabId });
  entries = result?.entries || [];
  render();

  port = browser.runtime.connect({ name: `logger:${targetTabId}` });
  port.onMessage.addListener(message => {
    if (message.type === "logEvent") {
      entries.push(message.entry);
      if (entries.length > 1200) entries.shift();
      if (!paused) render();
    }
  });
}

document.getElementById("filter").addEventListener("input", render);

document.getElementById("pause").addEventListener("click", event => {
  paused = !paused;
  event.currentTarget.textContent = paused ? "Resume" : "Pause";
});

document.getElementById("clear").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "clearLog", tabId: targetTabId });
  entries = [];
  render();
});

document.getElementById("reloadTarget").addEventListener("click", () => {
  browser.tabs.reload(targetTabId, { bypassCache: false });
});

init();
