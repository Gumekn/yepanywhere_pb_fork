import type { DeviceInfo } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  EMULATOR_FPS_OPTIONS,
  EMULATOR_WIDTH_OPTIONS,
  type EmulatorQuality,
  getQualityLabel,
  useEmulatorSettings,
} from "../../hooks/useEmulatorSettings";
import { useEmulators } from "../../hooks/useEmulators";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  BridgeRuntimePrompt,
  StreamView,
  deviceLabel,
  hasAction,
} from "../EmulatorPage";

const QUALITY_OPTIONS: EmulatorQuality[] = ["high", "medium", "low"];

/**
 * Settings section for the device bridge.
 * Shows discovered devices, stream settings, and ChromeOS host aliases.
 */
export function EmulatorSettings() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDeviceId = searchParams.get("deviceId");
  const shouldAutoConnect = searchParams.has("auto");
  const {
    maxFps,
    setMaxFps,
    maxWidth,
    setMaxWidth,
    quality,
    setQuality,
    adaptiveFps,
    setAdaptiveFps,
  } = useEmulatorSettings();
  const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
    updateSetting,
  } = useServerSettings();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetch: refetchVersion,
  } = useVersion();
  const [hostInput, setHostInput] = useState("");
  const [chromeOsHostError, setChromeOsHostError] = useState<string | null>(
    null,
  );
  const [activeDevice, setActiveDevice] = useState<DeviceInfo | null>(null);

  const chromeOsHosts = settings?.chromeOsHosts ?? [];
  const capabilities = versionInfo?.capabilities ?? [];
  const deviceBridgeEnabled = settings?.deviceBridgeEnabled ?? false;
  const deviceBridgeState = versionInfo?.deviceBridgeState;
  const bridgeRuntimeMode =
    deviceBridgeEnabled && deviceBridgeState === "update-available"
      ? "update"
      : deviceBridgeEnabled &&
          (deviceBridgeState === "downloadable" ||
            (capabilities.includes("deviceBridge-download") &&
              !capabilities.includes("deviceBridge")))
        ? "download"
        : null;
  const bridgeReady =
    deviceBridgeEnabled &&
    !bridgeRuntimeMode &&
    (deviceBridgeState === "available" ||
      capabilities.includes("deviceBridge"));
  const canLoadDevices =
    !!versionInfo && !versionLoading && !settingsLoading && bridgeReady;
  const { emulators, loading, error, startEmulator, stopEmulator, refresh } =
    useEmulators({ enabled: canLoadDevices });

  const addHost = async () => {
    const value = hostInput.trim();
    if (!value) {
      setChromeOsHostError(t("emulatorHostAliasRequired"));
      return;
    }
    if (/\s/.test(value)) {
      setChromeOsHostError(t("emulatorHostAliasNoSpaces"));
      return;
    }

    const deduped = Array.from(new Set([...chromeOsHosts, value]));
    try {
      await updateSetting("chromeOsHosts", deduped);
      setHostInput("");
      setChromeOsHostError(null);
      await refresh();
    } catch (err) {
      setChromeOsHostError(
        err instanceof Error ? err.message : t("emulatorHostAliasSaveFailed"),
      );
    }
  };

  const removeHost = async (host: string) => {
    const next = chromeOsHosts.filter(
      (item) => item.toLowerCase() !== host.toLowerCase(),
    );
    try {
      await updateSetting("chromeOsHosts", next);
      setChromeOsHostError(null);
      await refresh();
    } catch (err) {
      setChromeOsHostError(
        err instanceof Error ? err.message : t("emulatorHostAliasRemoveFailed"),
      );
    }
  };

  useEffect(() => {
    if (activeDevice || loading || !canLoadDevices) return;

    const requestedDevice = requestedDeviceId
      ? emulators.find((device) => device.id === requestedDeviceId)
      : null;
    const autoDevice = shouldAutoConnect
      ? emulators.find((device) => hasAction(device, "stream"))
      : null;
    const nextDevice = requestedDevice ?? autoDevice;

    if (nextDevice && hasAction(nextDevice, "stream")) {
      setActiveDevice(nextDevice);
    }
  }, [
    activeDevice,
    canLoadDevices,
    emulators,
    loading,
    requestedDeviceId,
    shouldAutoConnect,
  ]);

  const handleConnect = (device: DeviceInfo) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("deviceId", device.id);
    nextParams.delete("auto");
    setSearchParams(nextParams, { replace: true });
    setActiveDevice(device);
  };

  const handleBackFromStream = () => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("deviceId");
    nextParams.delete("auto");
    setSearchParams(nextParams, { replace: true });
    setActiveDevice(null);
  };

  if (activeDevice) {
    return <StreamView device={activeDevice} onBack={handleBackFromStream} />;
  }

  return (
    <section className="settings-section">
      <h2>{t("emulatorSectionTitle")}</h2>
      <p className="settings-description">{t("emulatorSectionDescription")}</p>

      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("emulatorEnableTitle")}</strong>
            <p>{t("emulatorEnableDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={deviceBridgeEnabled}
              onChange={(e) => {
                void updateSetting("deviceBridgeEnabled", e.target.checked);
              }}
              disabled={settingsLoading}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {!deviceBridgeEnabled ? null : (
        <>
          <div className="settings-group">
            <h3>{t("emulatorStreamQualityTitle")}</h3>
            <p className="settings-description">
              {t("emulatorStreamQualityDescription")}
            </p>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("emulatorFrameRateTitle")}</strong>
                <p>{t("emulatorFrameRateDescription")}</p>
              </div>
              <div className="font-size-selector">
                {EMULATOR_FPS_OPTIONS.map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    className={`font-size-option ${maxFps === fps ? "active" : ""}`}
                    onClick={() => setMaxFps(fps)}
                  >
                    {fps} fps
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("emulatorResolutionTitle")}</strong>
                <p>{t("emulatorResolutionDescription")}</p>
              </div>
              <div className="font-size-selector">
                {EMULATOR_WIDTH_OPTIONS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`font-size-option ${maxWidth === w ? "active" : ""}`}
                    onClick={() => setMaxWidth(w)}
                  >
                    {w}p
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("emulatorQualityTitle")}</strong>
                <p>{t("emulatorQualityDescription")}</p>
              </div>
              <div className="font-size-selector">
                {QUALITY_OPTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={`font-size-option ${quality === q ? "active" : ""}`}
                    onClick={() => setQuality(q)}
                  >
                    {getQualityLabel(q)}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("emulatorAdaptiveFpsTitle")}</strong>
                <p>{t("emulatorAdaptiveFpsDescription")}</p>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={adaptiveFps}
                  onChange={(e) => setAdaptiveFps(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-group">
            <h3>{t("emulatorChromeOsHostsTitle")}</h3>
            <p className="settings-description">
              {t("emulatorChromeOsHostsDescription")}
              <code> chromeroot</code>
              {t("emulatorChromeOsHostsDescriptionSuffix")}
            </p>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("emulatorAddHostAliasTitle")}</strong>
                <p>{t("emulatorAddHostAliasDescription")}</p>
              </div>
              <form
                className="settings-item-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addHost();
                }}
              >
                <input
                  type="text"
                  name="chromeosHost"
                  placeholder={t("emulatorHostAliasPlaceholder")}
                  className="settings-select"
                  autoComplete="off"
                  value={hostInput}
                  onChange={(event) => setHostInput(event.target.value)}
                />
                <button
                  type="submit"
                  className="settings-button"
                  disabled={settingsLoading}
                >
                  {t("projectsAddConfirm")}
                </button>
              </form>
            </div>

            {chromeOsHostError && (
              <p className="settings-error">{chromeOsHostError}</p>
            )}
            {settingsError && <p className="settings-error">{settingsError}</p>}

            {chromeOsHosts.length === 0 ? (
              <p className="settings-muted">{t("emulatorNoChromeOsHosts")}</p>
            ) : (
              chromeOsHosts.map((host) => (
                <div key={host} className="settings-item">
                  <div className="settings-item-info">
                    <span className="settings-item-label">{host}</span>
                    <span className="settings-item-description">
                      Device ID: chromeos:{host}
                    </span>
                  </div>
                  <div className="settings-item-action">
                    <button
                      type="button"
                      className="settings-button"
                      onClick={() => {
                        void removeHost(host);
                      }}
                      disabled={settingsLoading}
                    >
                      {t("emulatorRemove")}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="settings-group">
            <h3>{t("emulatorDiscoveredDevicesTitle")}</h3>

            {versionLoading && (
              <p className="settings-muted">{t("emulatorLoadingBridge")}</p>
            )}
            {!versionLoading && versionError && (
              <p className="settings-error">
                {t("emulatorLoadBridgeStatusFailed")} {versionError.message}
              </p>
            )}
            {!versionLoading &&
            !versionError &&
            deviceBridgeState === "unavailable" ? (
              <p className="settings-error">{t("emulatorBridgeUnavailable")}</p>
            ) : !versionLoading && !versionError && bridgeRuntimeMode ? (
              <BridgeRuntimePrompt
                mode={bridgeRuntimeMode}
                installedVersion={versionInfo?.deviceBridgeVersion}
                latestVersion={versionInfo?.latestDeviceBridgeVersion}
                onDownloaded={refetchVersion}
              />
            ) : null}

            {canLoadDevices && loading && (
              <p className="settings-muted">{t("projectsLoading")}</p>
            )}
            {canLoadDevices && error && (
              <p className="settings-error">{error}</p>
            )}

            {canLoadDevices && !loading && emulators.length === 0 && (
              <p className="settings-muted">{t("emulatorNoDevicesFound")}</p>
            )}

            {canLoadDevices &&
              emulators.map((device) => (
                <div key={device.id} className="settings-item">
                  <div className="settings-item-info">
                    <span className="settings-item-label">
                      {deviceLabel(device)}
                    </span>
                    <span className="settings-item-description">
                      {device.type} - {device.id} - {device.state}
                    </span>
                  </div>
                  <div className="settings-item-actions">
                    {hasAction(device, "stream") && (
                      <button
                        type="button"
                        className="settings-button"
                        onClick={() => handleConnect(device)}
                      >
                        {t("emulatorConnect")}
                      </button>
                    )}
                    {hasAction(device, "stop") ? (
                      <button
                        type="button"
                        className="settings-button"
                        onClick={() => stopEmulator(device.id)}
                      >
                        {t("emulatorStop")}
                      </button>
                    ) : hasAction(device, "start") ? (
                      <button
                        type="button"
                        className="settings-button"
                        onClick={() => startEmulator(device.id)}
                      >
                        {t("emulatorStart")}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
