import { useCallback, useEffect, useMemo, useState } from "react";

export type MobileShellChannel = "tcp" | "http";

const CHANNEL_STATUS_MESSAGE = "yep-anywhere:mobile-shell-channel";
const GET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-get-channel";
const SET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-set-channel";

function isMobileShellDocument(): boolean {
  return document.documentElement.dataset.mobileShell === "true";
}

function isMobileShellChannel(value: unknown): value is MobileShellChannel {
  return value === "tcp" || value === "http";
}

function currentAppPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function useMobileShellChannel() {
  const isMobileShell = useMemo(isMobileShellDocument, []);
  const [channel, setChannelState] = useState<MobileShellChannel>("tcp");

  useEffect(() => {
    if (!isMobileShell || window.parent === window) return;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; channel?: unknown } | null;
      if (!data || data.type !== CHANNEL_STATUS_MESSAGE) return;
      if (isMobileShellChannel(data.channel)) {
        setChannelState(data.channel);
      }
    };

    window.addEventListener("message", handleMessage);
    window.parent.postMessage({ type: GET_CHANNEL_MESSAGE }, "*");

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [isMobileShell]);

  const setChannel = useCallback(
    (nextChannel: MobileShellChannel) => {
      setChannelState(nextChannel);
      if (!isMobileShell || window.parent === window) return;
      window.parent.postMessage(
        {
          type: SET_CHANNEL_MESSAGE,
          channel: nextChannel,
          path: currentAppPath(),
        },
        "*",
      );
    },
    [isMobileShell],
  );

  return { isMobileShell, channel, setChannel };
}
