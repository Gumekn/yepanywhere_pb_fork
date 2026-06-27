import { useEffect, useState } from "react";
import { useNativePushNotifications } from "../hooks/useNativePushNotifications";
import { useI18n } from "../i18n";
import { debugNativePush } from "../lib/nativePushBridge";
import type { TestNotificationUrgency } from "./PushNotificationToggle";

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
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("nativePushToggleTitle")}</strong>
          <p>{error || t("nativePushToggleUnsupported")}</p>
        </div>
      </div>
    );
  }

  if (!isServerConfigured) {
    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("nativePushToggleTitle")}</strong>
          <p className="settings-warning">
            {t("nativePushToggleServerNotConfigured")}
          </p>
          {error && <p className="settings-error">{error}</p>}
        </div>
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("nativePushToggleTitle")}</strong>
          <p className="settings-warning">{t("nativePushToggleBlocked")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("nativePushToggleTitle")}</strong>
          <p>{t("nativePushToggleDescription")}</p>
          {error && <p className="settings-error">{error}</p>}
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={isSubscribed}
            onChange={handleToggle}
            disabled={isLoading}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {isSubscribed && (
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("pushToggleTestTitle")}</strong>
            <p>{t("pushToggleTestDescription")}</p>
          </div>
          <div className="settings-item-actions">
            <select
              className="settings-select"
              value={testUrgency}
              onChange={(e) =>
                setTestUrgency(e.target.value as TestNotificationUrgency)
              }
              disabled={isLoading}
            >
              <option value="normal">{t("pushToggleUrgencyNormal")}</option>
              <option value="persistent">
                {t("pushToggleUrgencyPersistent")}
              </option>
              <option value="silent">{t("pushToggleUrgencySilent")}</option>
            </select>
            <button
              type="button"
              className="settings-button"
              onClick={() => sendTest(testUrgency)}
              disabled={isLoading}
            >
              {isLoading ? t("pushToggleSending") : t("pushToggleSendTest")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
