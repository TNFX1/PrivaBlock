// PrivaBlock scriptlets, run in the page's own JavaScript world (content script, world MAIN) at
// document_start. The calls for this page arrive from the isolated world (see handoff in
// src/core/scriptlets.js) through a documentElement attribute and an event. Names follow the
// uBlock Origin filter syntax; the implementations are PrivaBlock's own.
(() => {
  const ATTR = "data-privablock-sl";
  const root = document.documentElement;
  if (!root) return;

  const win = window;
  const ran = new Set();
  const MAGIC = `PrivaBlock-${Math.random().toString(36).slice(2)}`;
  const { defineProperty, getOwnPropertyDescriptor } = Object;
  // The page's own JSON functions before any scriptlet wraps them, for the scriptlets' own use.
  const nativeParse = JSON.parse;
  const nativeStringify = JSON.stringify;
  const toStr = (v) => {
    try {
      return typeof v === "function" ? Function.prototype.toString.call(v) : String(v);
    } catch {
      return "";
    }
  };

  // ------------------------------------------------------------------ helpers

  /** "/re/flags" → RegExp, anything else → literal substring. Empty → matches everything. */
  function pattern(text) {
    if (text === undefined || text === "" || text === "*") return /^/;
    const re = /^\/(.+)\/([dgimsuy]*)$/.exec(text);
    if (re) {
      try {
        return new RegExp(re[1], re[2].replace("g", ""));
      } catch {
        return /(?!)/; // a broken pattern matches nothing rather than everything
      }
    }
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  /** Like pattern, with "!" in front meaning "does not match". */
  function needle(text = "") {
    const not = text.startsWith("!");
    const re = pattern(not ? text.slice(1) : text);
    return (value) => re.test(toStr(value)) !== not;
  }
  /** A delay filter: "" any, "1000" exactly, "!1000" anything else. */
  function delayMatch(text = "") {
    if (!text) return () => true;
    const not = text.startsWith("!");
    const n = Number(not ? text.slice(1) : text);
    return (d) => (Number(d) === n) !== not;
  }

  const CONSTANTS = {
    undefined: () => undefined, false: () => false, true: () => true, null: () => null, "": () => "",
    noopFunc: () => function () {}, trueFunc: () => () => true, falseFunc: () => () => false,
    throwFunc: () => () => { throw new Error(MAGIC); },
    emptyArr: () => [], emptyObj: () => ({}), "[]": () => [], "{}": () => ({}),
    yes: () => "yes", no: () => "no", NaN: () => NaN, Infinity: () => Infinity,
  };
  /** The value a filter asks for, or `NONE` when it isn't one of the safe constants. */
  const NONE = Symbol("none");
  function constant(raw) {
    if (raw in CONSTANTS) return CONSTANTS[raw]();
    if (/^-?\d{1,5}$/.test(raw) && Math.abs(Number(raw)) <= 32767) return Number(raw);
    const quoted = /^'([^']*)'$/.exec(raw);
    if (quoted) return quoted[1];
    return NONE;
  }

  // owner → Map(prop → { value, listeners }): one accessor per property, shared by every chain through it
  // (several filters hook ytInitialPlayerResponse.adPlacements, .adSlots, .playerAds…).
  const hooks = new WeakMap();

  /**
   * Run `onLast(owner, prop)` on the object at the end of `chain` ("a.b.c" on window), now if the path
   * already exists, and again whenever a link of it is assigned later.
   */
  function onChain(chain, onLast, owner = win) {
    const dot = chain.indexOf(".");
    if (dot < 0) return onLast(owner, chain);
    const prop = chain.slice(0, dot);
    const rest = chain.slice(dot + 1);
    const visit = (v) => {
      if (v instanceof Object) onChain(rest, onLast, v);
    };
    let props = hooks.get(owner);
    const hook = props?.get(prop);
    if (hook) {
      hook.listeners.push(visit);
      return visit(hook.value);
    }
    const desc = getOwnPropertyDescriptor(owner, prop);
    const current = owner[prop];
    visit(current);
    if (desc && (!desc.configurable || desc.get || desc.set)) return;
    const shared = { value: current, listeners: [visit] };
    try {
      defineProperty(owner, prop, {
        configurable: true, enumerable: true,
        get: () => shared.value,
        set: (v) => {
          shared.value = v;
          for (const listener of shared.listeners) listener(v);
        },
      });
      if (!props) hooks.set(owner, (props = new Map()));
      props.set(prop, shared);
    } catch {}
  }

  /** Define `prop` on `owner` with a getter/setter pair; keeps an existing value readable. */
  function trapProperty(owner, prop, { get, set }) {
    const desc = getOwnPropertyDescriptor(owner, prop);
    if (desc && !desc.configurable) return;
    let value = desc && "value" in desc ? desc.value : desc?.get ? desc.get.call(owner) : undefined;
    try {
      defineProperty(owner, prop, {
        configurable: true, enumerable: desc ? desc.enumerable : true,
        get: () => (get ? get(value) : value),
        set: (v) => {
          if (set) set(v);
          value = v;
        },
      });
    } catch {}
  }

  // An abort throws an error with MAGIC in it; keep it out of the page's console and error handlers.
  let errorFilter = false;
  function abort() {
    if (!errorFilter) {
      errorFilter = true;
      win.addEventListener("error", (e) => {
        if (String(e.message || "").includes(MAGIC)) e.preventDefault(), e.stopImmediatePropagation();
      }, true);
    }
    throw new ReferenceError(MAGIC);
  }

  function wrap(owner, name, make) {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = make(original);
    try {
      defineProperty(wrapped, "toString", { value: () => toStr(original), configurable: true });
    } catch {}
    owner[name] = wrapped;
  }

  // Pages with Trusted Types (YouTube: require-trusted-types-for 'script') refuse plain strings as script
  // text, so script edits go through PrivaBlock's own policy. Created once; reused for every edit.
  let policy = null;
  function setText(node, text) {
    if (node.nodeName === "SCRIPT" && win.trustedTypes?.createPolicy) {
      try {
        policy ??= win.trustedTypes.createPolicy("privablock", { createScript: (t) => t });
        node.textContent = policy.createScript(text);
        return;
      } catch {}
    }
    node.textContent = text;
  }

  /** Run `fn` now, when the DOM is ready, and on later DOM changes (throttled). */
  function watchDom(fn, attributes = false) {
    let timer = 0;
    const run = () => {
      timer = 0;
      try {
        fn();
      } catch {}
    };
    run();
    const later = () => (timer ||= setTimeout(run, 50));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    new MutationObserver(later).observe(document, { childList: true, subtree: true, attributes });
  }

  // Values a filter may store in cookies or storage: consent answers and small numbers, nothing else.
  const STORE_VALUES = /^(?:true|false|yes|no|y|n|ok|on|off|accept|accepted|allow|allowed|approved|reject|rejected|deny|denied|necessary|required|essential|nonessential|hide|hidden|checked|unchecked|dismiss|dismissed|done|-?\d{1,5}|)$/i;

  // ------------------------------------------------------------------ JSON and response helpers

  /** Trailing "name, value" pairs of a call → { name: value }. */
  function varargs(list) {
    const out = {};
    for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1];
    return out;
  }

  /**
   * json-prune paths ("a.b", "[]" any array item, "*" any key, "[-]" / "{-}" the array item / property
   * that contains the rest of the path) → prune(obj) = { obj, changed }; null when nothing to remove.
   * Paths in JSONPath form ($…) are left out: they belong to json-edit.
   */
  function pruner(remove, required) {
    const paths = remove.split(/ +/).filter((p) => p && !p.startsWith("$"));
    const needs = required.split(/ +/).filter(Boolean);
    if (!paths.length) return null;
    function find(obj, parts, del) {
      if (!(obj instanceof Object)) return false;
      const [head, ...rest] = parts;
      if ((head === "[-]" || head === "{-}") && rest.length) {
        let found = false;
        const keys = head === "[-]" ? (Array.isArray(obj) ? Object.keys(obj).reverse() : []) : Object.keys(obj);
        for (const k of keys) {
          if (!find(obj[k], rest, false)) continue;
          found = true;
          if (del && Array.isArray(obj)) obj.splice(Number(k), 1);
          else if (del) delete obj[k];
        }
        return found;
      }
      const keys = head === "[]" ? (Array.isArray(obj) ? Object.keys(obj) : []) : head === "*" ? Object.keys(obj) : [head];
      let found = false;
      for (const k of keys) {
        if (!(k in obj)) continue;
        if (!rest.length) {
          found = true;
          if (del) delete obj[k];
        } else if (find(obj[k], rest, del)) found = true;
      }
      return found;
    }
    return (obj) => {
      if (!(obj instanceof Object)) return { obj, changed: false };
      if (needs.length && !needs.every((p) => find(obj, p.split("."), false))) return { obj, changed: false };
      let changed = false;
      for (const p of paths) if (find(obj, p.split("."), true)) changed = true;
      return { obj, changed };
    };
  }

  /**
   * uBO's legacy JSONPath ("jsonq"), as the lists use it:
   *   ..name  .name  name  .*  [n]  [-n]  [*]  [?.a.b]  [?!.a]  [?.a==json]  [?.a=/re/]  [?.a*="x"]  ^=  $=
   * A filter keeps the current nodes that pass it. Without an assignment the matches are removed;
   * trusted calls may end with `=json`, `+={json}` (merge) or `=repl({"regex"|"pattern":…,"replacement":…})`.
   * Returns edit(obj) = { obj, changed }, or null when the query can't be read.
   */
  function jsonq(query, trusted) {
    const steps = [];
    let i = 0;
    let assign = null;
    const q = query.trim();
    if (!q || q.startsWith("v2:")) return null; // RFC 9535 queries: not supported yet
    const name = () => {
      const m = /^(?:\*|[\w$-]+)/.exec(q.slice(i));
      if (!m) return null;
      i += m[0].length;
      return m[0];
    };
    const bracket = () => {
      // up to the matching "]", skipping quoted strings and /regex/ values
      let depth = 0;
      let quote = "";
      for (let j = i; j < q.length; j++) {
        const c = q[j];
        if (quote) {
          if (c === "\\") j++;
          else if (c === quote) quote = "";
        } else if (c === '"' || (c === "/" && q[j - 1] === "=")) quote = c;
        else if (c === "[") depth++;
        else if (c === "]" && --depth === 0) {
          const body = q.slice(i + 1, j);
          i = j + 1;
          return body;
        }
      }
      return null;
    };
    while (i < q.length) {
      if (q.startsWith("..", i)) {
        i += 2;
        const n = name();
        if (!n) return null;
        steps.push(["descend", n]);
      } else if (q[i] === ".") {
        i++;
        const n = name();
        if (!n) return null;
        steps.push(["child", n]);
      } else if (q[i] === "[") {
        const body = bracket();
        if (body === null) return null;
        if (body.startsWith("?")) {
          const f = filterOf(body.slice(1));
          if (!f) return null;
          steps.push(["filter", f]);
        } else if (body === "*" || body === "") steps.push(["child", "*"]);
        else if (/^-?\d+$/.test(body)) steps.push(["index", Number(body)]);
        else steps.push(["child", body.replace(/^(["'])(.*)\1$/, "$2")]);
      } else if (q[i] === "=" || q.startsWith("+=", i)) {
        if (!trusted) return null;
        const plus = q[i] === "+";
        const raw = q.slice(i + (plus ? 2 : 1));
        assign = assignmentOf(plus, raw);
        if (!assign) return null;
        break;
      } else if (i === 0) {
        const n = name();
        if (!n) return null;
        steps.push(["child", n]);
      } else return null;
    }
    if (!steps.length) return null;

    function filterOf(text) {
      const not = text.startsWith("!");
      const m = /^\.?([\w$.-]+?)(?:(==|\*=|\^=|\$=|=)([\s\S]*))?$/.exec(not ? text.slice(1) : text);
      if (!m) return null;
      const path = m[1].split(".");
      let test = () => true;
      if (m[2]) {
        const raw = m[3];
        const re = m[2] === "=" && /^\/.+\/[imsu]*$/.test(raw) ? pattern(raw) : null;
        let value = raw;
        try {
          value = JSON.parse(raw);
        } catch {}
        const str = String(value);
        test = {
          "==": (v) => v === value,
          "*=": (v) => typeof v === "string" && v.includes(str),
          "^=": (v) => typeof v === "string" && v.startsWith(str),
          "$=": (v) => typeof v === "string" && v.endsWith(str),
          "=": (v) => (re ? typeof v === "string" && re.test(v) : v === value),
        }[m[2]];
      }
      return (node) => {
        let v = node;
        for (const p of path) {
          if (!(v instanceof Object) || !(p in v)) return not;
          v = v[p];
        }
        return test(v) !== not;
      };
    }

    function assignmentOf(plus, raw) {
      const repl = /^repl\(([\s\S]*)\)$/.exec(raw);
      try {
        if (repl) {
          const spec = JSON.parse(repl[1]);
          const re = spec.regex ? replacePattern(spec.regex.startsWith("/") ? spec.regex : `/${spec.regex}/`) : null;
          const find = re || (typeof spec.pattern === "string" ? spec.pattern : null);
          if (find === null || typeof spec.replacement !== "string") return null;
          return (v) => (typeof v === "string" ? v.replace(find, spec.replacement) : v);
        }
        const value = JSON.parse(raw);
        const now = (v) => (typeof v === "string" ? v.replaceAll("${now}", String(Date.now())) : v);
        if (plus) return value instanceof Object ? (v) => (v instanceof Object ? Object.assign(v, value) : v) : null;
        return () => now(structuredClone(value));
      } catch {
        return null;
      }
    }

    return (root) => {
      if (!(root instanceof Object)) return { obj: root, changed: false };
      let refs = [{ owner: null, key: null, value: root }];
      steps.forEach(([kind, arg], n) => {
        const last = n === steps.length - 1;
        const next = [];
        for (const r of refs) {
          const v = r.value;
          if (kind === "filter") {
            if (arg(v)) next.push(r);
          } else if (!(v instanceof Object)) continue;
          else if (kind === "child") {
            for (const k of arg === "*" ? Object.keys(v) : [arg]) {
              // an assignment may create the last property
              if (k in v || (last && assign && arg !== "*")) next.push({ owner: v, key: k, value: v[k] });
            }
          } else if (kind === "index") {
            const k = arg < 0 && Array.isArray(v) ? v.length + arg : arg;
            if (k in v) next.push({ owner: v, key: String(k), value: v[k] });
          } else if (kind === "descend") {
            const seen = new Set();
            const walk = (o) => {
              if (!(o instanceof Object) || seen.has(o)) return;
              seen.add(o);
              for (const k of Object.keys(o)) {
                if (arg === "*" || k === arg) next.push({ owner: o, key: k, value: o[k] });
                walk(o[k]);
              }
            };
            walk(v);
          }
        }
        refs = next;
      });
      if (!refs.length) return { obj: root, changed: false };
      if (assign) {
        for (const r of refs) {
          if (r.owner) r.owner[r.key] = assign(r.value);
          else assign(r.value); // += on the root object merges in place
        }
        return { obj: root, changed: true };
      }
      // Remove, array items from the end so indexes stay right.
      const byOwner = new Map();
      for (const r of refs) if (r.owner) (byOwner.get(r.owner) || byOwner.set(r.owner, new Set()).get(r.owner)).add(r.key);
      for (const [owner, keys] of byOwner) {
        if (Array.isArray(owner)) for (const k of [...keys].map(Number).sort((a, b) => b - a)) owner.splice(k, 1);
        else for (const k of keys) delete owner[k];
      }
      return { obj: root, changed: byOwner.size > 0 };
    };
  }

  /** "/re/flags" keeping every flag (g included), for String.replace; a plain string stays a string. */
  function replacePattern(text) {
    if (!text) return null;
    const m = /^\/(.+)\/([dgimsuy]*)$/.exec(text);
    if (!m) return text;
    try {
      return new RegExp(m[1], m[2]);
    } catch {
      return null;
    }
  }

  /** trusted-replace-*-response: text → text. "*" is the whole body; `includes, x` gates it. */
  function replacer(find, replacement, opts) {
    const re = find === "*" ? /^[\s\S]*$/ : replacePattern(find);
    if (!re) return null;
    const gate = opts.includes ? needle(opts.includes) : null;
    return (text) => (gate && !gate(text) ? text : typeof re === "string" ? text.split(re).join(replacement) : text.replace(re, replacement));
  }

  /** An object edit ({ obj, changed }) as a text → text edit of a JSON body. */
  function jsonText(edit) {
    return (text) => {
      let obj;
      try {
        obj = nativeParse(text);
      } catch {
        return text;
      }
      const out = edit(obj);
      return out.changed ? nativeStringify(out.obj) : text;
    };
  }

  /** Requests a call applies to, from its propsToMatch ("url:x method:POST" or a bare URL pattern). */
  function requestFilter(opts) {
    const test = requestTest(opts.propsToMatch || "");
    const stack = opts.stackToMatch ? needle(opts.stackToMatch) : null;
    return test && ((d) => test(d) && (!stack || stack(new Error().stack || "")));
  }

  /** Rewrite the text of matching fetch() responses. */
  function editFetch(opts, edit) {
    const test = requestFilter(opts);
    if (!test) return;
    wrap(win, "fetch", (original) => function (input, init = {}) {
      const promise = original.apply(this, arguments);
      let details = {};
      try {
        const req = input instanceof Request ? input : null;
        details = { url: req ? req.url : String(input), method: (init?.method || req?.method || "GET").toUpperCase() };
      } catch {}
      if (!test(details)) return promise;
      return promise.then((res) => res.clone().text().then((text) => {
        const out = edit(text);
        if (out === text) return res;
        const copy = new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
        for (const k of ["url", "type", "redirected"]) defineProperty(copy, k, { value: res[k] });
        return copy;
      }, () => res));
    });
  }

  /** Rewrite the text (or JSON) of matching XMLHttpRequest responses, read through response / responseText. */
  function editXhr(opts, edit) {
    const test = requestFilter(opts);
    if (!test) return;
    const proto = win.XMLHttpRequest.prototype;
    const textGet = getOwnPropertyDescriptor(proto, "responseText")?.get;
    const responseGet = getOwnPropertyDescriptor(proto, "response")?.get;
    if (!textGet || !responseGet) return;
    const done = new WeakMap(); // xhr → edited text
    const editedText = (xhr) => {
      if (!done.has(xhr)) done.set(xhr, edit(textGet.call(xhr)));
      return done.get(xhr);
    };
    wrap(proto, "open", (original) => function (method, url, ...rest) {
      done.delete(this);
      if (test({ url: String(url), method: String(method).toUpperCase() })) {
        defineProperty(this, "responseText", { configurable: true, get() {
          return this.readyState === 4 ? editedText(this) : textGet.call(this);
        } });
        defineProperty(this, "response", { configurable: true, get() {
          const r = responseGet.call(this);
          if (this.readyState !== 4) return r;
          if (this.responseType === "" || this.responseType === "text") return editedText(this);
          if (this.responseType === "json" && r instanceof Object) {
            try {
              return nativeParse(edit(nativeStringify(r)));
            } catch {
              return r;
            }
          }
          return r;
        } });
      } else {
        delete this.responseText;
        delete this.response;
      }
      return original.call(this, method, url, ...rest);
    });
  }

  /** Edit argument `pos` of calls to `chain` (e.g. JSON.stringify) with a jsonq edit; a copy is edited. */
  function editInbound(chain, pos, edit) {
    const dot = chain.lastIndexOf(".");
    const at = Number(pos);
    if (!edit || !Number.isInteger(at)) return;
    let owner = win;
    if (dot > 0) for (const part of chain.slice(0, dot).split(".")) owner = owner?.[part];
    if (!owner) return;
    const parse = nativeParse;
    const stringify = nativeStringify;
    wrap(owner, chain.slice(dot + 1), (original) => function (...args) {
      const k = at < 0 ? args.length + at : at;
      if (args[k] instanceof Object) {
        try {
          const copy = parse(stringify(args[k]));
          const out = edit(copy);
          if (out.changed) args[k] = out.obj;
        } catch {}
      }
      return original.apply(this, args);
    });
  }

  // ------------------------------------------------------------------ scriptlets

  const S = {
    "set-constant"(chain, raw) {
      if (!chain) return;
      const value = constant(raw);
      if (value === NONE) return;
      onChain(chain, (owner, prop) => trapProperty(owner, prop, { get: () => value }));
    },

    "abort-on-property-read"(chain) {
      if (chain) onChain(chain, (owner, prop) => trapProperty(owner, prop, { get: abort }));
    },

    "abort-on-property-write"(chain) {
      if (chain) onChain(chain, (owner, prop) => trapProperty(owner, prop, { set: abort }));
    },

    "abort-current-script"(chain, text, context) {
      if (!chain) return;
      const match = needle(text);
      const ctx = needle(context);
      const check = () => {
        const s = document.currentScript;
        if (!(s instanceof HTMLScriptElement)) return;
        const source = s.src || s.textContent;
        if (match(source) && ctx(source)) abort();
      };
      onChain(chain, (owner, prop) => trapProperty(owner, prop, { get: (v) => (check(), v), set: check }));
    },

    "abort-on-stack-trace"(chain, text) {
      if (!chain) return;
      const match = needle(text);
      const check = () => match(new Error().stack || "") && abort();
      onChain(chain, (owner, prop) => trapProperty(owner, prop, { get: (v) => (check(), v), set: check }));
    },

    "json-prune"(remove = "", required = "", stack = "") {
      const prune = pruner(remove, required);
      const fromStack = stack ? needle(stack) : null;
      if (!prune) return;
      const apply = (obj) => (!fromStack || fromStack(new Error().stack || "") ? prune(obj).obj : obj);
      wrap(JSON, "parse", (parse) => function (...args) {
        return apply(parse.apply(this, args));
      });
      wrap(win.Response.prototype, "json", (json) => function (...args) {
        return json.apply(this, args).then(apply);
      });
    },

    "json-prune-fetch-response"(remove = "", required = "", ...rest) {
      const prune = pruner(remove, required);
      if (prune) editFetch(varargs(rest), jsonText((obj) => prune(obj)));
    },

    "json-prune-xhr-response"(remove = "", required = "", ...rest) {
      const prune = pruner(remove, required);
      if (prune) editXhr(varargs(rest), jsonText((obj) => prune(obj)));
    },

    "json-edit"(query = "") {
      const edit = jsonq(query, false);
      if (edit) wrap(JSON, "parse", (parse) => function (...args) {
        return edit(parse.apply(this, args)).obj;
      });
    },

    "json-edit-fetch-response"(query = "", ...rest) {
      const edit = jsonq(query, false);
      if (edit) editFetch(varargs(rest), jsonText(edit));
    },

    "json-edit-xhr-response"(query = "", ...rest) {
      const edit = jsonq(query, false);
      if (edit) editXhr(varargs(rest), jsonText(edit));
    },

    "trusted-json-edit"(query = "") {
      const edit = jsonq(query, true);
      if (edit) wrap(JSON, "parse", (parse) => function (...args) {
        return edit(parse.apply(this, args)).obj;
      });
    },

    "trusted-json-edit-fetch-response"(query = "", ...rest) {
      const edit = jsonq(query, true);
      if (edit) editFetch(varargs(rest), jsonText(edit));
    },

    "trusted-json-edit-xhr-response"(query = "", ...rest) {
      const edit = jsonq(query, true);
      if (edit) editXhr(varargs(rest), jsonText(edit));
    },

    "edit-inbound-object"(chain = "", pos = "", query = "") {
      editInbound(chain, pos, jsonq(query, false));
    },

    "trusted-edit-inbound-object"(chain = "", pos = "", query = "") {
      editInbound(chain, pos, jsonq(query, true));
    },

    "trusted-replace-fetch-response"(find = "", replacement = "", props = "", ...rest) {
      const swap = replacer(find, replacement, varargs(rest));
      if (swap) editFetch({ propsToMatch: props }, swap);
    },

    "trusted-replace-xhr-response"(find = "", replacement = "", props = "", ...rest) {
      const swap = replacer(find, replacement, varargs(rest));
      if (swap) editXhr({ propsToMatch: props }, swap);
    },

    // Code in an iframe the page adds would run without these scriptlets: give it the parent's
    // `targetProp` (e.g. fetch), or the parent window itself.
    "trusted-prevent-dom-bypass"(methodPath = "", targetProp = "") {
      const dot = methodPath.lastIndexOf(".");
      if (dot < 0) return;
      let owner = win;
      for (const part of methodPath.slice(0, dot).split(".")) owner = owner?.[part];
      if (!owner) return;
      const fix = (node) => {
        const frames = node instanceof win.HTMLIFrameElement ? [node] : node?.querySelectorAll ? [...node.querySelectorAll("iframe")] : [];
        for (const frame of frames) {
          try {
            if (targetProp) {
              const w = frame.contentWindow;
              if (w && w[targetProp] !== win[targetProp]) w[targetProp] = win[targetProp];
            } else defineProperty(frame, "contentWindow", { get: () => win, configurable: true });
          } catch {}
        }
      };
      wrap(owner, methodPath.slice(dot + 1), (original) => function (...args) {
        const out = original.apply(this, args);
        for (const a of args) fix(a);
        return out;
      });
    },

    "replace-node-text"(nodeName = "", find = "", replacement = "", ...rest) {
      const name = nodeName.toLowerCase();
      const re = replacePattern(find);
      if (!name || !re) return;
      const opts = varargs(rest);
      const includes = opts.includes || opts.condition ? needle(opts.includes || opts.condition) : null;
      const excludes = opts.excludes ? needle(opts.excludes) : null;
      let left = Number(opts.sedCount) || Infinity;
      const edit = (node) => {
        if (!node || node.nodeName.toLowerCase() !== name || left <= 0) return;
        const text = node.textContent;
        if (!text || (includes && !includes(text)) || (excludes && excludes(text))) return;
        const out = text.replace(re, replacement);
        if (out === text) return;
        try {
          setText(node, out);
        } catch {
          return;
        }
        if (--left <= 0) observer.disconnect();
      };
      // Mutation records arrive before a parser-inserted script runs; its text may come as a later child.
      const observer = new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) edit(n.nodeType === 3 && name !== "#text" ? n.parentNode : n);
      });
      observer.observe(document, { childList: true, subtree: true });
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
      while (walker.nextNode()) edit(walker.currentNode);
      if (opts.stay) return;
      const quit = () => setTimeout(() => observer.disconnect(), Number(opts.quitAfter) || 0);
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", quit, { once: true });
      else quit();
    },

    "no-setTimeout-if"(text, delay) {
      const match = needle(text);
      const when = delayMatch(delay);
      wrap(win, "setTimeout", (original) => function (fn, ms, ...rest) {
        if (match(fn) && when(ms)) return original.call(this, () => {}, ms);
        return original.call(this, fn, ms, ...rest);
      });
    },

    "no-setInterval-if"(text, delay) {
      const match = needle(text);
      const when = delayMatch(delay);
      wrap(win, "setInterval", (original) => function (fn, ms, ...rest) {
        if (match(fn) && when(ms)) return original.call(this, () => {}, ms);
        return original.call(this, fn, ms, ...rest);
      });
    },

    "adjust-setTimeout"(text, delay = "1000", boost = "0.05") {
      adjustTimer("setTimeout", text, delay, boost);
    },

    "adjust-setInterval"(text, delay = "1000", boost = "0.05") {
      adjustTimer("setInterval", text, delay, boost);
    },

    "addEventListener-defuser"(type, text) {
      const typeMatch = needle(type);
      const match = needle(text);
      wrap(win.EventTarget.prototype, "addEventListener", (original) => function (t, handler, ...rest) {
        if (typeMatch(t) && match(handler)) return undefined;
        return original.call(this, t, handler, ...rest);
      });
    },

    "no-window-open-if"(text) {
      const match = needle(text);
      // A stand-in window: pages that check the result of window.open keep working.
      const decoy = () => new Proxy({}, {
        get: (_, p) => (p === "closed" ? false : p === "document" ? document.implementation.createHTMLDocument("") : function () {}),
        set: () => true,
      });
      wrap(win, "open", (original) => function (url, ...rest) {
        if (match(url ?? "")) return decoy();
        return original.call(this, url, ...rest);
      });
    },

    "no-fetch-if"(props = "", body = "") {
      const test = requestTest(props);
      if (!test) return;
      const text = body === "emptyObj" ? "{}" : body === "emptyArr" ? "[]" : "";
      wrap(win, "fetch", (original) => function (input, init = {}) {
        let details = {};
        try {
          const req = input instanceof Request ? input : null;
          details = { url: req ? req.url : String(input), method: (init.method || req?.method || "GET").toUpperCase() };
        } catch {}
        if (test(details)) return Promise.resolve(new Response(text, { status: 200, statusText: "OK" }));
        return original.call(this, input, init);
      });
    },

    "no-xhr-if"(props = "") {
      const test = requestTest(props);
      if (!test) return;
      const blocked = new WeakSet();
      const proto = win.XMLHttpRequest.prototype;
      wrap(proto, "open", (original) => function (method, url, ...rest) {
        if (test({ url: String(url), method: String(method).toUpperCase() })) blocked.add(this);
        return original.call(this, method, url, ...rest);
      });
      wrap(proto, "send", (original) => function (...args) {
        if (!blocked.has(this)) return original.apply(this, args);
        // Finish as an empty 200 without touching the network.
        for (const [k, v] of [["readyState", 4], ["status", 200], ["statusText", "OK"], ["response", ""], ["responseText", ""]]) {
          try {
            defineProperty(this, k, { value: v, configurable: true });
          } catch {}
        }
        setTimeout(() => {
          for (const type of ["readystatechange", "load", "loadend"]) this.dispatchEvent(new Event(type));
        }, 1);
      });
    },

    "noeval-if"(text) {
      const match = needle(text);
      wrap(win, "eval", (original) => function (code) {
        if (match(code)) return undefined;
        return original.call(this, code);
      });
    },

    noeval() {
      wrap(win, "eval", () => function () {});
    },

    nowebrtc() {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
        if (typeof win[name] !== "function") continue;
        const Fake = function () {};
        for (const m of ["close", "createDataChannel", "createOffer", "setRemoteDescription", "addIceCandidate", "addEventListener", "removeEventListener"]) {
          Fake.prototype[m] = () => (m.startsWith("create") || m.startsWith("set") || m.startsWith("add") ? Promise.resolve() : undefined);
        }
        win[name] = Fake;
      }
    },

    "remove-attr"(attrs = "", selector = "") {
      const names = attrs.split(/\s*\|\s*/).filter((a) => /^[\w-]+$/.test(a));
      if (!names.length) return;
      const sel = selector || names.map((a) => `[${a}]`).join(",");
      watchDom(() => {
        for (const el of document.querySelectorAll(sel)) for (const a of names) el.removeAttribute(a);
      }, true);
    },

    "remove-class"(classes = "", selector = "") {
      const names = classes.split(/\s*\|\s*/).filter((c) => /^[\w-]+$/.test(c));
      if (!names.length) return;
      const sel = selector || names.map((c) => `.${CSS.escape(c)}`).join(",");
      watchDom(() => {
        for (const el of document.querySelectorAll(sel)) el.classList.remove(...names);
      }, true);
    },

    "remove-node-text"(nodeName = "", text = "") {
      const name = nodeName.toLowerCase();
      const match = needle(text);
      if (!name || !text) return;
      const clean = (node) => {
        if (node.nodeName.toLowerCase() === name && match(node.textContent)) setText(node, "");
      };
      // Mutation records arrive before a parser-inserted script runs, so its text can be emptied first.
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) clean(n);
      }).observe(document, { childList: true, subtree: true });
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
      while (walker.nextNode()) clean(walker.currentNode);
    },

    "set-cookie"(name = "", value = "", path = "") {
      if (!/^[\w.-]+$/.test(name) || !STORE_VALUES.test(value)) return;
      const current = document.cookie.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
      if (current === `${name}=${value}`) return;
      const where = path === "none" ? "" : `; path=${path === "/" || !path ? "/" : path}`;
      document.cookie = `${name}=${encodeURIComponent(value)}${where}; max-age=31536000; SameSite=Lax`;
    },

    "remove-cookie"(text) {
      const match = needle(text);
      const remove = () => {
        for (const c of document.cookie.split(/;\s*/)) {
          const name = c.slice(0, c.indexOf("=") >>> 0);
          if (!name || !match(name)) continue;
          const expire = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
          document.cookie = expire;
          document.cookie = `${expire}; path=/`;
          for (let d = location.hostname; d.includes("."); d = d.slice(d.indexOf(".") + 1)) document.cookie = `${expire}; path=/; domain=.${d}`;
        }
      };
      remove();
      win.addEventListener("beforeunload", remove);
      document.addEventListener("visibilitychange", remove);
    },

    "set-local-storage-item"(key, value) {
      setStorage("localStorage", key, value);
    },

    "set-session-storage-item"(key, value) {
      setStorage("sessionStorage", key, value);
    },
  };

  function adjustTimer(name, text, delay, boost) {
    const match = needle(text);
    const when = delayMatch(delay === "*" ? "" : delay);
    const factor = Math.min(50, Math.max(0.001, Number(boost) || 0.05));
    wrap(win, name, (original) => function (fn, ms, ...rest) {
      if (match(fn) && when(ms)) ms = Math.round((Number(ms) || 0) * factor);
      return original.call(this, fn, ms, ...rest);
    });
  }

  /** "url:x method:POST" (or a bare pattern for the URL) → a test of { url, method }; null if malformed. */
  function requestTest(props) {
    if (!props || props === "*") return () => true;
    const tests = [];
    for (const part of props.split(/\s+(?=\w+:)/)) {
      const m = /^(url|method):([\s\S]*)$/.exec(part);
      if (m) tests.push([m[1], needle(m[2])]);
      else if (/^\w+:/.test(part)) return null; // a request property PrivaBlock doesn't know
      else tests.push(["url", needle(part)]);
    }
    return (d) => tests.every(([k, t]) => t(d[k] ?? ""));
  }

  function setStorage(area, key, value = "") {
    if (!key) return;
    try {
      if (value === "$remove$") win[area].removeItem(key);
      else if (value === "emptyArr" || value === "emptyObj") win[area].setItem(key, value === "emptyArr" ? "[]" : "{}");
      else if (STORE_VALUES.test(value) || ["undefined", "null"].includes(value)) win[area].setItem(key, value);
    } catch {}
  }

  // ------------------------------------------------------------------ calls from the isolated world

  function take() {
    const raw = root.getAttribute(ATTR);
    if (raw === null) return;
    root.removeAttribute(ATTR);
    let calls = [];
    try {
      calls = JSON.parse(raw);
    } catch {}
    for (const call of Array.isArray(calls) ? calls : []) {
      const key = JSON.stringify(call);
      if (ran.has(key) || !Array.isArray(call) || !S[call[0]]) continue;
      ran.add(key);
      try {
        S[call[0]](...call.slice(1).map(String));
      } catch {}
    }
  }
  document.addEventListener("privablock-sl", take);
  take();
})();
