import { useLayoutEffect } from "react";

const SAFE_AREA_MESSAGE = "yep-anywhere:mobile-shell-safe-area";
const GET_SAFE_AREA_MESSAGE = "yep-anywhere:mobile-shell-get-safe-area";

/**
 * The Android shell owns env(safe-area-inset-bottom); the cross-origin app
 * does not. Apply the forwarded inset so fixed controls clear the gesture
 * bar while page backgrounds continue behind it.
 */
export function installMobileSafeAreaInset(): () => void {
  const root = document.documentElement;

  const apply = (bottom: number) => {
    if (!Number.isFinite(bottom) || bottom < 0) return;
    root.style.setProperty("--safe-area-bottom", `${Math.round(bottom)}px`);
  };

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; bottom?: unknown } | null;
    if (!data || data.type !== SAFE_AREA_MESSAGE) return;
    if (typeof data.bottom !== "number") return;
    apply(data.bottom);
  };

  window.addEventListener("message", onMessage);
  if (window.parent !== window) {
    window.parent.postMessage({ type: GET_SAFE_AREA_MESSAGE }, "*");
  }

  return () => {
    window.removeEventListener("message", onMessage);
  };
}

/** Lock only the navigation document; nested message lists and inputs still scroll. */
export function useMobileViewport(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    root.classList.add("mobile-navigation-viewport");

    const sync = () => {
      // Ignore pinch zoom: resizing the app while magnifying would reflow content.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height ?? window.innerHeight;
      if (height <= 0) return;
      root.style.setProperty("--app-viewport-height", `${height}px`);
      root.style.setProperty(
        "--app-viewport-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
      // WebView focus reveal can scroll the outer document even with hidden
      // overflow. Reset the document only, never a nested transcript or textarea.
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };

    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync);
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync);
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      root.classList.remove("mobile-navigation-viewport");
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
    };
  }, [enabled]);
}
