import { useBrowserNotifications } from "../hooks/useBrowserNotifications";
import { useI18n } from "../i18n";
import { SettingsItem } from "./ui/SettingsItem";

/**
 * Toggle component for browser notification permission.
 * Allows desktop users to enable notifications without full push subscription.
 * Returns null on mobile devices (they should use push notifications instead).
 */
export function BrowserNotificationToggle() {
  const { t } = useI18n();
  const {
    isSupported,
    isMobile,
    isEnabled,
    isDenied,
    isRequesting,
    requestPermission,
    showNotification,
  } = useBrowserNotifications();

  // Don't show on mobile - they should use push notifications
  if (isMobile) {
    return null;
  }

  // Not supported in this browser (desktop but old browser)
  if (!isSupported) {
    return (
      <SettingsItem title="Desktop Notifications">
        <p>{t("browserToggleUnsupported")}</p>
      </SettingsItem>
    );
  }

  // Permission denied - user must change in browser settings
  if (isDenied) {
    return (
      <SettingsItem title={t("browserToggleTitle")}>
        <p className="settings-warning">{t("browserToggleBlocked")}</p>
      </SettingsItem>
    );
  }

  // Permission granted
  if (isEnabled) {
    const handleTest = () => {
      showNotification(t("browserToggleTestNotification"), {
        body: t("browserToggleTestBody"),
        icon: "/icon-192.png",
      });
    };

    return (
      <>
        <SettingsItem
          title={t("browserToggleTitle")}
          action={
            <span className="settings-badge settings-badge-success">
              {t("browserToggleEnabledBadge")}
            </span>
          }
        >
          <p>{t("browserToggleEnabled")}</p>
        </SettingsItem>
        <SettingsItem
          title={t("browserToggleTestTitle")}
          action={
            <button
              type="button"
              className="settings-button"
              onClick={handleTest}
            >
              {t("pushToggleSendTest")}
            </button>
          }
        >
          <p>{t("browserToggleTestDescription")}</p>
        </SettingsItem>
      </>
    );
  }

  // Permission not yet requested (default state)
  return (
    <SettingsItem
      title={t("browserToggleTitle")}
      action={
        <button
          type="button"
          className="settings-button"
          onClick={requestPermission}
          disabled={isRequesting}
        >
          {isRequesting
            ? t("browserToggleRequesting")
            : t("browserToggleEnable")}
        </button>
      }
    >
      <p>{t("browserToggleDescription")}</p>
    </SettingsItem>
  );
}
