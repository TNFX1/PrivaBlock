// Element picker: injected into the active tab's top frame on demand (popup button or keyboard
// shortcut). The person points at an element, can widen the choice, and saves it as a
// `host##selector` rule in My filters. Everything lives in a closed shadow root.
(() => {
  if (globalThis.privablockPicker) return globalThis.privablockPicker.focus();
  const api = globalThis.browser ?? globalThis.chrome;
  const t = (key, ...subs) => api.i18n.getMessage(key, subs.map(String)) || key;

  const host = document.createElement("privablock-picker");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { --field:#2f5bea; --panel:#fff; --ink:#172238; --muted:#5b6880; --line:#cfd7e3; --sunken:#f3f6fa; }
    @media (prefers-color-scheme: dark) { :host { --panel:#172238; --ink:#e4eaf4; --muted:#9aa7bd; --line:#26344a; --sunken:#111b2c; } }
    * { box-sizing: border-box; font: 14px/1.4 "IBM Plex Sans", system-ui, sans-serif; }
    .box { position: fixed; pointer-events: none; outline: 2px solid var(--field); background: rgb(47 91 234 / .16); transition: all .06s; }
    .box.picked { background: rgb(47 91 234 / .3); }
    .panel { position: fixed; right: 16px; bottom: 16px; width: min(340px, calc(100vw - 32px)); pointer-events: auto;
      background: var(--panel); color: var(--ink); border-radius: 10px; overflow: hidden; box-shadow: 0 10px 40px rgb(0 0 0 / .28); }
    .head { background: var(--field); color: #fff; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .head b { font-weight: 600; }
    .head button { background: none; border: 0; color: #fff; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .body { padding: 12px 14px 14px; display: grid; gap: 10px; }
    .hint, .count { color: var(--muted); font-size: 13px; }
    textarea { width: 100%; resize: vertical; min-height: 54px; padding: 8px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--sunken); color: var(--ink); font: 12.5px/1.4 ui-monospace, monospace; }
    textarea:focus-visible, button:focus-visible { outline: 2px solid var(--field); outline-offset: 2px; }
    .row { display: flex; gap: 8px; justify-content: flex-end; }
    .btn { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-weight: 500; }
    .btn.primary { background: var(--field); border-color: var(--field); color: #fff; }
    .btn:disabled { opacity: .5; cursor: default; }
    [hidden] { display: none !important; }
  `;
  const box = document.createElement("div");
  box.className = "box";
  box.hidden = true;
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("pickerTitle"));
  const make = (tag, props, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };
  const close = make("button", { type: "button", textContent: "×", title: t("pickerCancel") });
  close.setAttribute("aria-label", t("pickerCancel"));
  const hint = make("div", { className: "hint", textContent: t("pickerHint") });
  const input = make("textarea", { spellcheck: false, hidden: true });
  input.setAttribute("aria-label", t("pickerSelector"));
  const count = make("div", { className: "count", hidden: true });
  const wider = make("button", { type: "button", className: "btn", textContent: t("pickerWider"), hidden: true });
  const create = make("button", { type: "button", className: "btn primary", textContent: t("pickerCreate"), hidden: true });
  panel.append(
    make("div", { className: "head" }, make("b", { textContent: t("pickerTitle") }), close),
    make("div", { className: "body" }, hint, input, count, make("div", { className: "row" }, wider, create)),
  );
  shadow.append(style, box, panel);
  document.documentElement.append(host);

  let picked = null;

  function frame(el, isPicked = false) {
    if (!el) return (box.hidden = true);
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.classList.toggle("picked", isPicked);
    box.hidden = false;
  }

  const usable = (name) => /^[A-Za-z_][\w-]{0,60}$/.test(name) && !/\d{4,}|[a-f0-9]{8,}/i.test(name); // skip generated names

  /** A short selector for `el`: an id, or a path of tag.class steps, with :nth-of-type only where needed. */
  function selectorFor(el) {
    const steps = [];
    for (let n = el; n && n !== document.documentElement && n !== document.body && steps.length < 5; n = n.parentElement) {
      if (n.id && usable(n.id)) {
        steps.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let step = n.localName;
      const classes = [...n.classList].filter(usable).slice(0, 3);
      step += classes.map((c) => `.${CSS.escape(c)}`).join("");
      const same = n.parentElement ? [...n.parentElement.children].filter((s) => s.localName === n.localName) : [];
      if (!classes.length && same.length > 1) step += `:nth-of-type(${same.indexOf(n) + 1})`;
      steps.unshift(step);
      if (classes.length && matches(steps.join(" > ")) === 1) break;
    }
    return steps.join(" > ");
  }

  function matches(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  }

  function showSelector() {
    const n = matches(input.value.trim());
    count.textContent = n < 0 ? t("pickerInvalid") : t("pickerMatches", n);
    create.disabled = n < 1;
  }

  function pick(el) {
    picked = el;
    frame(el, true);
    input.value = selectorFor(el);
    hint.hidden = true;
    for (const n of [input, count, wider, create]) n.hidden = false;
    showSelector();
    input.focus();
  }

  const target = (x, y) => document.elementsFromPoint(x, y).find((el) => el !== host && el !== document.documentElement && el !== document.body);

  function onMove(event) {
    if (picked) return;
    frame(target(event.clientX, event.clientY));
  }
  function onClick(event) {
    if (event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const el = target(event.clientX, event.clientY);
    if (el) pick(el);
  }
  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      quit();
    }
  }
  // Swallow presses so links and buttons on the page don't fire while picking.
  const swallow = (event) => {
    if (!event.composedPath().includes(host)) event.preventDefault(), event.stopImmediatePropagation();
  };

  function quit() {
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("keydown", onKey, true);
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "auxclick"]) removeEventListener(type, swallow, true);
    host.remove();
    delete globalThis.privablockPicker;
  }

  close.addEventListener("click", quit);
  input.addEventListener("input", showSelector);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) event.preventDefault(), create.click();
  });
  wider.addEventListener("click", () => {
    if (picked?.parentElement && picked.parentElement !== document.body) pick(picked.parentElement);
  });
  create.addEventListener("click", async () => {
    const selector = input.value.trim();
    if (matches(selector) < 1) return;
    create.disabled = true;
    // Hidden at once; the rule takes a moment to save (Firefox rebuilds its lists), and comes back if that fails.
    const hide = document.createElement("style");
    hide.textContent = `${selector}{display:none!important}`;
    (document.head || document.documentElement).append(hide);
    host.style.display = "none";
    const res = await api.runtime.sendMessage({ type: "pickerCreate", selector }).catch(() => null);
    if (!res?.ok) {
      hide.remove();
      host.style.display = "";
      count.textContent = t("actionFailed");
      create.disabled = false;
      return;
    }
    quit();
  });

  addEventListener("mousemove", onMove, true);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey, true);
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "auxclick"]) addEventListener(type, swallow, true);
  globalThis.privablockPicker = { focus: () => (picked ? input : close).focus() };
})();
