import { useState } from "react";
import { useNotifyInApp } from "../hooks/useNotifyInApp";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useI18n } from "../i18n";
import {
  NotificationTestActions,
  SettingsItem,
  SettingsToggle,
  type TestNotificationUrgency,
} from "./ui/SettingsItem";

export type { TestNotificationUrgency };

/**
 * Toggle component for push notification settings.
 * Shows subscription status, toggle switch, and test button.
 */
export function PushNotificationToggle() {
  const { t } = useI18n();
  const {
    isSupported,
    isSubscribed,
    isLoading,
    error,
    permission,
    subscribe,
    unsubscribe,
    sendTest,
  } = usePushNotifications();
  const { notifyInApp, setNotifyInApp } = useNotifyInApp();
  const [testUrgency, setTestUrgency] =
    useState<TestNotificationUrgency>("normal");

  const handleToggle = async () => {
    if (isSubscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  // Not supported - show message with reason and help link
  if (!isSupported) {
    // Check if this is specifically the dev mode SW disabled case
    const isDevModeDisabled = error?.includes(
      "Service worker disabled in dev mode",
    );

    return (
      <SettingsItem title={t("pushToggleTitle")}>
        <p>{error || t("pushToggleUnsupported")}</p>
        {isDevModeDisabled && (
          <div className="settings-info-box" style={{ marginTop: "0.5rem" }}>
            <p>{t("pushToggleThisDeviceOnly")}</p>
            <p>{t("pushToggleDevModeHint")}</p>
          </div>
        )}
        <p style={{ marginTop: "0.5rem" }}>
          <a
            href="https://github.com/kzahel/yepanywhere/blob/main/docs/push-notifications.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("pushToggleTroubleshooting")}
          </a>
        </p>
      </SettingsItem>
    );
  }

  // Permission denied - show how to fix
  if (permission === "denied") {
    return (
      <SettingsItem title={t("pushToggleTitle")}>
        <p className="settings-warning">{t("pushToggleBlocked")}</p>
      </SettingsItem>
    );
  }

  return (
    <>
      <SettingsItem
        title={t("pushToggleTitle")}
        action={
          <SettingsToggle
            checked={isSubscribed}
            onChange={handleToggle}
            disabled={isLoading}
          />
        }
      >
        <p>{t("pushToggleDescription")}</p>
        {error && <p className="settings-error">{error}</p>}
      </SettingsItem>

      {isSubscribed && (
        <>
          <SettingsItem
            title={t("pushToggleNotifyInAppTitle")}
            action={
              <SettingsToggle checked={notifyInApp} onChange={setNotifyInApp} />
            }
          >
            <p>{t("pushToggleNotifyInAppDescription")}</p>
          </SettingsItem>
          <SettingsItem
            title={t("pushToggleTestTitle")}
            action={
              <NotificationTestActions
                urgency={testUrgency}
                onUrgencyChange={setTestUrgency}
                onSend={() => sendTest(testUrgency)}
                disabled={isLoading}
                sending={isLoading}
              />
            }
          >
            <p>{t("pushToggleTestDescription")}</p>
          </SettingsItem>
        </>
      )}
    </>
  );
}
