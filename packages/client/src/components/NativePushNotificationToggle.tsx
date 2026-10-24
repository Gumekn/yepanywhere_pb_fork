import { useEffect, useState } from "react";
import { useNativePushNotifications } from "../hooks/useNativePushNotifications";
import { useI18n } from "../i18n";
import { debugNativePush } from "../lib/nativePushBridge";
import {
  NotificationTestActions,
  SettingsItem,
  SettingsToggle,
  type TestNotificationUrgency,
} from "./ui/SettingsItem";

export function NativePushNotificationToggle() {
  const { t } = useI18n();
  const {
    isSupported,
    isServerConfigured,
    isSubscribed,
    isLoading,
    error,
    permission,
    subscribe,
    unsubscribe,
    sendTest,
  } = useNativePushNotifications();
  const [testUrgency, setTestUrgency] =
    useState<TestNotificationUrgency>("normal");

  useEffect(() => {
    debugNativePush(
      `component state supported=${isSupported ? "true" : "false"} serverConfigured=${isServerConfigured ? "true" : "false"} subscribed=${isSubscribed ? "true" : "false"} loading=${isLoading ? "true" : "false"} permission=${permission} error=${error || "null"}`,
    );
  }, [
    isSupported,
    isServerConfigured,
    isSubscribed,
    isLoading,
    permission,
    error,
  ]);

  const handleToggle = async () => {
    debugNativePush(
      `component toggle subscribed=${isSubscribed ? "true" : "false"} loading=${isLoading ? "true" : "false"}`,
    );
    if (isSubscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  if (!isSupported) {
    return (
      <SettingsItem title={t("nativePushToggleTitle")}>
        <p>{error || t("nativePushToggleUnsupported")}</p>
      </SettingsItem>
    );
  }

  if (!isServerConfigured) {
    return (
      <SettingsItem title={t("nativePushToggleTitle")}>
        <p className="settings-warning">
          {t("nativePushToggleServerNotConfigured")}
        </p>
        {error && <p className="settings-error">{error}</p>}
      </SettingsItem>
    );
  }

  if (permission === "denied") {
    return (
      <SettingsItem title={t("nativePushToggleTitle")}>
        <p className="settings-warning">{t("nativePushToggleBlocked")}</p>
      </SettingsItem>
    );
  }

  return (
    <>
      <SettingsItem
        title={t("nativePushToggleTitle")}
        action={
          <SettingsToggle
            checked={isSubscribed}
            onChange={handleToggle}
            disabled={isLoading}
          />
        }
      >
        <p>{t("nativePushToggleDescription")}</p>
        {error && <p className="settings-error">{error}</p>}
      </SettingsItem>

      {isSubscribed && (
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
      )}
    </>
  );
}
