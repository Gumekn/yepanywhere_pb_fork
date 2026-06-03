/**
 * Inline splash control. The splash is defined in index.html / remote.html
 * so it paints the instant the WebView opens — before the JS bundle parses
 * or React mounts. We keep it visible until the first page with real
 * content is actually ready to display, which means the user only ever sees
 *
 *   splash spinner → real page (smooth fade)
 *
 * instead of the previous chain of
 *
 *   splash → connecting spinner → blank → skeleton → real content
 *
 * with multiple flashes between each transition.
 *
 * Hiding is idempotent: any number of callers can request "hide" but only
 * the first one (whose `ready` becomes true) actually fades it out.
 *
 * Safety net: even if no page ever signals ready (e.g. a hung connection
 * loop, an unexpected layout state), we force-hide after MAX_HOLD_MS so
 * the user is never stuck staring at a spinner.
 */

const MAX_HOLD_MS = 6000;

let hideRequested = false;
let safetyTimer: number | null = null;

/** Internal: actually fade and remove the splash element. Idempotent. */
function performHide(): void {
  if (hideRequested) return;
  hideRequested = true;
  if (safetyTimer !== null) {
    window.clearTimeout(safetyTimer);
    safetyTimer = null;
  }

  const splash = document.getElementById("splash");
  if (!splash) return;

  // Wait two frames so React has actually mounted + painted real content
  // beneath the splash. One rAF is when React commits, the second is when
  // the browser paints — fading before paint can leave a momentary blank.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      splash.classList.add("is-hiding");
      const remove = () => splash.remove();
      // Belt-and-braces: also clean up via setTimeout in case transitionend
      // never fires (e.g. reduced-motion or transition cancelled).
      splash.addEventListener("transitionend", remove, { once: true });
      window.setTimeout(remove, 600);
    });
  });
}

/**
 * Arm the splash safety timeout. Call this once from each entry point
 * right after createRoot().render(). After MAX_HOLD_MS the splash will
 * force-hide regardless of page readiness — protects against a stuck
 * connection or an unexpected app state where no page ever signals ready.
 */
export function armSplashSafety(): void {
  if (hideRequested) return;
  if (safetyTimer !== null) return;
  // Skip arming if there's no splash (HMR, dev refresh after splash already
  // gone, tests).
  if (!document.getElementById("splash")) {
    hideRequested = true;
    return;
  }
  safetyTimer = window.setTimeout(performHide, MAX_HOLD_MS);
}

/**
 * Request that the splash hide once `ready` becomes true. Pass `true` from
 * a useEffect once your page's data has loaded and the page is ready to
 * render. Safe to call from multiple components; only the first true
 * triggers the fade.
 *
 * Use this in any "first-paint" location:
 *   - Login pages: useHideSplashOnReady(true) on mount (no data to wait for)
 *   - List pages: useHideSplashOnReady(!loading) so splash stays through fetch
 *   - Error / fallback states: useHideSplashOnReady(true) when shown
 */
export function requestHideSplash(ready: boolean): void {
  if (!ready) return;
  performHide();
}
