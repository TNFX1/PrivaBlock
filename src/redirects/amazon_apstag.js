// PrivaBlock stand-in for Amazon Publisher Services apstag.js: bids come back empty.
(() => {
  "use strict";
  const noop = () => {};
  window.apstag = {
    _Q: [], init: noop, setDisplayBids: noop, targetingKeys: () => [], thirdPartyData: {},
    fetchBids: (_cfg, cb) => typeof cb === "function" && setTimeout(() => cb([]), 1),
  };
})();
