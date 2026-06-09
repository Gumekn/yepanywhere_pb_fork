import { useCallback, useEffect, useRef } from "react";
import { activityBus } from "../lib/activityBus";

interface BuildInfo {
  buildId?: string;
}

const CURRENT_BUILD_ID = __BUILD_ID__;
const BUILD_PROFILE = __BUILD_PROFILE__;
const CHECK_DEBOUNCE_MS = 2_000;
const AUTO_RELOAD_PREFIX = "yep-anywhere:auto-reloaded:";

function getBuildInfoUrl(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}build-info.json?fresh=1&t=${Date.now()}`;
}

function getAutoReloadKey(nextBuildId: string): string {
  return `${AUTO_RELOAD_PREFIX}${CURRENT_BUILD_ID}->${nextBuildId}`;
}

function shouldAutoRefreshBuild(): boolean {
  return CURRENT_BUILD_ID.length > 0 && BUILD_PROFILE !== "dev";
}

function hasAlreadyReloadedFor(nextBuildId: string): boolean {
  try {
    return sessionStorage.getItem(getAutoReloadKey(nextBuildId)) === "1";
  } catch {
    return false;
  }
}

function markReloadedFor(nextBuildId: string): void {
  try {
    sessionStorage.setItem(getAutoReloadKey(nextBuildId), "1");
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

/**
 * Reloads an already-open production tab after a server-only deploy serves a
 * different client build. New navigations already get fresh index.html; this
 * covers tabs that are still executing the old SPA bundle.
 */
export function useBuildRefresh(): void {
  const inFlightRef = useRef(false);
  const lastCheckAtRef = useRef(0);

  const checkForNewBuild = useCallback(async () => {
    if (!shouldAutoRefreshBuild()) return;

    const now = Date.now();
    if (inFlightRef.current || now - lastCheckAtRef.current < CHECK_DEBOUNCE_MS)
      return;

    inFlightRef.current = true;
    lastCheckAtRef.current = now;

    try {
      const response = await fetch(getBuildInfoUrl(), {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) return;

      const buildInfo = (await response.json()) as BuildInfo;
      const nextBuildId = buildInfo.buildId;
      if (!nextBuildId || nextBuildId === CURRENT_BUILD_ID) return;

      if (hasAlreadyReloadedFor(nextBuildId)) {
        console.warn(
          `[BuildRefresh] Server build ${nextBuildId} differs from client build ${CURRENT_BUILD_ID}, but this tab already auto-reloaded for it.`,
        );
        return;
      }

      markReloadedFor(nextBuildId);
      window.location.reload();
    } catch (err) {
      console.warn(
        "[BuildRefresh] Failed to check deployed build metadata",
        err,
      );
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!shouldAutoRefreshBuild()) return;

    void checkForNewBuild();

    const unsubscribeReconnect = activityBus.on("reconnect", () => {
      void checkForNewBuild();
    });
    const unsubscribeRefresh = activityBus.on("refresh", () => {
      void checkForNewBuild();
    });

    const onFocus = () => {
      void checkForNewBuild();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) void checkForNewBuild();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unsubscribeReconnect();
      unsubscribeRefresh();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkForNewBuild]);
}
