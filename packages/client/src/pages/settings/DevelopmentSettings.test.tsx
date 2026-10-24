import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevelopmentSettings } from "./DevelopmentSettings";

const mocks = vi.hoisted(() => ({
  clearIgnoredTools: vi.fn(),
  getDeploymentJob: vi.fn(),
  getDeploymentStatus: vi.fn(),
  isMobileShellDocument: vi.fn(() => true),
  refetchVersionFresh: vi.fn(),
  reloadBackend: vi.fn(),
  setHoldModeEnabled: vi.fn(),
  setValidationEnabled: vi.fn(),
  startDeployment: vi.fn(),
  updateServerSetting: vi.fn(),
  uploadNativeLogs: vi.fn(),
  unsafeToRestart: false,
  runtimeMode: "external" as "external" | "embedded",
  version: null as { current: string; capabilities: string[] } | null,
}));

vi.mock("../../api/client", () => ({
  api: {
    getDeploymentJob: mocks.getDeploymentJob,
    getDeploymentStatus: mocks.getDeploymentStatus,
    startDeployment: mocks.startDeployment,
  },
}));
vi.mock("../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    ignoredTools: [],
    clearIgnoredTools: mocks.clearIgnoredTools,
  }),
}));
vi.mock("../../hooks/useDeveloperMode", () => ({
  useDeveloperMode: () => ({
    holdModeEnabled: false,
    setHoldModeEnabled: mocks.setHoldModeEnabled,
  }),
}));
vi.mock("../../hooks/useGlobalActiveAgents", () => ({
  useGlobalActiveAgents: () => 0,
}));
vi.mock("../../hooks/useReloadNotifications", () => ({
  useReloadNotifications: () => ({
    isManualReloadMode: false,
    pendingReloads: { backend: false },
    connected: true,
    reloadBackend: mocks.reloadBackend,
    unsafeToRestart: mocks.unsafeToRestart,
    runtimeMode: mocks.runtimeMode,
    workerActivity: {
      activeWorkers: mocks.unsafeToRestart ? 2 : 0,
      runtimeMode: mocks.runtimeMode,
    },
  }),
}));
vi.mock("../../hooks/useSchemaValidation", () => ({
  useSchemaValidation: () => ({
    settings: { enabled: false },
    setEnabled: mocks.setValidationEnabled,
  }),
}));
vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: null,
    updateSetting: mocks.updateServerSetting,
  }),
}));
vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: mocks.version,
    loading: false,
    refetchFresh: mocks.refetchVersionFresh,
  }),
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("../../lib/nativePushBridge", () => ({
  isMobileShellDocument: mocks.isMobileShellDocument,
  uploadNativeLogs: mocks.uploadNativeLogs,
}));

describe("DevelopmentSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.version = null;
    mocks.unsafeToRestart = false;
    mocks.runtimeMode = "external";
    mocks.getDeploymentStatus.mockResolvedValue({
      available: true,
      actions: [],
      adb: { available: false, devices: [] },
      apk: { latest: null, artifacts: [] },
      currentJob: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows native log upload in the APK when manual reload mode is disabled", () => {
    render(
      <MemoryRouter>
        <DevelopmentSettings />
      </MemoryRouter>,
    );

    expect(screen.getByText("developmentNativeLogsTitle")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "developmentNativeLogsUpload" }),
    ).toBeTruthy();
    expect(screen.queryByText("developmentSchemaTitle")).toBeNull();
  });

  it("restarts selected bridges onto the newly built server bundle", async () => {
    mocks.version = {
      current: "0.4.29",
      capabilities: ["deployment"],
    };
    const job = {
      id: "deploy-job-1",
      action: "server",
      args: [],
      command: "scripts/deploy.sh --server-only",
      status: "running",
      startedAt: "2026-08-04T09:00:00.000Z",
      updatedAt: "2026-08-04T09:00:00.000Z",
    };
    mocks.startDeployment.mockResolvedValue({ job });
    mocks.getDeploymentJob.mockResolvedValue({ job });

    render(
      <MemoryRouter>
        <DevelopmentSettings />
      </MemoryRouter>,
    );

    const redeployButton = screen.getByRole("button", {
      name: "deploymentRedeployServer",
    });
    await waitFor(() => {
      expect((redeployButton as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "deploymentRestartTargetCodexBridge",
      }),
    );
    fireEvent.click(redeployButton);

    await waitFor(() => {
      expect(mocks.startDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "server",
          restartTargets: {
            codexBridge: true,
            runtime: false,
          },
        }),
      );
    });
  });

  it.each(["server", "services-restart"] as const)(
    "explicitly includes runtime in %s and warns before sending",
    async (action) => {
      mocks.version = { current: "2026.9.0", capabilities: ["deployment"] };
      const job = {
        id: "runtime-job",
        action,
        args: [],
        command: "fixture",
        status: "running",
        startedAt: "2026-10-13T01:00:00Z",
        updatedAt: "2026-10-13T01:00:00Z",
      };
      mocks.startDeployment.mockResolvedValue({ job });
      mocks.getDeploymentJob.mockResolvedValue({ job });
      render(
        <MemoryRouter>
          <DevelopmentSettings />
        </MemoryRouter>,
      );
      const runtime = await screen.findByRole("checkbox", {
        name: "deploymentRestartTargetRuntime",
      });
      expect((runtime as HTMLInputElement).checked).toBe(false);
      expect(screen.queryByText("deploymentRuntimeRestartWarning")).toBeNull();
      fireEvent.click(runtime);
      expect(screen.getByRole("status").textContent).toBe(
        "deploymentRuntimeRestartWarning",
      );
      if (action === "services-restart")
        fireEvent.click(
          screen.getByRole("checkbox", {
            name: "deploymentRestartTargetServer",
          }),
        );
      const button = screen.getByRole("button", {
        name:
          action === "server"
            ? "deploymentRedeployServer"
            : "deploymentRestartSelected",
      });
      await waitFor(() =>
        expect((button as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(button);
      await waitFor(() =>
        expect(mocks.startDeployment).toHaveBeenCalledWith(
          expect.objectContaining({
            action,
            restartTargets:
              action === "server"
                ? { codexBridge: false, runtime: true }
                : { server: false, codexBridge: false, runtime: true },
          }),
        ),
      );
      expect((runtime as HTMLInputElement).disabled).toBe(true);
    },
  );

  it("hides the separate runtime target when the runtime is embedded", async () => {
    mocks.version = { current: "2026.9.0", capabilities: ["deployment"] };
    mocks.runtimeMode = "embedded";
    render(
      <MemoryRouter>
        <DevelopmentSettings />
      </MemoryRouter>,
    );
    await screen.findByRole("checkbox", {
      name: "deploymentRestartTargetServer",
    });
    expect(
      screen.queryByRole("checkbox", {
        name: "deploymentRestartTargetRuntime",
      }),
    ).toBeNull();
  });

  it("queues a dev cutover without forcing active session interruption", async () => {
    mocks.version = {
      current: "0.4.29",
      capabilities: ["deployment"],
    };
    mocks.unsafeToRestart = true;
    const job = {
      id: "deploy-job-2",
      action: "server-dev",
      args: ["--dev-server"],
      command: "scripts/deploy.sh --dev-server",
      status: "running",
      startedAt: "2026-08-04T09:00:00.000Z",
      updatedAt: "2026-08-04T09:00:00.000Z",
    };
    mocks.startDeployment.mockResolvedValue({ job });
    mocks.getDeploymentJob.mockResolvedValue({ job });

    render(
      <MemoryRouter>
        <DevelopmentSettings />
      </MemoryRouter>,
    );

    const button = screen.getByRole("button", {
      name: "deploymentStartDevServer",
    });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.startDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "server-dev",
          allowSessionInterrupt: undefined,
        }),
      );
    });
  });
});
