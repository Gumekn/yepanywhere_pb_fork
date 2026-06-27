import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export interface SubscribedDevice {
  browserProfileId: string;
  createdAt: string;
  updatedAt?: string;
  deviceName?: string;
  endpointDomain: string;
  platform?: "android";
  pushKind?: "web" | "native";
}

interface SubscribedDevicesState {
  devices: SubscribedDevice[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook for managing all subscribed push notification devices.
 * Allows viewing and removing devices from any client.
 */
export function useSubscribedDevices() {
  const [state, setState] = useState<SubscribedDevicesState>({
    devices: [],
    isLoading: true,
    error: null,
  });

  const fetchDevices = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      const { subscriptions } = await api.getPushSubscriptions();
      setState({
        devices: subscriptions,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      console.error("[useSubscribedDevices] Failed to fetch:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load devices",
      }));
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const removeDevice = useCallback(
    async (browserProfileId: string, pushKind: "web" | "native" = "web") => {
      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        if (pushKind === "native") {
          await api.deleteNativePushSubscription(browserProfileId);
        } else {
          await api.deletePushSubscription(browserProfileId);
        }
        // Refresh the list
        await fetchDevices();
      } catch (err) {
        console.error("[useSubscribedDevices] Failed to remove:", err);
        setState((s) => ({
          ...s,
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to remove device",
        }));
      }
    },
    [fetchDevices],
  );

  return {
    ...state,
    removeDevice,
    refetch: fetchDevices,
  };
}
