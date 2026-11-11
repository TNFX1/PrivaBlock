// PrivaBlock stand-in for FingerprintJS 2: the API answers with a fixed, meaningless value.
(() => {
  "use strict";
  const id = "0".repeat(32);
  function Fingerprint2() {}
  Fingerprint2.prototype.get = (cb) => setTimeout(() => cb(id, []), 1);
  Fingerprint2.get = (opts, cb) => setTimeout(() => (typeof opts === "function" ? opts : cb)([]), 1);
  Fingerprint2.getPromise = () => Promise.resolve([]);
  Fingerprint2.getV18 = (opts, cb) => setTimeout(() => (typeof opts === "function" ? opts : cb)(id, []), 1);
  Fingerprint2.x64hash128 = () => id;
  window.Fingerprint2 = Fingerprint2;
})();
