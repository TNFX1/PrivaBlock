// Procedural cosmetic filters (uBlock Origin / AdGuard extended syntax) parsed to plain JSON, which the
// content script (src/content/procedural.js) runs against the page. Pure: unit-tested in Node.
//
// A parsed filter is { tasks, action }:
//   tasks: [["css", "div.ad"], ["has-text", "Sponsored"], ["upward", 2], ["spath", " > span"], …]
//   action: null (hide) | ["remove"] | ["style", "color: red"] | ["remove-attr", "x"] | ["remove-class", "y"]

const OPS = {
  "has-text": "has-text", contains: "has-text", "-abp-contains": "has-text",
  has: "has", "-abp-has": "has", if: "has",
  not: "not", "if-not": "not",
  upward: "upward", "nth-ancestor": "upward",
  "matches-css": "matches-css", "matches-css-before": "matches-css-before", "matches-css-after": "matches-css-after",
  "min-text-length": "min-text-length",
  "matches-attr": "matches-attr",
  "matches-path": "matches-path",
  xpath: "xpath",
  "watch-attr": "watch-attr",
};
const ACTIONS = new Set(["remove", "style", "remove-attr", "remove-class"]);
// Operators that always make a filter procedural (:has and :not only when what's inside is procedural).
const ALWAYS = new Set(["has-text", "upward", "matches-css", "matches-css-before", "matches-css-after", "min-text-length", "matches-attr", "matches-path", "xpath", "watch-attr"]);

/** Index of the `)` that closes the `(` at `open`, skipping quotes, brackets and nested parens; -1 if none. */
function closingParen(text, open) {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "\\") i++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Top-level `:name(` positions in `text` (outside quotes, brackets and parens). */
function* operators(text) {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\\") i++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ":" && depth === 0) {
      const m = /^:([-a-z]+)\(/.exec(text.slice(i));
      if (m) yield { at: i, name: m[1], open: i + m[0].length - 1 };
    }
  }
}

const unquote = (s) => (/^(["'])[\s\S]*\1$/.test(s.trim()) ? s.trim().slice(1, -1) : s.trim());

/** True when the selector uses syntax the browser's CSS engine can't run. */
export function isProcedural(selector) {
  for (const op of operators(selector)) {
    if (ACTIONS.has(op.name) || ALWAYS.has(OPS[op.name])) return true;
    if (op.name === "-abp-has" || op.name === "if" || op.name === "if-not" || op.name === "contains" || op.name === "-abp-contains" || op.name === "nth-ancestor") return true;
    if ((op.name === "has" || op.name === "not") && isProcedural(selector.slice(op.open + 1, closingParen(selector, op.open)))) return true;
    if (op.name === "others") return true;
  }
  return false;
}

/** Parse a procedural selector; null when it can't be applied (unknown operator, bad argument). */
export function parseProcedural(selector, nested = false) {
  const tasks = [];
  let action = null;
  let last = 0;
  const pushCss = (css) => {
    if (!css.trim()) return;
    if (!tasks.length) tasks.push(["css", css.trim()]);
    else tasks.push(["spath", css]);
  };
  for (const op of operators(selector)) {
    if (op.at < last) continue; // inside an operator already consumed
    const close = closingParen(selector, op.open);
    if (close < 0) return null;
    const arg = selector.slice(op.open + 1, close);
    if (ACTIONS.has(op.name)) {
      if (nested || selector.slice(close + 1).trim()) return null; // actions only at the very end
      pushCss(selector.slice(last, op.at));
      if (op.name === "style") {
        if (!arg.trim() || /url\(|\\|\/\*|[{}<>]|expression/i.test(arg)) return null;
        action = ["style", arg.trim()];
      } else if (op.name === "remove") {
        if (arg.trim()) return null;
        action = ["remove"];
      } else {
        const what = unquote(arg);
        if (!what || /[^\w\-|]/.test(what)) return null;
        action = [op.name, what];
      }
      last = close + 1;
      break;
    }
    const kind = OPS[op.name];
    if (!kind) {
      if (op.name === "others") return null;
      continue; // a native pseudo-class (:nth-child(2), :is(…)): part of the CSS text
    }
    if ((kind === "has" || kind === "not") && op.name !== "-abp-has" && op.name !== "if" && op.name !== "if-not" && !isProcedural(arg)) continue;
    const seg = selector.slice(last, op.at);
    pushCss(/[\s>+~]$/.test(seg) ? `${seg}*` : seg); // "div :has-text(x)" means a descendant of div
    if (!tasks.length && kind !== "xpath" && kind !== "matches-path") tasks.push(["css", "*"]);
    const task = taskFor(kind, arg);
    if (!task) return null;
    tasks.push(task);
    last = close + 1;
  }
  pushCss(selector.slice(last));
  if (!tasks.length) return null;
  return { tasks, action };
}

function taskFor(kind, raw) {
  const arg = raw.trim();
  switch (kind) {
    case "has-text":
    case "matches-path":
      return arg ? [kind, unquote(arg)] : null;
    case "min-text-length":
      return /^\d+$/.test(arg) ? [kind, Number(arg)] : null;
    case "upward":
      if (/^\d+$/.test(arg)) return Number(arg) >= 1 && Number(arg) < 256 ? [kind, Number(arg)] : null;
      return arg ? [kind, arg] : null;
    case "xpath":
      return arg ? [kind, unquote(arg)] : null;
    case "matches-css":
    case "matches-css-before":
    case "matches-css-after": {
      // uBO also writes the pseudo-element first: matches-css(before, content: X)
      const pseudo = /^(before|after)\s*,\s*([\s\S]*)$/i.exec(arg);
      const m = /^([-a-z]+)\s*:\s*([\s\S]+)$/i.exec(pseudo ? pseudo[2] : arg);
      if (!m) return null;
      return [pseudo ? `matches-css-${pseudo[1].toLowerCase()}` : kind, m[1].toLowerCase(), unquote(m[2])];
    }
    case "matches-attr": {
      const m = /^("[^"]*"|'[^']*'|[^=]+)(?:=([\s\S]*))?$/.exec(arg);
      return m ? [kind, unquote(m[1]), m[2] === undefined ? "" : unquote(m[2])] : null;
    }
    case "has":
    case "not": {
      const inner = isProcedural(arg) ? parseProcedural(arg, true) : { tasks: [["css", arg]], action: null };
      return inner && arg ? [kind, inner.tasks] : null;
    }
    case "watch-attr":
      return ["watch-attr"]; // a hint to re-run on attribute changes; the runner always does
    default:
      return null;
  }
}
