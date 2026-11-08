// Shared helpers for the extension pages (popup, settings, logger).
export const api = globalThis.browser ?? globalThis.chrome;

/** Translated string (from _locales); `$1`… placeholders filled from `subs`. */
export function t(key, ...subs) {
  return api.i18n.getMessage(key, subs.map(String)) || key;
}

/** Fill every [data-i18n] element's text and [data-i18n-*] attributes. */
export function applyI18n(root = document) {
  document.documentElement.lang = api.i18n.getUILanguage().split("-")[0];
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const attr of ["placeholder", "title", "aria-label"]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
}

export async function send(type, data = {}) {
  try {
    return await api.runtime.sendMessage({ type, ...data });
  } catch {
    return null;
  }
}

export const $ = (id) => document.getElementById(id);

/** Create an element with text (never innerHTML: list names and URLs come from the web). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString(api.i18n.getUILanguage());
}

export function formatTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString(api.i18n.getUILanguage(), { dateStyle: "medium", timeStyle: "short" });
}

export function switchControl(checked, onChange, label) {
  const input = el("input", { type: "checkbox", role: "switch", "aria-label": label });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked, input));
  return el("label", { class: "switch" }, input, el("span", { class: "track" }));
}
