import { useState } from "react";
import { useI18n } from "../i18n";

interface AllowedHostsManagerProps {
  /** 当前的自定义域名列表（从逗号分隔字符串解析而来） */
  customHosts: string[];
  /** 当域名列表变化时的回调 */
  onChange: (hosts: string[]) => void;
  /** 是否禁用编辑 */
  disabled?: boolean;
}

/**
 * 域名列表管理组件
 *
 * 显示内置规则 + 自定义域名列表，支持添加和删除
 */
export function AllowedHostsManager({
  customHosts,
  onChange,
  disabled = false,
}: AllowedHostsManagerProps) {
  const { t } = useI18n();
  const [newHost, setNewHost] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  // 验证域名格式（简单验证）
  const validateHostname = (hostname: string): boolean => {
    if (!hostname || hostname.trim() === "") return false;

    // 基本格式检查：允许域名、IP、通配符
    const trimmed = hostname.trim();

    // 不允许空格
    if (trimmed.includes(" ")) return false;

    // 简单的域名/IP格式检查
    const domainPattern =
      /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Pattern = /^[0-9a-fA-F:]+$/;

    return (
      domainPattern.test(trimmed) ||
      ipv4Pattern.test(trimmed) ||
      ipv6Pattern.test(trimmed)
    );
  };

  const handleAddHost = () => {
    const trimmed = newHost.trim().toLowerCase();

    if (!validateHostname(trimmed)) {
      setInputError(t("allowedHostsInvalidFormat"));
      return;
    }

    if (customHosts.includes(trimmed)) {
      setInputError(t("allowedHostsAlreadyExists"));
      return;
    }

    onChange([...customHosts, trimmed]);
    setNewHost("");
    setInputError(null);
  };

  const handleRemoveHost = (hostname: string) => {
    onChange(customHosts.filter((h) => h !== hostname));
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddHost();
    }
  };

  return (
    <div className="allowed-hosts-manager">
      {/* 内置规则说明 */}
      <div className="allowed-hosts-builtin">
        <div className="allowed-hosts-section-title">
          {t("allowedHostsBuiltinTitle")}
        </div>
        <div className="allowed-hosts-builtin-list">
          <div className="allowed-hosts-builtin-item">
            <span className="allowed-hosts-icon">✓</span>
            <span>localhost, 127.0.0.1, ::1</span>
          </div>
          <div className="allowed-hosts-builtin-item">
            <span className="allowed-hosts-icon">✓</span>
            <span>{t("allowedHostsBuiltinPrivateIps")}</span>
          </div>
          <div className="allowed-hosts-builtin-item">
            <span className="allowed-hosts-icon">✓</span>
            <span>*.ts.net (Tailscale)</span>
          </div>
        </div>
      </div>

      {/* 自定义域名列表 */}
      <div className="allowed-hosts-custom">
        <div className="allowed-hosts-section-title">
          {t("allowedHostsCustomTitle")} ({customHosts.length})
        </div>

        {customHosts.length > 0 ? (
          <div className="allowed-hosts-list">
            {customHosts.map((hostname) => (
              <div key={hostname} className="allowed-hosts-item">
                <span className="allowed-hosts-item-text">{hostname}</span>
                <button
                  type="button"
                  className="allowed-hosts-remove-btn"
                  onClick={() => handleRemoveHost(hostname)}
                  disabled={disabled}
                  aria-label={t("allowedHostsRemove", { hostname })}
                  title={t("allowedHostsRemove", { hostname })}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    role="img"
                    aria-label={t("allowedHostsRemove", { hostname })}
                  >
                    <path d="M4 4L12 12M12 4L4 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="allowed-hosts-empty">{t("allowedHostsEmpty")}</div>
        )}
      </div>

      {/* 添加新域名 */}
      <div className="allowed-hosts-add">
        <div className="allowed-hosts-add-input-wrapper">
          <input
            type="text"
            className="allowed-hosts-add-input"
            placeholder={t("allowedHostsAddPlaceholder")}
            value={newHost}
            onChange={(e) => {
              setNewHost(e.target.value);
              setInputError(null);
            }}
            onKeyPress={handleKeyPress}
            disabled={disabled}
          />
          <button
            type="button"
            className="allowed-hosts-add-btn"
            onClick={handleAddHost}
            disabled={disabled || !newHost.trim()}
          >
            {t("allowedHostsAdd")}
          </button>
        </div>
        {inputError && <div className="allowed-hosts-error">{inputError}</div>}
        <div className="allowed-hosts-hint">{t("allowedHostsAddHint")}</div>
      </div>
    </div>
  );
}
