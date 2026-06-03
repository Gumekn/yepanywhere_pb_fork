/**
 * Escape-hatch UI for editing the relay endpoint of the host the APK is
 * currently trying to auto-resume against.
 *
 * Why: when the saved relay URL stops resolving (DNS change, frp node
 * moved, cpolar URL rotated), the boot path gets stuck in
 * `auto-resume → 15s timeout → modal → retry` forever and the user has
 * no way to reach Settings to fix the URL. This component lives in the
 * gates that show the auto-resume spinner, so the user can paste a new
 * endpoint without uninstalling the APK.
 *
 * Drops `host.relayUrl` (or `host.wsUrl` for direct mode) onto whatever
 * the user types, runs it through `normalizeRelayUrl` for forgiveness,
 * and then either retries auto-resume in place or kicks back to login.
 */

import { useMemo, useState } from "react";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useI18n } from "../i18n";
import { getHostById, loadSavedHosts, saveHost } from "../lib/hostStorage";
import { setStoredRelayUrl } from "../lib/relayConfig";
import { normalizeRelayUrl } from "../lib/relayUrl";

interface Props {
  /**
   * Action after a successful save. Defaults to `retry` (re-arm
   * auto-resume in place). `gotoLogin` is for cases where the caller
   * wants the user to re-enter credentials anyway.
   */
  onSaved?: "retry" | "gotoLogin";
}

export function EndpointSwitcher({ onSaved = "retry" }: Props) {
  const { t } = useI18n();
  const { currentHostId, disconnect, retryAutoResume } = useRemoteConnection();

  const currentHost = useMemo(
    () => (currentHostId ? getHostById(currentHostId) : undefined),
    [currentHostId],
  );

  const currentUrl =
    currentHost?.relayUrl ??
    currentHost?.wsUrl ??
    // No host selected yet (rare, but happens if storage was wiped).
    loadSavedHosts().hosts[0]?.relayUrl ??
    loadSavedHosts().hosts[0]?.wsUrl ??
    "";

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    let normalized: string;
    try {
      normalized = normalizeRelayUrl(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setSaving(true);
    try {
      // Patch the currently-targeted host in place if there is one;
      // otherwise patch the first saved host (best effort).
      const hosts = loadSavedHosts().hosts;
      const target = currentHost ?? hosts[0];

      if (target) {
        const updated = { ...target };
        if (updated.mode === "relay") {
          updated.relayUrl = normalized;
        } else {
          updated.wsUrl = normalized;
        }
        saveHost(updated);
      }

      // Remember it as the user's preferred relay URL so the login form
      // also pre-fills with the new value.
      setStoredRelayUrl(normalized);

      if (onSaved === "gotoLogin") {
        // Throws away any in-flight resume and routes to the login picker.
        disconnect(true);
      } else {
        retryAutoResume();
      }
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="endpoint-switcher-toggle"
        onClick={() => setOpen(true)}
        data-testid="endpoint-switcher-toggle"
      >
        {t("endpointSwitcherToggle" as never)}
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSave}
      className="endpoint-switcher"
      data-testid="endpoint-switcher"
    >
      <p className="endpoint-switcher-current">
        {t("endpointSwitcherCurrent" as never)}:{" "}
        <code>{currentUrl || "—"}</code>
      </p>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="ws://39.106.200.1:28101/ws"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={saving}
        data-testid="endpoint-switcher-input"
      />
      <p className="endpoint-switcher-hint">
        {t("endpointSwitcherHint" as never)}
      </p>
      {error && (
        <p
          className="endpoint-switcher-error"
          data-testid="endpoint-switcher-error"
        >
          {error}
        </p>
      )}
      <div className="endpoint-switcher-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setOpen(false);
            setInput("");
            setError(null);
          }}
          disabled={saving}
        >
          {t("endpointSwitcherCancel" as never)}
        </button>
        <button
          type="submit"
          className="btn-primary"
          disabled={saving || !input.trim()}
          data-testid="endpoint-switcher-save"
        >
          {saving
            ? t("endpointSwitcherSaving" as never)
            : t("endpointSwitcherSave" as never)}
        </button>
      </div>
    </form>
  );
}
