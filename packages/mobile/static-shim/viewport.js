// Own the top-level viewport here: the cross-origin app cannot constrain its parent.
// safe-area-inset-bottom exists only on this document. Forward it so the app can
// pad fixed controls without leaving an empty band under the gesture bar.
(function () {
  var SAFE_AREA_MESSAGE = "yep-anywhere:mobile-shell-safe-area";
  var GET_SAFE_AREA_MESSAGE = "yep-anywhere:mobile-shell-get-safe-area";
  var root = document.documentElement;
  var viewport = window.visualViewport;
  var probe = null;

  function readSafeAreaBottom() {
    if (!probe) {
      probe = document.createElement("div");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText =
        "position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px);";
      root.appendChild(probe);
    }
    var value = parseFloat(window.getComputedStyle(probe).paddingBottom);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function publishSafeArea() {
    var frame = document.getElementById("app-frame");
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      { type: SAFE_AREA_MESSAGE, bottom: readSafeAreaBottom() },
      "*",
    );
  }

  function syncViewport() {
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    var height = viewport ? viewport.height : window.innerHeight;
    if (height <= 0) return;
    root.style.setProperty("--shell-viewport-height", height + "px");
    root.style.setProperty("--shell-viewport-top", (viewport ? viewport.offsetTop : 0) + "px");
    // Reset only the shell document, never the app iframe's nested scroll areas.
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    publishSafeArea();
  }

  syncViewport();
  // Insets can arrive after the first layout without a later resize.
  [50, 250, 1000].forEach(function (delay) {
    window.setTimeout(publishSafeArea, delay);
  });
  window.addEventListener("resize", syncViewport);
  window.addEventListener("scroll", syncViewport);
  window.addEventListener("orientationchange", syncViewport);
  if (viewport) {
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
  }
  window.addEventListener("message", function (event) {
    var frame = document.getElementById("app-frame");
    if (!frame || event.source !== frame.contentWindow) return;
    if (!event.data || event.data.type !== GET_SAFE_AREA_MESSAGE) return;
    publishSafeArea();
  });
})();
