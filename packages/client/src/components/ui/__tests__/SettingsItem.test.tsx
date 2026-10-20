import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { UI_KEYS } from "../../../lib/storageKeys";
import { BrowserNotificationToggle } from "../../BrowserNotificationToggle";
import { NativePushNotificationToggle } from "../../NativePushNotificationToggle";
import { PushNotificationToggle } from "../../PushNotificationToggle";
import {
  NotificationTestActions,
  SettingsItem,
  SettingsToggle,
} from "../SettingsItem";

const hooks = vi.hoisted(() => ({
  browser: {
    isSupported: true,
    isMobile: false,
    isEnabled: true,
    isDenied: false,
    isRequesting: false,
    requestPermission: vi.fn(),
    showNotification: vi.fn(),
  },
  push: {
    isSupported: true,
    isSubscribed: true,
    isLoading: false,
    error: null as string | null,
    permission: "granted" as NotificationPermission,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sendTest: vi.fn(),
  },
  notifyInApp: true,
  native: {
    isSupported: true,
    isServerConfigured: true,
    isSubscribed: true,
    isLoading: false,
    error: null as string | null,
    permission: "granted" as NotificationPermission,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sendTest: vi.fn(),
  },
}));

vi.mock("../../../hooks/useBrowserNotifications", () => ({
  useBrowserNotifications: () => hooks.browser,
}));

vi.mock("../../../hooks/usePushNotifications", () => ({
  usePushNotifications: () => hooks.push,
}));

vi.mock("../../../hooks/useNotifyInApp", () => ({
  useNotifyInApp: () => ({
    notifyInApp: hooks.notifyInApp,
    setNotifyInApp: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useNativePushNotifications", () => ({
  useNativePushNotifications: () => hooks.native,
}));

function renderWithI18n(node: ReactNode) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

describe("SettingsItem", () => {
  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    hooks.browser.isMobile = false;
    hooks.browser.isEnabled = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the shared settings row, toggle, and test actions", () => {
    const onChange = vi.fn();
    const onSend = vi.fn();

    function Harness() {
      const [checked, setChecked] = useState(false);
      const [urgency, setUrgency] = useState<
        "normal" | "persistent" | "silent"
      >("normal");
      return (
        <>
          <SettingsItem
            title="Push"
            action={
              <SettingsToggle
                checked={checked}
                onChange={(next) => {
                  setChecked(next);
                  onChange(next);
                }}
              />
            }
          >
            <p>Deliver alerts</p>
          </SettingsItem>
          <SettingsItem
            title="Test"
            action={
              <NotificationTestActions
                urgency={urgency}
                onUrgencyChange={setUrgency}
                onSend={onSend}
              />
            }
          >
            <p>Send a sample</p>
          </SettingsItem>
        </>
      );
    }

    renderWithI18n(<Harness />);

    expect(
      screen.getByText("Push").closest(".settings-item")?.textContent,
    ).toContain("Deliver alerts");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "silent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Test" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps enabled browser notifications on two settings rows", () => {
    renderWithI18n(<BrowserNotificationToggle />);
    expect(document.querySelectorAll(".settings-item")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Send Test" })).toBeTruthy();
  });

  it("hides browser notifications on mobile", () => {
    hooks.browser.isMobile = true;
    renderWithI18n(<BrowserNotificationToggle />);
    expect(document.querySelector(".settings-item")).toBeNull();
  });

  it("keeps subscribed web push on the shared toggle and test row", () => {
    renderWithI18n(<PushNotificationToggle />);
    expect(document.querySelectorAll(".settings-item")).toHaveLength(3);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("keeps subscribed native push on the shared toggle and test row", () => {
    renderWithI18n(<NativePushNotificationToggle />);
    expect(document.querySelectorAll(".settings-item")).toHaveLength(2);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
  });
});
