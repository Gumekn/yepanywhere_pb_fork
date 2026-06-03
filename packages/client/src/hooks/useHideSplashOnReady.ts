import { useEffect } from "react";
import { requestHideSplash } from "../lib/splash";

/**
 * Request the inline HTML splash hide once `ready` becomes true.
 *
 * Used by first-paint screens to control when the cold-start splash fades
 * out. Splash stays up through connection / data-fetch / skeleton phases
 * and only dismisses once the caller signals it's ready to render.
 *
 * Idempotent: only the first true (across the whole app) actually triggers
 * the fade. Subsequent calls are no-ops.
 *
 * Examples:
 *   useHideSplashOnReady(!loading);                  // wait for data
 *   useHideSplashOnReady(true);                      // immediate (login pages)
 *   useHideSplashOnReady(state === "error");         // on terminal state
 */
export function useHideSplashOnReady(ready: boolean): void {
  useEffect(() => {
    requestHideSplash(ready);
  }, [ready]);
}
