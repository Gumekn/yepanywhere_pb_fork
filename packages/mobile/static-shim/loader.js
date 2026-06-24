(function () {
  var APP_READY_MESSAGE = "yep-anywhere:app-ready";
  var CHANNEL_STATUS_MESSAGE = "yep-anywhere:mobile-shell-channel";
  var GET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-get-channel";
  var SET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-set-channel";
  var CHANNEL_STORAGE_KEY = "yep-anywhere-mobile-channel";
  var DEFAULT_CHANNEL = "tcp";
  var FRAME_LOAD_FALLBACK_MS = 6000;
  var SLOW_STATUS_MS = 8000;
  var CHANNELS = {
    tcp: {
      status: "Connecting via TCP",
      origin: "http://123.56.106.49:37160"
    },
    http: {
      status: "Connecting via HTTP",
      origin: "https://air.yueyuan.uk"
    }
  };
  var loaded = false;
  var frameLoadFallbackTimer = null;
  var slowStatusTimer = null;
  var activeChannel = DEFAULT_CHANNEL;

  function isValidChannel(channel) {
    return Object.prototype.hasOwnProperty.call(CHANNELS, channel);
  }

  function getStoredChannel() {
    try {
      var value = window.localStorage.getItem(CHANNEL_STORAGE_KEY);
      return isValidChannel(value) ? value : null;
    } catch (_err) {
      return null;
    }
  }

  function getRequestedChannel() {
    try {
      var value = new URLSearchParams(window.location.search).get("channel");
      return isValidChannel(value) ? value : null;
    } catch (_err) {
      return null;
    }
  }

  function storeChannel(channel) {
    try {
      window.localStorage.setItem(CHANNEL_STORAGE_KEY, channel);
    } catch (_err) {
      // Storage can be unavailable in restricted WebView modes.
    }
  }

  function normalizeAppPath(path) {
    if (typeof path !== "string" || path.charAt(0) !== "/") {
      return "/yep/";
    }
    return path.indexOf("/yep") === 0 ? path : "/yep" + path;
  }

  function getFrameUrl(channel, path) {
    var url = new URL(CHANNELS[channel].origin + normalizeAppPath(path));
    if (!path && window.location.hash) {
      url.hash = window.location.hash;
    }
    url.searchParams.set("yep-mobile-shell", "1");
    return url.toString();
  }

  function getFramePathFromMessage(data) {
    return data && typeof data.path === "string" ? data.path : null;
  }

  function updateStatus(text) {
    var status = document.querySelector("[data-loader-status]");
    if (status) status.textContent = text;
  }

  function postChannelStatus() {
    var frame = document.getElementById("app-frame");
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      { type: CHANNEL_STATUS_MESSAGE, channel: activeChannel },
      "*"
    );
  }

  function clearTimers() {
    if (frameLoadFallbackTimer !== null) {
      window.clearTimeout(frameLoadFallbackTimer);
      frameLoadFallbackTimer = null;
    }
    if (slowStatusTimer !== null) {
      window.clearTimeout(slowStatusTimer);
      slowStatusTimer = null;
    }
  }

  function resetLoading(channel) {
    loaded = false;
    clearTimers();
    if (document.body) document.body.classList.remove("is-loaded");
    updateStatus(CHANNELS[channel].status);
  }

  function markLoaded() {
    if (loaded || !document.body) return;
    loaded = true;
    clearTimers();
    document.body.classList.add("is-loaded");
  }

  function updateSlowStatus() {
    if (slowStatusTimer !== null) window.clearTimeout(slowStatusTimer);
    slowStatusTimer = window.setTimeout(function () {
      if (loaded || !document.body) return;
      updateStatus("Still connecting");
    }, SLOW_STATUS_MS);
  }

  function markLoadedEventually() {
    if (frameLoadFallbackTimer !== null) return;
    frameLoadFallbackTimer = window.setTimeout(
      markLoaded,
      FRAME_LOAD_FALLBACK_MS
    );
  }

  function loadChannel(channel, options) {
    if (!isValidChannel(channel)) channel = DEFAULT_CHANNEL;
    activeChannel = channel;
    if (!options || options.persist !== false) storeChannel(channel);
    resetLoading(channel);

    var frame = document.getElementById("app-frame");
    if (!frame) {
      markLoadedEventually();
      return;
    }

    frame.onload = markLoadedEventually;
    frame.src = getFrameUrl(channel, options && options.path);
    updateSlowStatus();
  }

  function bindFrameLoad() {
    var frame = document.getElementById("app-frame");
    if (frame) {
      window.addEventListener("message", function (event) {
        if (event.source !== frame.contentWindow) return;
        if (!event.data) return;

        if (event.data.type === APP_READY_MESSAGE) {
          markLoaded();
          postChannelStatus();
          return;
        }

        if (event.data.type === GET_CHANNEL_MESSAGE) {
          postChannelStatus();
          return;
        }

        if (event.data.type === SET_CHANNEL_MESSAGE) {
          loadChannel(event.data.channel, {
            path: getFramePathFromMessage(event.data)
          });
        }
      });
    } else {
      markLoadedEventually();
    }
    loadChannel(getRequestedChannel() || getStoredChannel() || DEFAULT_CHANNEL, {
      persist: false
    });
  }

  window.addEventListener("load", markLoadedEventually, { once: true });
  window.addEventListener("hashchange", function () {
    var frame = document.getElementById("app-frame");
    if (!frame) return;
    frame.src = getFrameUrl(activeChannel);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindFrameLoad, { once: true });
  } else {
    bindFrameLoad();
  }
})();
