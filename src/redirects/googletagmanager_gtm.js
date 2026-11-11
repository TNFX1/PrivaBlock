// PrivaBlock stand-in for Google Tag Manager (gtm.js / gtag): events that wait for a callback get it.
(() => {
  "use strict";
  const layer = (window.dataLayer = window.dataLayer || []);
  const call = (item) => {
    const cb = item?.eventCallback;
    if (typeof cb === "function") setTimeout(cb, 1);
  };
  for (const item of layer) call(item);
  layer.push = function (...items) {
    items.forEach(call);
    return Array.prototype.push.apply(this, items);
  };
  window.google_tag_manager = window.google_tag_manager || {};
  if (typeof window.gtag !== "function") window.gtag = function () {
    layer.push(arguments);
  };
})();
