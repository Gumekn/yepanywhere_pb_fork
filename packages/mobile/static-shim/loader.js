(function () {
  var loaded = false;

  function markLoaded() {
    if (loaded || !document.body) return;
    loaded = true;
    document.body.classList.add("is-loaded");
  }

  function updateSlowStatus() {
    window.setTimeout(function () {
      if (loaded || !document.body) return;
      var status = document.querySelector("[data-loader-status]");
      if (status) status.textContent = "Still connecting";
    }, 8000);
  }

  function bindFrameLoad() {
    var frame = document.getElementById("app-frame");
    if (frame) frame.addEventListener("load", markLoaded, { once: true });
    updateSlowStatus();
  }

  window.addEventListener("load", markLoaded, { once: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindFrameLoad, { once: true });
  } else {
    bindFrameLoad();
  }
})();
