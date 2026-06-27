import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import {
  type NativePushPermissionState,
  debugNativePush,
  getNativePushStatus,
  getNativePushToken,
  isMobileShellDocument,
  requestNativePushPermission,
} from "../lib/nativePushBridge";
import {
  LEGACY_KEYS,
  getOrCreateBrowserProfileId,
  getServerScoped,
} from "../lib/storageKeys";

interface NativePushState {
  isSupported: boolean;
  isServerConfigured: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  permission: NativePushPermissionState;
  browserProfileId: string | null;
}

export function useNativePushNotifications() {
  const [state, setState] = useState<NativePushState>({
    isSupported: false,
    isServerConfigured: false,
    isSubscribed: false,
    isLoading: true,
    error: null,
    permission: "unsupported",
    browserProfileId: null,
  });

  const isMobileShell =
    typeof document !== "undefined" && isMobileShellDocument();

  useEffect(() => {
    const init = async () => {
      const browserProfileId = getServerScoped(
        "browserProfileId",
        LEGACY_KEYS.browserProfileId,
      );
      debugNativePush(
        `hook init start mobileShell=${isMobileShell ? "true" : "false"}`,
      );

      if (!isMobileShell) {
        debugNativePush("hook init unavailable outside mobile shell");
        setState((s) => ({
          ...s,
          isSupported: false,
          isLoading: false,
          browserProfileId,
          error: "Android native push is only available in the APK",
        }));
        return;
      }

      try {
        const [nativeStatus, serverStatus, subscriptions] = await Promise.all([
          getNativePushStatus(),
          api.getNativePushStatus(),
          api.getPushSubscriptions(),
        ]);
        debugNativePush(
          `hook init status supported=${nativeStatus.supported ? "true" : "false"} permission=${nativeStatus.permission} serverConfigured=${serverStatus.configured ? "true" : "false"} subscriptions=${subscriptions.subscriptions.length}`,
        );
        const currentProfileId = getOrCreateBrowserProfileId();
        const isSubscribed = subscriptions.subscriptions.some(
          (sub) =>
            sub.browserProfileId === currentProfileId &&
            sub.pushKind === "native",
        );

        setState({
          isSupported: nativeStatus.supported,
          isServerConfigured: serverStatus.configured,
          isSubscribed,
          isLoading: false,
          error: nativeStatus.supported
            ? null
            : "Android native push is not available in this APK build",
          permission: nativeStatus.permission,
          browserProfileId: currentProfileId,
        });
      } catch (err) {
        debugNativePush(
          `hook init failed ${err instanceof Error ? err.message : String(err)}`,
        );
        setState((s) => ({
          ...s,
          isSupported: false,
          isLoading: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to initialize Android native push",
          browserProfileId,
        }));
      }
    };

    void init();
  }, [isMobileShell]);

  const subscribe = useCallback(async () => {
    debugNativePush("subscribe start");
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      let nativeStatus = await getNativePushStatus();
      debugNativePush(
        `subscribe native status supported=${nativeStatus.supported ? "true" : "false"} permission=${nativeStatus.permission}`,
      );
      if (!nativeStatus.supported) {
        setState((s) => ({
          ...s,
          isSupported: false,
          isLoading: false,
          permission: nativeStatus.permission,
          error: "Android native push is not available in this APK build",
        }));
        return;
      }

      if (nativeStatus.permission !== "granted") {
        try {
          debugNativePush("subscribe requesting permission");
          nativeStatus = await requestNativePushPermission();
        } catch (err) {
          debugNativePush(
            `subscribe permission request failed ${err instanceof Error ? err.message : String(err)}`,
          );
          const refreshedStatus = await getNativePushStatus().catch(() => null);
          if (refreshedStatus?.permission !== "granted") {
            throw err;
          }
          nativeStatus = refreshedStatus;
        }
      }

      if (nativeStatus.permission !== "granted") {
        setState((s) => ({
          ...s,
          isLoading: false,
          permission: nativeStatus.permission,
          error: "Android notification permission denied",
        }));
        return;
      }

      const serverStatus = await api.getNativePushStatus();
      debugNativePush(
        `subscribe server status configured=${serverStatus.configured ? "true" : "false"}`,
      );
      if (!serverStatus.configured) {
        setState((s) => ({
          ...s,
          isLoading: false,
          isServerConfigured: false,
          permission: nativeStatus.permission,
          error: "Server FCM credentials are not configured",
        }));
        return;
      }

      const { token } = await getNativePushToken();
      debugNativePush(`subscribe got token length=${token.length}`);
      const browserProfileId = getOrCreateBrowserProfileId();
      await api.subscribeNativePush(browserProfileId, token, "Android APK");
      debugNativePush(`subscribe server saved profile=${browserProfileId}`);

      setState((s) => ({
        ...s,
        isSupported: true,
        isServerConfigured: true,
        isSubscribed: true,
        isLoading: false,
        error: null,
        permission: nativeStatus.permission,
        browserProfileId,
      }));
    } catch (err) {
      debugNativePush(
        `subscribe failed ${err instanceof Error ? err.message : String(err)}`,
      );
      setState((s) => ({
        ...s,
        isLoading: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to subscribe Android native push",
      }));
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    debugNativePush("unsubscribe start");
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      const browserProfileId = getOrCreateBrowserProfileId();
      await api.unsubscribeNativePush(browserProfileId);
      const nativeStatus = await getNativePushStatus().catch(() => ({
        supported: false,
        permission: "unsupported" as NativePushPermissionState,
      }));
      debugNativePush(`unsubscribe complete profile=${browserProfileId}`);

      setState((s) => ({
        ...s,
        isSubscribed: false,
        isLoading: false,
        error: null,
        permission: nativeStatus.permission,
        browserProfileId,
      }));
    } catch (err) {
      debugNativePush(
        `unsubscribe failed ${err instanceof Error ? err.message : String(err)}`,
      );
      setState((s) => ({
        ...s,
        isLoading: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to unsubscribe Android native push",
      }));
    }
  }, []);

  const sendTest = useCallback(
    async (urgency: "normal" | "persistent" | "silent" = "normal") => {
      const browserProfileId = getOrCreateBrowserProfileId();
      debugNativePush(
        `sendTest start urgency=${urgency} profile=${browserProfileId}`,
      );
      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        await api.testNativePush(browserProfileId, undefined, urgency);
        debugNativePush("sendTest complete");
        setState((s) => ({ ...s, isLoading: false }));
      } catch (err) {
        debugNativePush(
          `sendTest failed ${err instanceof Error ? err.message : String(err)}`,
        );
        setState((s) => ({
          ...s,
          isLoading: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to send Android native test push",
        }));
      }
    },
    [],
  );

  return {
    ...state,
    subscribe,
    unsubscribe,
    sendTest,
  };
}
