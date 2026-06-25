import { act, cleanup, renderHook } from "@testing-library/react";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalSessionItem,
  GlobalSessionStats,
  ProjectOption,
} from "../../api/client";
import type {
  SessionCreatedEvent,
  SessionUpdatedEvent,
} from "../useFileActivity";
import { useGlobalSessions } from "../useGlobalSessions";

const {
  mockGetGlobalSessionStats,
  mockGetGlobalSessions,
  mockUseFileActivity,
} = vi.hoisted(() => ({
  mockGetGlobalSessionStats: vi.fn(),
  mockGetGlobalSessions: vi.fn(),
  mockUseFileActivity: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getGlobalSessionStats: mockGetGlobalSessionStats,
    getGlobalSessions: mockGetGlobalSessions,
  },
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: mockUseFileActivity,
}));

const stats: GlobalSessionStats = {
  totalCount: 0,
  unreadCount: 0,
  starredCount: 0,
  archivedCount: 0,
  providerCounts: {},
  executorCounts: {},
};

const projects: ProjectOption[] = [{ id: "project-1", name: "Project 1" }];
const projectId = "project-1" as UrlProjectId;
const projectId2 = "project-2" as UrlProjectId;

const baseSession: GlobalSessionItem = {
  id: "session-1",
  title: null,
  createdAt: "2026-06-22T08:00:00.000Z",
  updatedAt: "2026-06-22T08:00:00.000Z",
  messageCount: 0,
  provider: "codex",
  projectId,
  projectName: "Project 1",
  ownership: { owner: "none" },
  isArchived: false,
  isStarred: false,
};

const baseSessionSummary = {
  ...baseSession,
  projectId,
  fullTitle: null,
};

function response(sessions: GlobalSessionItem[]) {
  return {
    sessions,
    hasMore: false,
    stats,
    projects,
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useGlobalSessions", () => {
  let activityHandlers: {
    onSessionCreated?: (event: SessionCreatedEvent) => void;
    onSessionUpdated?: (event: SessionUpdatedEvent) => void;
    onReconnect?: () => void;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetGlobalSessions.mockReset();
    mockGetGlobalSessionStats.mockReset();
    mockUseFileActivity.mockReset();
    activityHandlers = {};
    mockUseFileActivity.mockImplementation((handlers) => {
      activityHandlers = handlers;
    });
    mockGetGlobalSessions.mockResolvedValue(response([]));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refetches after an untitled session-created event so the resolved title can appear", async () => {
    const resolvedSession = {
      ...baseSession,
      title: "Resolved session title",
      messageCount: 1,
    };
    mockGetGlobalSessions
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([resolvedSession]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    act(() => {
      activityHandlers.onSessionCreated?.({
        type: "session-created",
        session: baseSessionSummary,
        timestamp: "2026-06-22T08:00:00.000Z",
      });
    });

    expect(result.current.sessions[0]?.title).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(2);
    expect(result.current.sessions[0]?.title).toBe("Resolved session title");
  });

  it("cancels pending title refetches when session-updated provides a title", async () => {
    mockGetGlobalSessions.mockResolvedValue(response([]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    act(() => {
      activityHandlers.onSessionCreated?.({
        type: "session-created",
        session: baseSessionSummary,
        timestamp: "2026-06-22T08:00:00.000Z",
      });
    });
    act(() => {
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: baseSession.id,
        projectId,
        title: "Title from event",
        messageCount: 1,
        updatedAt: "2026-06-22T08:00:01.000Z",
        timestamp: "2026-06-22T08:00:01.000Z",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(result.current.sessions[0]?.title).toBe("Title from event");
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing title when session-updated reports a transient null title", async () => {
    const resolvedSession = {
      ...baseSession,
      title: "Existing session title",
      messageCount: 3,
    };
    mockGetGlobalSessions.mockResolvedValue(response([resolvedSession]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    act(() => {
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: baseSession.id,
        projectId,
        title: null,
        messageCount: 4,
        updatedAt: "2026-06-22T08:00:01.000Z",
        timestamp: "2026-06-22T08:00:01.000Z",
      });
    });

    expect(result.current.sessions[0]?.title).toBe("Existing session title");
    expect(result.current.sessions[0]?.messageCount).toBe(4);
  });

  it("keeps an existing title when a refetch returns a transient null title", async () => {
    const resolvedSession = {
      ...baseSession,
      title: "Existing session title",
      messageCount: 3,
    };
    const transientUntitledSession = {
      ...baseSession,
      title: null,
      messageCount: 4,
      updatedAt: "2026-06-22T08:00:01.000Z",
    };
    mockGetGlobalSessions
      .mockResolvedValueOnce(response([resolvedSession]))
      .mockResolvedValueOnce(response([transientUntitledSession]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    await act(async () => {
      await activityHandlers.onReconnect?.();
    });
    await flushPromises();

    expect(result.current.sessions[0]?.title).toBe("Existing session title");
    expect(result.current.sessions[0]?.messageCount).toBe(4);
  });

  it("fetches global stats separately from the sessions list", async () => {
    const globalStats: GlobalSessionStats = {
      totalCount: 7,
      unreadCount: 2,
      starredCount: 1,
      archivedCount: 3,
      providerCounts: { codex: 5, claude: 2 },
      executorCounts: { local: 6, remote: 1 },
    };
    mockGetGlobalSessionStats.mockResolvedValue({ stats: globalStats });
    mockGetGlobalSessions.mockResolvedValue(response([]));

    const { result } = renderHook(() =>
      useGlobalSessions({ includeStats: true, limit: 50 }),
    );
    await flushPromises();

    expect(mockGetGlobalSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeStats: false }),
    );
    expect(mockGetGlobalSessionStats).toHaveBeenCalledTimes(1);
    expect(result.current.stats).toEqual(globalStats);
  });

  it("does not fetch global stats for a project-scoped list", async () => {
    const { result } = renderHook(() =>
      useGlobalSessions({ projectId, includeStats: true, limit: 50 }),
    );
    await flushPromises();

    expect(mockGetGlobalSessions).toHaveBeenCalledWith(
      expect.objectContaining({ project: projectId, includeStats: false }),
    );
    expect(mockGetGlobalSessionStats).not.toHaveBeenCalled();
    expect(result.current.stats).toEqual(stats);
  });

  it("uses the latest filters when a pending title refetch fires", async () => {
    const project2Session: GlobalSessionItem = {
      ...baseSession,
      id: "session-2",
      title: "Project 2 session",
      messageCount: 1,
      projectId: projectId2,
      projectName: "Project 2",
    };
    mockGetGlobalSessions.mockImplementation(async (params) =>
      response(params?.project === projectId2 ? [project2Session] : []),
    );

    const { result, rerender } = renderHook(
      ({ currentProjectId }) =>
        useGlobalSessions({ projectId: currentProjectId, limit: 50 }),
      { initialProps: { currentProjectId: projectId } },
    );
    await flushPromises();

    act(() => {
      activityHandlers.onSessionCreated?.({
        type: "session-created",
        session: baseSessionSummary,
        timestamp: "2026-06-22T08:00:00.000Z",
      });
    });

    rerender({ currentProjectId: projectId2 });
    await flushPromises();
    expect(result.current.sessions[0]?.id).toBe("session-2");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(mockGetGlobalSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: projectId2 }),
    );
    expect(result.current.sessions[0]?.id).toBe("session-2");
  });
});
