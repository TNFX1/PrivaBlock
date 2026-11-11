// PrivaBlock stand-in for Google Analytics analytics.js: ga() works and calls back, nothing is sent.
(() => {
  "use strict";
  const name = window.GoogleAnalyticsObject || "ga";
  const queued = (window[name] && window[name].q) || [];
  const tracker = { get: () => undefined, set: () => {}, send: () => {} };
  const ga = function (...args) {
    const last = args[args.length - 1];
    if (typeof last === "object" && typeof last?.hitCallback === "function") setTimeout(last.hitCallback, 1);
    else if (typeof args[0] === "function") setTimeout(() => args[0](tracker), 1);
  };
  Object.assign(ga, { create: () => tracker, getByName: () => tracker, getAll: () => [tracker], remove: () => {}, loaded: true, answer: 42 });
  window[name] = ga;
  for (const args of queued) ga(...args);
  window.gaplugins = window.gaplugins || {};
})();
