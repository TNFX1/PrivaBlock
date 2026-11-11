// Runs procedural cosmetic filters (parsed by src/core/procedural.js) in the page. Loaded before
// content.js in the same isolated world; content.js calls privablockProcedural(filters, onHidden).
globalThis.privablockProcedural = (filters, onHidden) => {
  const HIDE = `pb-${Math.random().toString(36).slice(2, 10)}`; // random, so pages can't style or look for it
  const sheet = document.createElement("style");
  sheet.textContent = `[${HIDE}]{display:none!important}`;
  (document.head || document.documentElement).appendChild(sheet);

  const textRe = (text) => {
    const m = /^\/(.+)\/([imsu]*)$/.exec(text);
    if (m) {
      try {
        return new RegExp(m[1], m[2]);
      } catch {
        return null;
      }
    }
    return { test: (s) => s.includes(text) };
  };
  // "*" in matches-css values is a wildcard (AdGuard); /…/ is a regular expression.
  const valueRe = (text) => {
    if (/^\/.+\/[imsu]*$/.test(text)) return textRe(text);
    return new RegExp(`^${text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  };

  /** CSS relative to `el`: "> a" and "a" search below it, "+ a" / "~ a" its following siblings. */
  function relative(el, css) {
    const c = css.trim();
    try {
      if (c.startsWith("+") || c.startsWith("~")) {
        const sel = c.slice(1).trim();
        const out = [];
        for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
          if (n.matches(sel)) out.push(n);
          if (c.startsWith("+")) break;
        }
        return out;
      }
      return [...el.querySelectorAll(c.startsWith(">") ? `:scope ${c}` : c)];
    } catch {
      return [];
    }
  }

  function step(nodes, task) {
    const [kind, a, b] = task;
    switch (kind) {
      case "css":
        try {
          return [...document.querySelectorAll(a)];
        } catch {
          return [];
        }
      case "spath": {
        if (/^\s*[>+~]|^\s/.test(a)) return nodes.flatMap((el) => relative(el, a));
        return nodes.filter((el) => {
          try {
            return el.matches(`*${a}`);
          } catch {
            return false;
          }
        });
      }
      case "has-text": {
        const re = textRe(a);
        return re ? nodes.filter((el) => re.test(el.textContent)) : [];
      }
      case "min-text-length":
        return nodes.filter((el) => el.textContent.length >= a);
      case "upward":
        return nodes.map((el) => {
          if (typeof a === "number") {
            let n = el;
            for (let i = 0; i < a && n; i++) n = n.parentElement;
            return n;
          }
          try {
            return el.parentElement?.closest(a);
          } catch {
            return null;
          }
        }).filter(Boolean);
      case "matches-css":
      case "matches-css-before":
      case "matches-css-after": {
        const re = valueRe(b);
        const pseudo = kind === "matches-css" ? null : `::${kind.slice(12)}`;
        return re ? nodes.filter((el) => re.test(getComputedStyle(el, pseudo).getPropertyValue(a))) : [];
      }
      case "matches-attr": {
        const name = valueRe(a);
        const value = b ? valueRe(b) : null;
        return nodes.filter((el) => [...el.attributes].some((at) => name.test(at.name) && (!value || value.test(at.value))));
      }
      case "matches-path": {
        const re = textRe(a);
        const here = location.pathname + location.search;
        return re && re.test(here) ? (nodes.length ? nodes : [document.documentElement]) : [];
      }
      case "xpath": {
        const out = [];
        for (const ctx of nodes.length ? nodes : [document]) {
          try {
            const r = document.evaluate(a, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < r.snapshotLength; i++) if (r.snapshotItem(i).nodeType === 1) out.push(r.snapshotItem(i));
          } catch {}
        }
        return out;
      }
      case "has":
        return nodes.filter((el) => below(el, a).length > 0);
      case "not":
        return nodes.filter((el) => !self(el, a));
      case "watch-attr":
        return nodes;
      default:
        return [];
    }
  }

  // :has(…) looks below the element; its first CSS is relative to it.
  function below(el, tasks) {
    const [first, ...rest] = tasks;
    let nodes = first[0] === "css" ? relative(el, first[1]) : step([el], first);
    for (const t of rest) nodes = step(nodes, t);
    return nodes;
  }
  // :not(…) asks about the element itself.
  function self(el, tasks) {
    const [first, ...rest] = tasks;
    let nodes;
    try {
      nodes = first[0] === "css" ? (el.matches(first[1]) ? [el] : []) : step([el], first);
    } catch {
      return false;
    }
    for (const t of rest) nodes = step(nodes, t);
    return nodes.includes(el);
  }

  function run({ tasks, action }) {
    let nodes = [];
    tasks.forEach((t, i) => {
      // matches-path / xpath first: they start from the document, not from a CSS match
      nodes = i === 0 && t[0] !== "css" ? step([], t) : step(nodes, t);
    });
    let changed = 0;
    for (const el of new Set(nodes)) {
      if (el === document.documentElement || el === document.body) continue;
      if (!action) {
        if (!el.hasAttribute(HIDE)) el.setAttribute(HIDE, ""), changed++;
      } else if (action[0] === "remove") el.remove(), changed++;
      else if (action[0] === "remove-attr") for (const at of action[1].split("|")) el.removeAttribute(at);
      else if (action[0] === "remove-class") el.classList.remove(...action[1].split("|"));
    }
    return changed;
  }

  // :style() filters on plain CSS are just stylesheet rules.
  const styles = [];
  const live = [];
  for (const f of filters) {
    if (f.action?.[0] === "style" && f.tasks.length === 1 && f.tasks[0][0] === "css") {
      const decls = f.action[1].split(";").map((d) => d.trim()).filter(Boolean).map((d) => (/!important$/.test(d) ? d : `${d} !important`));
      styles.push(`${f.tasks[0][1]}{${decls.join(";")}}`);
    } else if (f.action?.[0] !== "style") live.push(f);
  }
  if (styles.length) {
    const s = document.createElement("style");
    s.textContent = styles.join("\n");
    (document.head || document.documentElement).appendChild(s);
  }
  if (!live.length) return;

  let timer = 0;
  let busy = false;
  const apply = () => {
    timer = 0;
    busy = true;
    let n = 0;
    for (const f of live) {
      try {
        n += run(f);
      } catch {}
    }
    observer.takeRecords(); // our own changes
    busy = false;
    if (n) onHidden(n);
  };
  const observer = new MutationObserver(() => {
    if (!busy) timer ||= setTimeout(apply, 100);
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
};
