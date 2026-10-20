import type { ReactNode } from "react";
import { useI18n } from "../../i18n";

export function SettingsItem({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="settings-item">
      <div className="settings-item-info">
        <strong>{title}</strong>
        {children}
      </div>
      {action}
    </div>
  );
}

export function SettingsToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-switch">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span className="toggle-slider" />
    </label>
  );
}

export type TestNotificationUrgency = "normal" | "persistent" | "silent";

export function NotificationTestActions({
  urgency,
  onUrgencyChange,
  onSend,
  disabled,
  sending,
}: {
  urgency: TestNotificationUrgency;
  onUrgencyChange: (urgency: TestNotificationUrgency) => void;
  onSend: () => void;
  disabled?: boolean;
  sending?: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="settings-item-actions">
      <select
        className="settings-select"
        value={urgency}
        onChange={(event) =>
          onUrgencyChange(event.target.value as TestNotificationUrgency)
        }
        disabled={disabled}
      >
        <option value="normal">{t("pushToggleUrgencyNormal")}</option>
        <option value="persistent">{t("pushToggleUrgencyPersistent")}</option>
        <option value="silent">{t("pushToggleUrgencySilent")}</option>
      </select>
      <button
        type="button"
        className="settings-button"
        onClick={onSend}
        disabled={disabled}
      >
        {sending ? t("pushToggleSending") : t("pushToggleSendTest")}
      </button>
    </div>
  );
}
