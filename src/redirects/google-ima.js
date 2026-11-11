// PrivaBlock stand-in for the Google IMA SDK (imasdk.googleapis.com/js/sdkloader/ima3.js), served when a
// filter list redirects the SDK. It offers the API players call and answers every ad request with
// "no ads" (an empty VAST response), so the player goes straight to the video.
(() => {
  "use strict";
  if (window.google?.ima?.AdsLoader) return;

  class Listeners {
    #map = new Map();
    addEventListener(types, fn, _capture, scope) {
      for (const type of [].concat(types)) {
        if (!this.#map.has(type)) this.#map.set(type, []);
        this.#map.get(type).push({ fn, scope });
      }
    }
    removeEventListener(types, fn) {
      for (const type of [].concat(types)) this.#map.set(type, (this.#map.get(type) || []).filter((l) => l.fn !== fn));
    }
    _emit(event) {
      for (const { fn, scope } of this.#map.get(event.type) || []) {
        try {
          if (typeof fn === "function") fn.call(scope, event);
          else fn?.handleEvent?.(event);
        } catch (error) {
          setTimeout(() => {
            throw error;
          });
        }
      }
    }
  }

  const later = (fn) => setTimeout(fn, 0);
  const noop = () => {};

  class AdError {
    getErrorCode() {
      return 1009; // VAST_EMPTY_RESPONSE
    }
    getVastErrorCode() {
      return 303; // no ads after wrapper / empty response
    }
    getMessage() {
      return "The VAST response document is empty.";
    }
    getType() {
      return AdError.Type.AD_LOAD;
    }
    getInnerError() {
      return null;
    }
    toString() {
      return `AdError ${this.getErrorCode()}: ${this.getMessage()}`;
    }
  }
  AdError.Type = { AD_LOAD: "adLoadError", AD_PLAY: "adPlayError" };
  AdError.ErrorCode = {
    VAST_EMPTY_RESPONSE: 1009, VAST_NO_ADS_AFTER_WRAPPER: 303, UNKNOWN_ERROR: 900, ADS_REQUEST_NETWORK_ERROR: 1012,
    FAILED_TO_REQUEST_ADS: 1005, VAST_LOAD_TIMEOUT: 301, VIDEO_PLAY_ERROR: 400, AUTOPLAY_DISALLOWED: 1205,
  };

  class AdErrorEvent {
    constructor(error, userRequestContext) {
      this.type = AdErrorEvent.Type.AD_ERROR;
      this._error = error;
      this._context = userRequestContext;
    }
    getError() {
      return this._error;
    }
    getUserRequestContext() {
      return this._context ?? null;
    }
  }
  AdErrorEvent.Type = { AD_ERROR: "adError" };

  class AdEvent {
    constructor(type) {
      this.type = type;
    }
    getAd() {
      return null;
    }
    getAdData() {
      return {};
    }
  }
  AdEvent.Type = {
    AD_BREAK_READY: "adBreakReady", AD_BUFFERING: "adBuffering", AD_CAN_PLAY: "adCanPlay", AD_METADATA: "adMetadata",
    AD_PROGRESS: "adProgress", ALL_ADS_COMPLETED: "allAdsCompleted", CLICK: "click", COMPLETE: "complete",
    CONTENT_PAUSE_REQUESTED: "contentPauseRequested", CONTENT_RESUME_REQUESTED: "contentResumeRequested",
    DURATION_CHANGE: "durationChange", FIRST_QUARTILE: "firstQuartile", IMPRESSION: "impression",
    INTERACTION: "interaction", LINEAR_CHANGED: "linearChanged", LOADED: "loaded", LOG: "log",
    MIDPOINT: "midpoint", PAUSED: "pause", RESUMED: "resume", SKIPPABLE_STATE_CHANGED: "skippableStateChanged",
    SKIPPED: "skip", STARTED: "start", THIRD_QUARTILE: "thirdQuartile", USER_CLOSE: "userClose",
    VIDEO_CLICKED: "videoClicked", VIDEO_ICON_CLICKED: "videoIconClicked", VOLUME_CHANGED: "volumeChange",
    VOLUME_MUTED: "mute",
  };

  class AdsManager extends Listeners {
    #volume = 1;
    init() {}
    start() {
      // Nothing to show: tell the player to carry on with the video.
      later(() => {
        this._emit(new AdEvent(AdEvent.Type.CONTENT_RESUME_REQUESTED));
        this._emit(new AdEvent(AdEvent.Type.ALL_ADS_COMPLETED));
      });
    }
    getCuePoints() {
      return [];
    }
    getRemainingTime() {
      return 0;
    }
    getAdSkippableState() {
      return false;
    }
    getVolume() {
      return this.#volume;
    }
    setVolume(v) {
      this.#volume = v;
    }
    isCustomClickTrackingUsed() {
      return false;
    }
    isCustomPlaybackUsed() {
      return false;
    }
  }
  for (const m of ["clicked", "collapse", "configureAdsManager", "destroy", "discardAdBreak", "expand", "focus", "pause", "resize", "resume", "setAutoPlayAdBreaks", "skip", "stop", "updateAdsRenderingSettings"]) {
    AdsManager.prototype[m] = noop;
  }

  class AdsManagerLoadedEvent {
    constructor(context) {
      this.type = AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED;
      this._context = context;
    }
    getAdsManager() {
      return new AdsManager();
    }
    getUserRequestContext() {
      return this._context ?? null;
    }
  }
  AdsManagerLoadedEvent.Type = { ADS_MANAGER_LOADED: "adsManagerLoaded" };

  class ImaSdkSettings {
    #values = { locale: "", numRedirects: 4, playerType: "", playerVersion: "", ppid: "", vpaidMode: 0, autoPlayAdBreaks: true, cookiesEnabled: true };
    getCompanionBackfill() {
      return "always";
    }
    getDisableCustomPlaybackForIOS10Plus() {
      return false;
    }
    getFeatureFlags() {
      return {};
    }
    getLocale() {
      return this.#values.locale;
    }
    getNumRedirects() {
      return this.#values.numRedirects;
    }
    getPlayerType() {
      return this.#values.playerType;
    }
    getPlayerVersion() {
      return this.#values.playerVersion;
    }
    getPpid() {
      return this.#values.ppid;
    }
    getVpaidMode() {
      return this.#values.vpaidMode;
    }
    isCookiesEnabled() {
      return this.#values.cookiesEnabled;
    }
    isVpaidAdapter() {
      return false;
    }
    setLocale(v) {
      this.#values.locale = v;
    }
    setNumRedirects(v) {
      this.#values.numRedirects = v;
    }
    setPlayerType(v) {
      this.#values.playerType = v;
    }
    setPlayerVersion(v) {
      this.#values.playerVersion = v;
    }
    setPpid(v) {
      this.#values.ppid = v;
    }
    setVpaidMode(v) {
      this.#values.vpaidMode = v;
    }
    setCookiesEnabled(v) {
      this.#values.cookiesEnabled = v;
    }
  }
  for (const m of ["setAutoPlayAdBreaks", "setCompanionBackfill", "setDisableCustomPlaybackForIOS10Plus", "setFeatureFlags", "setSessionId", "setVpaidAllowed", "setIsVpaidAdapter"]) {
    ImaSdkSettings.prototype[m] = noop;
  }
  ImaSdkSettings.CompanionBackfillMode = { ALWAYS: "always", ON_MASTER_AD: "on_master_ad" };
  ImaSdkSettings.VpaidMode = { DISABLED: 0, ENABLED: 1, INSECURE: 2 };

  const settings = new ImaSdkSettings();

  class AdsLoader extends Listeners {
    constructor(container) {
      super();
      this._container = container;
    }
    getSettings() {
      return settings;
    }
    requestAds(_request, userRequestContext) {
      later(() => this._emit(new AdErrorEvent(new AdError(), userRequestContext)));
    }
    contentComplete() {}
    destroy() {}
    getVersion() {
      return ima.VERSION;
    }
  }

  class AdDisplayContainer {
    constructor(container, video) {
      this._container = container;
      this._video = video;
    }
    initialize() {}
    destroy() {}
  }

  class AdsRequest {
    constructor() {
      Object.assign(this, {
        adTagUrl: "", adsResponse: null, forceNonLinearFullSlot: false, linearAdSlotWidth: 0, linearAdSlotHeight: 0,
        nonLinearAdSlotWidth: 0, nonLinearAdSlotHeight: 0, vastLoadTimeout: 5000,
      });
    }
  }
  for (const m of ["setAdWillAutoPlay", "setAdWillPlayMuted", "setContinuousPlayback", "setLiveStreamPrefetchSeconds", "setOmidAccessModeRules"]) {
    AdsRequest.prototype[m] = noop;
  }

  class AdsRenderingSettings {
    constructor() {
      Object.assign(this, {
        autoAlign: true, bitrate: -1, enablePreloading: false, loadVideoTimeout: 8000, mimeTypes: null,
        playAdsAfterTime: -1, restoreCustomPlaybackStateOnAdBreakComplete: false, uiElements: null, useStyledLinearAds: false,
        useStyledNonLinearAds: false,
      });
    }
  }

  class CompanionAdSelectionSettings {}
  CompanionAdSelectionSettings.CreativeType = { ALL: "All", FLASH: "Flash", IMAGE: "Image" };
  CompanionAdSelectionSettings.ResourceType = { ALL: "All", HTML: "Html", IFRAME: "IFrame", STATIC: "Static" };
  CompanionAdSelectionSettings.SizeCriteria = { IGNORE: "IgnoreSize", SELECT_EXACT_MATCH: "SelectExactMatch", SELECT_NEAR_MATCH: "SelectNearMatch" };

  const ima = {
    AdDisplayContainer, AdError, AdErrorEvent, AdEvent, AdsLoader, AdsManager, AdsManagerLoadedEvent, AdsRenderingSettings,
    AdsRequest, CompanionAdSelectionSettings, ImaSdkSettings,
    OmidAccessMode: { DOMAIN: "domain", FULL: "full", LIMITED: "limited" },
    OmidVerificationVendor: { COMSCORE: 7, DOUBLEVERIFY: 3, GOOGLE: 9, IAS: 2, INTEGRAL_AD_SCIENCE: 2, MOAT: 4, NIELSEN: 6, OTHER: 1 },
    UiElements: { AD_ATTRIBUTION: "adAttribution", COUNTDOWN: "countdown" },
    ViewMode: { FULLSCREEN: "fullscreen", NORMAL: "normal" },
    VERSION: "3.0.0",
    settings,
  };
  window.google = window.google || {};
  window.google.ima = ima;
})();
