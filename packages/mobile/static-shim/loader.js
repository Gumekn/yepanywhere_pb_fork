(function () {
  var APP_READY_MESSAGE = "yep-anywhere:app-ready";
  var FRAME_LOAD_FALLBACK_MS = 6000;
  var loaded = false;
  var frameLoadFallbackTimer = null;

  function markLoaded() {
    if (loaded || !document.body) return;
    loaded = true;
    if (frameLoadFallbackTimer !== null) {
      window.clearTimeout(frameLoadFallbackTimer);
      frameLoadFallbackTimer = null;
    }
    document.body.classList.add("is-loaded");
  }

  function updateSlowStatus() {
    window.setTimeout(function () {
      if (loaded || !document.body) return;
      var status = document.querySelector("[data-loader-status]");
      if (status) status.textContent = "Still connecting";
    }, 8000);
  }

  function markLoadedEventually() {
    if (frameLoadFallbackTimer !== null) return;
    frameLoadFallbackTimer = window.setTimeout(
      markLoaded,
      FRAME_LOAD_FALLBACK_MS
    );
  }

  function bindFrameLoad() {
    var frame = document.getElementById("app-frame");
    if (frame) {
      frame.addEventListener("load", markLoadedEventually, { once: true });
      window.addEventListener("message", function (event) {
        if (event.source !== frame.contentWindow) return;
        if (!event.data || event.data.type !== APP_READY_MESSAGE) return;
        markLoaded();
      });
    } else {
      markLoadedEventually();
    }
    updateSlowStatus();
  }

  window.addEventListener("load", markLoadedEventually, { once: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindFrameLoad, { once: true });
  } else {
    bindFrameLoad();
  }
})();
