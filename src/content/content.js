// Element hiding (cosmetic filtering), shared by Firefox and Chromium. Runs at document_start.
// Rules are fetched once per frame and injected as a stylesheet, which also hides elements that
// appear later — no DOM observer needed. One CSS rule per selector, so one invalid selector
// can't disable the others.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const MAX_SELECTORS = 3000;
  const youtube = location.hostname === "youtube.com" || location.hostname.endsWith(".youtube.com");

  // Built-in YouTube rules, injected before the page renders.
  const YOUTUBE = [
    "ytd-ad-slot-renderer", "ytd-in-feed-ad-layout-renderer", "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-sparkles-text-search-renderer", "ytd-display-ad-renderer", "ytd-promoted-video-renderer",
    "ytd-compact-promoted-video-renderer", "ytd-action-companion-ad-renderer", "ytd-companion-slot-renderer",
    "ytd-banner-promo-renderer", "ytd-video-masthead-ad-v3-renderer", "ytd-video-masthead-ad-renderer",
    "ytd-search-pyv-renderer", "ytd-rich-item-renderer:has(ytd-ad-slot-renderer)",
    "ytd-rich-item-renderer:has(ytd-in-feed-ad-layout-renderer)", "ytd-rich-section-renderer:has(ytd-ad-slot-renderer)",
    "ytd-rich-section-renderer:has(ytd-statement-banner-renderer)", "ytd-reel-video-renderer:has(ytd-ad-slot-renderer)",
    "#masthead-ad", "#player-ads", ".ytp-ad-overlay-container", ".ytp-ad-image-overlay", ".ytp-ad-text-overlay",
    'ytd-engagement-panel-section-list-renderer[target-id^="engagement-panel-ads"]',
  ];

  function inject(id, selectors) {
    if (!selectors.length) return null;
    const style = document.createElement("style");
    style.className = id;
    style.textContent = selectors.map((s) => `${s}{display:none!important}`).join("\n");
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  // Scriptlet calls that came by message (Chromium: user filters and custom lists) go to the page-world
  // runner the same way the registered handoff scripts send theirs (see src/core/scriptlets.js). Late
  // for scripts that already ran, so lists' scriptlets are registered ahead instead.
  function handOff(calls) {
    const root = document.documentElement;
    let queued = [];
    try {
      queued = JSON.parse(root.getAttribute("data-privablock-sl") || "[]");
    } catch {}
    root.setAttribute("data-privablock-sl", JSON.stringify(queued.concat(calls)));
    document.dispatchEvent(new Event("privablock-sl"));
  }

  const builtIn = youtube ? inject("privablock-youtube", YOUTUBE) : null;

  function countHidden(selectors) {
    let count = 0;
    for (const s of selectors) {
      try {
        count += document.querySelectorAll(s).length;
      } catch {
        // invalid selector: already ignored by the stylesheet
      }
    }
    return count;
  }

  // The page's blocked count starts again for a document shown without loading: restored from the
  // back/forward cache, or a prerendered page activated. (Chromium only; Firefox ignores the message.)
  if (window === window.top) {
    const shown = () => api.runtime.sendMessage({ type: "newDocument" }).catch(() => {});
    addEventListener("pageshow", (event) => event.persisted && shown());
    if (document.prerendering) document.addEventListener("prerenderingchange", shown, { once: true });
  }

  api.runtime.sendMessage({ type: "getCosmetic", host: location.hostname }).then((response) => {
    if (!response?.enabled) {
      builtIn?.remove(); // protection is off for this site
      return;
    }
    const selectors = response.selectors.slice(0, MAX_SELECTORS);
    inject("privablock-cosmetic", selectors);
    if (response.scriptlets?.length) handOff(response.scriptlets);
    if (response.procedural?.length) {
      globalThis.privablockProcedural?.(response.procedural, (count) => api.runtime.sendMessage({ type: "recordCosmetic", count }).catch(() => {}));
    }
    const generic = [];
    if (!response.genericOff) {
      inject("privablock-generic", response.generic || []);
      watchGeneric((found) => {
        generic.push(...found);
        inject("privablock-generic", found);
      });
    }
    const report = () => {
      const count = countHidden([...selectors, ...generic, ...(youtube ? YOUTUBE : [])]);
      if (count) api.runtime.sendMessage({ type: "recordCosmetic", count }).catch(() => {});
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(report, 300), { once: true });
    else setTimeout(report, 300);
  }, () => {});

  // Generic hiding rules ("##.ad-banner" for every site) are many, so, as uBO does, only those starting
  // with a class or id the page actually has are asked for: now, when the DOM is ready, and as it changes.
  function watchGeneric(found) {
    const seen = new Set();
    let pending = new Set();
    let timer = 0;
    const collect = (el) => {
      if (el.id && !seen.has(`#${el.id}`)) pending.add(`#${el.id}`);
      for (const c of el.classList || []) if (!seen.has(`.${c}`)) pending.add(`.${c}`);
    };
    const scan = (root) => {
      if (root.nodeType !== 1) return;
      collect(root);
      for (const el of root.querySelectorAll("[id],[class]")) collect(el);
    };
    const flush = () => {
      timer = 0;
      if (!pending.size) return;
      const tokens = [...pending];
      for (const t of tokens) seen.add(t);
      pending = new Set();
      api.runtime.sendMessage({ type: "getGeneric", host: location.hostname, tokens }).then((r) => {
        if (r?.selectors?.length) found(r.selectors);
      }, () => {});
    };
    const soon = () => (timer ||= setTimeout(flush, 100));
    if (document.documentElement) scan(document.documentElement);
    flush();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => (scan(document.documentElement), flush()), { once: true });
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") collect(r.target);
        else for (const n of r.addedNodes) scan(n);
      }
      if (pending.size) soon();
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "class"] });
  }
})();
