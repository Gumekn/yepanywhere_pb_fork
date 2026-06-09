import { useCallback, useEffect, useState } from "react";
import {
  type DeploymentActionId,
  type DeploymentJob,
  type DeploymentStatusResponse,
  api,
} from "../../api/client";
import { useSchemaValidationContext } from "../../contexts/SchemaValidationContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useSchemaValidation } from "../../hooks/useSchemaValidation";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";

const LAST_DEPLOY_JOB_KEY = "yepanywhere:lastDeployJobId";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTerminalDeployJob(job: DeploymentJob | null): boolean {
  return job?.status === "succeeded" || job?.status === "failed";
}

export function DevelopmentSettings() {
  const { t } = useI18n();
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();
  const { settings: validationSettings, setEnabled: setValidationEnabled } =
    useSchemaValidation();
  const { holdModeEnabled, setHoldModeEnabled } = useDeveloperMode();
  const { ignoredTools, clearIgnoredTools } = useSchemaValidationContext();
  const { settings: serverSettings, updateSetting: updateServerSetting } =
    useServerSettings();
  const {
    version: versionInfo,
    loading: versionLoading,
    refetchFresh: refetchVersionFresh,
  } = useVersion({ freshOnMount: true });

  const [restarting, setRestarting] = useState(false);
  const [deployStatus, setDeployStatus] =
    useState<DeploymentStatusResponse | null>(null);
  const [deployJob, setDeployJob] = useState<DeploymentJob | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [startingAction, setStartingAction] =
    useState<DeploymentActionId | null>(null);
  const [apkBuildType, setApkBuildType] = useState<"release" | "debug">(
    "release",
  );
  const [apkInstall, setApkInstall] = useState(true);
  const [apkDeviceId, setApkDeviceId] = useState("");
  const [skipChecks, setSkipChecks] = useState(false);

  const deploymentCapable =
    versionInfo?.capabilities?.includes("deployment") ?? false;
  const shouldShowDeployment = deploymentCapable || deployStatus?.available;

  useEffect(() => {
    if (restarting && connected) {
      setRestarting(false);
    }
  }, [restarting, connected]);

  const handleRestartServer = async () => {
    setRestarting(true);
    await reloadBackend();
  };

  const refreshDeployment = useCallback(async () => {
    try {
      const status = await api.getDeploymentStatus();
      setDeployStatus(status);

      const rememberedJobId =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(LAST_DEPLOY_JOB_KEY)
          : null;
      const jobId = status.currentJob?.id ?? deployJob?.id ?? rememberedJobId;
      if (jobId) {
        try {
          const { job } = await api.getDeploymentJob(jobId);
          setDeployJob(job);
          if (isTerminalDeployJob(job)) {
            localStorage.removeItem(LAST_DEPLOY_JOB_KEY);
            if (job.status === "succeeded") {
              void refetchVersionFresh();
            }
          }
        } catch {
          if (rememberedJobId === jobId) {
            localStorage.removeItem(LAST_DEPLOY_JOB_KEY);
          }
        }
      }

      setDeployError(null);
    } catch (err) {
      if (deployJob?.status !== "running") {
        setDeployError(getErrorMessage(err));
      }
    }
  }, [deployJob?.id, deployJob?.status, refetchVersionFresh]);

  useEffect(() => {
    void refreshDeployment();
  }, [refreshDeployment]);

  useEffect(() => {
    if (deployJob?.status !== "running") return;
    const interval = window.setInterval(() => {
      void refreshDeployment();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [deployJob?.status, refreshDeployment]);

  const handleStartDeployment = async (action: DeploymentActionId) => {
    setStartingAction(action);
    setDeployError(null);
    try {
      const { job } = await api.startDeployment({
        action,
        buildType: apkBuildType,
        install: apkInstall,
        deviceId: apkDeviceId || undefined,
        skipChecks,
      });
      setDeployJob(job);
      localStorage.setItem(LAST_DEPLOY_JOB_KEY, job.id);
      void refreshDeployment();
    } catch (err) {
      setDeployError(getErrorMessage(err));
    } finally {
      setStartingAction(null);
    }
  };

  const deployRunning = deployJob?.status === "running" || !!startingAction;
  const connectedAdbDevices =
    deployStatus?.adb.devices.filter((device) => device.state === "device") ??
    [];
  const runningBuildId = versionInfo?.build?.buildId?.slice(0, 12);
  const stagedBuildId = deployStatus?.stagedBuild?.buildId?.slice(0, 12);

  if (!isManualReloadMode && !shouldShowDeployment) {
    return null;
  }

  return (
    <section className="settings-section">
      <h2>{t("developmentSectionTitle")}</h2>

      {shouldShowDeployment && (
        <div className="settings-group">
          <div className="settings-item settings-item-stacked">
            <div className="settings-item-row">
              <div className="settings-item-info">
                <strong>{t("deploymentTitle")}</strong>
                <p>{t("deploymentDescription")}</p>
                <div className="deployment-version-grid">
                  <span>
                    {t("deploymentRunningVersion")}{" "}
                    {versionLoading || !versionInfo
                      ? t("loginLoading")
                      : `v${versionInfo.current}${
                          runningBuildId ? ` (${runningBuildId})` : ""
                        }`}
                  </span>
                  {deployStatus?.packageVersion && (
                    <span>
                      {t("deploymentRepoVersion")} v
                      {deployStatus.packageVersion}
                    </span>
                  )}
                  {deployStatus?.stagedBuild && (
                    <span>
                      {t("deploymentStagedVersion")} v
                      {deployStatus.stagedBuild.version}
                      {stagedBuildId ? ` (${stagedBuildId})` : ""}
                    </span>
                  )}
                </div>
                {deployStatus && !deployStatus.available && (
                  <p className="settings-warning">{deployStatus.reason}</p>
                )}
                {deployError && (
                  <p className="settings-warning">{deployError}</p>
                )}
              </div>
              <button
                type="button"
                className="settings-button settings-button-secondary"
                onClick={() => void refreshDeployment()}
              >
                {t("deploymentRefresh")}
              </button>
            </div>
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("deploymentServerTitle")}</strong>
              <p>{t("deploymentServerDescription")}</p>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={skipChecks}
                  onChange={(e) => setSkipChecks(e.target.checked)}
                />
                <span>{t("deploymentSkipChecks")}</span>
              </label>
            </div>
            <div className="settings-item-actions">
              <button
                type="button"
                className="settings-button"
                onClick={() => void handleStartDeployment("server")}
                disabled={!deployStatus?.available || deployRunning}
              >
                {startingAction === "server"
                  ? t("deploymentStarting")
                  : t("deploymentRedeployServer")}
              </button>
              <button
                type="button"
                className="settings-button settings-button-secondary"
                onClick={() => void handleStartDeployment("server-restart")}
                disabled={!deployStatus?.available || deployRunning}
              >
                {t("deploymentRestartBundle")}
              </button>
            </div>
          </div>

          <div className="settings-item settings-item-stacked">
            <div className="settings-item-row">
              <div className="settings-item-info">
                <strong>{t("deploymentApkTitle")}</strong>
                <p>{t("deploymentApkDescription")}</p>
                {deployStatus?.adb.available === false && (
                  <p className="settings-warning">
                    {t("deploymentAdbUnavailable")}
                  </p>
                )}
              </div>
            </div>
            <div className="deployment-controls">
              <label className="deployment-control">
                <span>{t("deploymentBuildType")}</span>
                <select
                  className="settings-select"
                  value={apkBuildType}
                  onChange={(e) =>
                    setApkBuildType(e.target.value as "release" | "debug")
                  }
                  disabled={deployRunning}
                >
                  <option value="release">{t("deploymentRelease")}</option>
                  <option value="debug">{t("deploymentDebug")}</option>
                </select>
              </label>
              <label className="deployment-control">
                <span>{t("deploymentDevice")}</span>
                <select
                  className="settings-select"
                  value={apkDeviceId}
                  onChange={(e) => setApkDeviceId(e.target.value)}
                  disabled={deployRunning}
                >
                  <option value="">{t("deploymentDeviceAuto")}</option>
                  {connectedAdbDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.model
                        ? `${device.id} (${device.model})`
                        : device.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={apkInstall}
                  onChange={(e) => setApkInstall(e.target.checked)}
                  disabled={deployRunning}
                />
                <span>{t("deploymentInstallAfterBuild")}</span>
              </label>
              <button
                type="button"
                className="settings-button"
                onClick={() => void handleStartDeployment("apk")}
                disabled={!deployStatus?.available || deployRunning}
              >
                {startingAction === "apk"
                  ? t("deploymentStarting")
                  : apkInstall
                    ? t("deploymentBuildInstallApk")
                    : t("deploymentBuildApk")}
              </button>
              <button
                type="button"
                className="settings-button settings-button-secondary"
                onClick={() =>
                  void handleStartDeployment("apk-install-existing")
                }
                disabled={!deployStatus?.available || deployRunning}
              >
                {t("deploymentInstallExistingApk")}
              </button>
            </div>
          </div>

          {deployJob && (
            <div className="settings-item settings-item-stacked">
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <strong>{t("deploymentLastJobTitle")}</strong>
                  <p>{deployJob.command}</p>
                  <p>
                    {t("deploymentStartedAt")}{" "}
                    {new Date(deployJob.startedAt).toLocaleString()}
                  </p>
                </div>
                <span
                  className={`settings-status-badge deployment-status-${deployJob.status}`}
                >
                  {t(`deploymentStatus${deployJob.status}` as never)}
                </span>
              </div>
              <pre className="deployment-log">
                {deployJob.log?.trim() || t("deploymentNoLog")}
              </pre>
            </div>
          )}
        </div>
      )}

      {isManualReloadMode && (
        <>
          <div className="settings-group">
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("developmentSchemaTitle")}</strong>
                <p>{t("developmentSchemaDescription")}</p>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={validationSettings.enabled}
                  onChange={(e) => setValidationEnabled(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            {ignoredTools.length > 0 && (
              <div className="settings-item">
                <div className="settings-item-info">
                  <strong>{t("developmentIgnoredToolsTitle")}</strong>
                  <p>{t("developmentIgnoredToolsDescription")}</p>
                  <div className="ignored-tools-list">
                    {ignoredTools.map((tool) => (
                      <span key={tool} className="ignored-tool-badge">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-button settings-button-secondary"
                  onClick={clearIgnoredTools}
                >
                  {t("developmentClearIgnored")}
                </button>
              </div>
            )}
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("developmentHoldModeTitle")}</strong>
                <p>{t("developmentHoldModeDescription")}</p>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={holdModeEnabled}
                  onChange={(e) => setHoldModeEnabled(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("developmentServiceWorkerTitle")}</strong>
                <p>{t("developmentServiceWorkerDescription")}</p>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={serverSettings?.serviceWorkerEnabled ?? true}
                  onChange={(e) =>
                    updateServerSetting(
                      "serviceWorkerEnabled",
                      e.target.checked,
                    )
                  }
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-group">
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("developmentRestartTitle")}</strong>
                <p>
                  {t("developmentRestartDescription")}
                  {pendingReloads.backend && (
                    <span className="settings-pending">
                      {" "}
                      {t("developmentChangesPending")}
                    </span>
                  )}
                </p>
                {unsafeToRestart && (
                  <p className="settings-warning">
                    {t("developmentInterruptedWarning", {
                      count: workerActivity.activeWorkers,
                      suffix: workerActivity.activeWorkers !== 1 ? "s " : " ",
                    })}
                  </p>
                )}
              </div>
              <button
                type="button"
                className={`settings-button ${unsafeToRestart ? "settings-button-danger" : ""}`}
                onClick={handleRestartServer}
                disabled={restarting}
              >
                {restarting
                  ? t("developmentRestarting")
                  : unsafeToRestart
                    ? t("developmentRestartAnyway")
                    : t("developmentRestart")}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
