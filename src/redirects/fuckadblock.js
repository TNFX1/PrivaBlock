// PrivaBlock stand-in for FuckAdBlock / BlockAdBlock 3.2: always reports that nothing is blocked.
(() => {
  "use strict";
  function Detector() {}
  const p = Detector.prototype;
  p.onDetected = function () {
    return this;
  };
  p.onNotDetected = function (fn) {
    if (typeof fn === "function") setTimeout(fn, 1);
    return this;
  };
  p.on = function (detected, fn) {
    return detected ? this : this.onNotDetected(fn);
  };
  p.check = () => true;
  p.emitEvent = function () {
    return this;
  };
  p.clearEvent = () => {};
  p.setOption = function () {
    return this;
  };
  for (const name of ["FuckAdBlock", "BlockAdBlock", "SniffAdBlock"]) window[name] = Detector;
  for (const name of ["fuckAdBlock", "blockAdBlock", "sniffAdBlock"]) window[name] = new Detector();
})();
