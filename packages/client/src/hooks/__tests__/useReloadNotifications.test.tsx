import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDevStatusAvailabilityForTests,
  useReloadNotifications,
} from "../useReloadNotifications";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (data: unknown) => void>(),
  fetchJSON: vi.fn<(path: string) => Promise<unknown>>(),
}));
beforeEach(() => {
  mocks.fetchJSON.mockReset();
  mocks.fetchJSON.mockImplementation(async (path) =>
    path === "/dev/status"
      ? {
          noBackendReload: false,
          noFrontendReload: false,
          runtimeMode: "external",
        }
      : {
          activeWorkers: 0,
          queueLength: 0,
          hasActiveWork: false,
          runtimeMode: "external",
        },
  );
});
vi.mock("../../api/client", () => ({ fetchJSON: mocks.fetchJSON }));
vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    connected: true,
    on: (name: string, listener: (data: unknown) => void) => {
      mocks.listeners.set(name, listener);
      return () => mocks.listeners.delete(name);
    },
  },
}));
afterEach(() => {
  cleanup();
  mocks.listeners.clear();
  resetDevStatusAvailabilityForTests();
});

describe("dev status availability", () => {
  it("stops asking for /dev/status after the server answers 404", async () => {
    mocks.fetchJSON.mockImplementation(async (path) => {
      if (path === "/dev/status")
        throw Object.assign(new Error("Not found"), { status: 404 });
      return { activeWorkers: 0, queueLength: 0, hasActiveWork: false };
    });
    renderHook(() => useReloadNotifications());
    await waitFor(() =>
      expect(mocks.fetchJSON).toHaveBeenCalledWith("/status/workers"),
    );
    act(() => mocks.listeners.get("refresh")?.(undefined));
    act(() => mocks.listeners.get("refresh")?.(undefined));
    await waitFor(() =>
      expect(
        mocks.fetchJSON.mock.calls.filter(([p]) => p === "/status/workers"),
      ).toHaveLength(3),
    );
    expect(
      mocks.fetchJSON.mock.calls.filter(([p]) => p === "/dev/status"),
    ).toHaveLength(1);
  });
});

describe("reload runtime topology", () => {
  it("loads production runtime mode without a dev endpoint or a reconnect", async () => {
    mocks.fetchJSON.mockImplementation(async (path) => {
      if (path === "/dev/status") throw new Error("Not found");
      return {
        runtimeMode: "external",
        activeWorkers: 2,
        queueLength: 0,
        hasActiveWork: true,
      };
    });
    const { result } = renderHook(() => useReloadNotifications());
    await waitFor(() => expect(result.current.runtimeMode).toBe("external"));
    expect(result.current.unsafeToRestart).toBe(false);
    expect(result.current.unsafeToReloadRuntime).toBe(true);

    act(() =>
      mocks.listeners.get("worker-activity-changed")?.({
        type: "worker-activity-changed",
        activeWorkers: 1,
        queueLength: 0,
        hasActiveWork: true,
      }),
    );
    expect(result.current.workerActivity.activeWorkers).toBe(1);
    expect(result.current.runtimeMode).toBe("external");
    expect(result.current.unsafeToRestart).toBe(false);

    mocks.fetchJSON.mockImplementation(async (path) => {
      if (path === "/dev/status") throw new Error("Not found");
      return {
        runtimeMode: "embedded",
        activeWorkers: 1,
        queueLength: 0,
        hasActiveWork: true,
      };
    });
    act(() => mocks.listeners.get("reconnect")?.(undefined));
    await waitFor(() => expect(result.current.runtimeMode).toBe("embedded"));
    expect(result.current.unsafeToRestart).toBe(true);
  });

  it("syncs manual reload status once on mount without a request loop", async () => {
    mocks.fetchJSON.mockImplementation(async (path) =>
      path === "/dev/status"
        ? { noBackendReload: true, noFrontendReload: false, backendDirty: true }
        : { activeWorkers: 0, queueLength: 0, hasActiveWork: false },
    );
    const { result } = renderHook(() => useReloadNotifications());
    await waitFor(() =>
      expect(result.current.pendingReloads.backend).toBe(true),
    );
    expect(result.current.isManualReloadMode).toBe(true);
    expect(mocks.fetchJSON).toHaveBeenCalledTimes(2);
  });

  it("keeps the external runtime selector available after a count-only activity event", async () => {
    const { result } = renderHook(() => useReloadNotifications());
    await waitFor(() => expect(result.current.runtimeMode).toBe("external"));
    act(() =>
      mocks.listeners.get("worker-activity-changed")?.({
        type: "worker-activity-changed",
        activeWorkers: 2,
        queueLength: 0,
        hasActiveWork: true,
      }),
    );
    expect(result.current.workerActivity.activeWorkers).toBe(2);
    expect(result.current.runtimeMode).toBe("external");
    expect(result.current.unsafeToRestart).toBe(false);
    expect(result.current.unsafeToReloadRuntime).toBe(true);
  });
});
