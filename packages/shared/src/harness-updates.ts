/** CLI installations on the machine running the Yep server. */
export type HarnessId = "codex" | "pi" | "dsh";

export type HarnessUpdateBlockReason =
  | "not_installed"
  | "unsupported_install"
  | "unsupported_platform"
  | "package_manager_missing"
  | "busy";

export interface HarnessUpdateJob {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  fromVersion?: string;
  toVersion?: string;
  log: string;
  error?: string;
}

export interface HarnessUpdateInfo {
  id: HarnessId;
  displayName: string;
  path?: string;
  currentVersion?: string;
  latestVersion?: string;
  checkedAt?: string;
  updateAvailable: boolean;
  manager?: "npm" | "brew";
  canUpdate: boolean;
  blockedReason?: HarnessUpdateBlockReason;
  error?: string;
  job?: HarnessUpdateJob;
  /** DSH Web must be explicitly stopped before changing its installation. */
  webRunning?: boolean;
}
