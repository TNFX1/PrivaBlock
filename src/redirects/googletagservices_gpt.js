// PrivaBlock stand-in for Google Publisher Tag (gpt.js): the googletag API with no ads. Queued commands run.
(() => {
  "use strict";
  const noop = () => {};
  const chain = function () {
    return this;
  };
  const slot = (path = "", sizes = [], div = "") => {
    const s = {};
    for (const m of ["addService", "clearCategoryExclusions", "clearTargeting", "defineSizeMapping", "set", "setCategoryExclusion", "setClickUrl", "setCollapseEmptyDiv", "setConfig", "setForceSafeFrame", "setSafeFrameConfig", "setTargeting", "updateTargetingFromMap"]) s[m] = chain;
    Object.assign(s, {
      get: () => null, getAdUnitPath: () => path, getAttributeKeys: () => [], getCategoryExclusions: () => [], getConfig: () => ({}),
      getDomId: () => div, getResponseInformation: () => null, getSlotElementId: () => div, getSlotId: () => ({ getId: () => `${path}_0`, getAdUnitPath: () => path, getDomId: () => div }),
      getSizes: () => sizes, getTargeting: () => [], getTargetingKeys: () => [], getTargetingMap: () => ({}),
    });
    return s;
  };
  const service = () => {
    const s = { addEventListener: chain, removeEventListener: chain, getSlots: () => [], getSlotIdMap: () => ({}), getTargeting: () => [], getTargetingKeys: () => [] };
    for (const m of ["clear", "clearCategoryExclusions", "clearTargeting", "collapseEmptyDivs", "defineOutOfPagePassback", "definePassback", "disableInitialLoad", "display", "enableAsyncRendering", "enableLazyLoad", "enableSingleRequest", "enableSyncRendering", "enableVideoAds", "refresh", "set", "setCategoryExclusion", "setCentering", "setConfig", "setCookieOptions", "setForceSafeFrame", "setLocation", "setPrivacySettings", "setPublisherProvidedId", "setRequestNonPersonalizedAds", "setSafeFrameConfig", "setTagForChildDirectedTreatment", "setTargeting", "setVideoContent", "updateCorrelator"]) s[m] = chain;
    return s;
  };
  const pubads = service();
  const companion = service();
  const content = service();
  const queue = window.googletag?.cmd || [];
  const run = (fn) => {
    try {
      fn();
    } catch {}
  };
  const gt = {
    apiReady: true, pubadsReady: true,
    cmd: { push: (...fns) => (fns.forEach(run), 0) },
    pubads: () => pubads, companionAds: () => companion, content: () => content,
    defineSlot: (path, sizes, div) => slot(path, sizes, div), defineOutOfPageSlot: (path, div) => slot(path, [], div),
    destroySlots: () => true, display: noop, enableServices: noop, getVersion: () => "", disablePublisherConsole: noop,
    onPubadsReady: noop, openConsole: noop, setAdIframeTitle: noop, setConfig: noop,
    sizeMapping: () => ({ addSize: chain, build: () => [] }),
    enums: { OutOfPageFormat: { BOTTOM_ANCHOR: 3, INTERSTITIAL: 5, REWARDED: 4, TOP_ANCHOR: 2 }, TrafficSource: { ORGANIC: 0, PURCHASED: 1 } },
    secureSignalProviders: { push: noop, clearAllCache: noop },
  };
  window.googletag = gt;
  for (const fn of Array.from(queue)) run(fn);
})();
