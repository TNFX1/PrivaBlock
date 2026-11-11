// PrivaBlock stand-in for AdSense adsbygoogle.js: the push queue is accepted and nothing is shown.
(() => {
  "use strict";
  window.adsbygoogle = { loaded: true, push: () => {} };
  for (const ins of document.querySelectorAll("ins.adsbygoogle")) ins.setAttribute("data-adsbygoogle-status", "done");
})();
