import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InboxItem,
  InboxProvider,
  type InboxResponse,
  useInboxContext,
} from "../InboxContext";

const { mockGetInbox, mockUseFileActivity } = vi.hoisted(() => ({
  mockGetInbox: vi.fn<() => Promise<InboxResponse>>(),
  mockUseFileActivity: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getInbox: mockGetInbox,
  },
}));

vi.mock("../../hooks/useFileActivity", () => ({
  useFileActivity: mockUseFileActivity,
}));

function InboxConsumer() {
  const { error, loading, totalBadgeCount, totalItems } = useInboxContext();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error?.message ?? ""}</span>
      <span data-testid="total">{String(totalItems)}</span>
      <span data-testid="badge">{String(totalBadgeCount)}</span>
    </div>
  );
}

function InboxTitleConsumer() {
  const { unread24h } = useInboxContext();
  return <span data-testid="title">{unread24h[0]?.sessionTitle ?? ""}</span>;
}

function emptyInbox(overrides: Partial<InboxResponse> = {}): InboxResponse {
  const response = {
    badgeCount: 0,
    badgeSessionIds: [],
    needsAttention: [],
    active: [],
    recentActivity: [],
    unread8h: [],
    unread24h: [],
    ...overrides,
  };

  return {
    ...response,
    badgeCount: response.badgeCount ?? 0,
    badgeSessionIds: response.badgeSessionIds ?? [],
    needsAttention: response.needsAttention ?? [],
    active: response.active ?? [],
    recentActivity: response.recentActivity ?? [],
    unread8h: response.unread8h ?? [],
    unread24h: response.unread24h ?? [],
  };
}

const inboxItem: InboxItem = {
  sessionId: "session-1",
  projectId: "project-1",
  projectName: "Project 1",
  sessionTitle: "Existing session title",
  updatedAt: "2026-06-22T08:00:00.000Z",
  hasUnread: true,
};

describe("InboxProvider", () => {
  let activityHandlers: {
    onSessionStatusChange?: (event: unknown) => void;
  };

  beforeEach(() => {
    mockGetInbox.mockReset();
    mockUseFileActivity.mockReset();
    activityHandlers = {};
    mockUseFileActivity.mockImplementation((handlers) => {
      activityHandlers = handlers;
    });
    mockGetInbox.mockResolvedValue(emptyInbox());
    window.history.replaceState({}, "", "/inbox");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("fetches on mount when enabled", async () => {
    render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await waitFor(() => {
      expect(mockGetInbox).toHaveBeenCalledTimes(1);
    });
  });

  it("does not fetch on the login page", async () => {
    window.history.replaceState({}, "", "/login");

    render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockGetInbox).not.toHaveBeenCalled();
  });

  it("uses server-provided badgeCount instead of deriving from unread tiers", async () => {
    mockGetInbox.mockResolvedValue(
      emptyInbox({
        badgeCount: 1,
        unread24h: [inboxItem, { ...inboxItem, sessionId: "session-2" }],
      }),
    );

    render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("badge").textContent).toBe("1");
    });
  });

  it("keeps an existing inbox title when a refetch returns Untitled", async () => {
    mockGetInbox
      .mockResolvedValueOnce(emptyInbox({ unread24h: [inboxItem] }))
      .mockResolvedValueOnce(
        emptyInbox({
          unread24h: [{ ...inboxItem, sessionTitle: "Untitled" }],
        }),
      );

    render(
      <InboxProvider>
        <InboxTitleConsumer />
      </InboxProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe(
        "Existing session title",
      );
    });

    vi.useFakeTimers();
    act(() => {
      activityHandlers.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "session-1",
        projectId: "project-1",
        ownership: { owner: "none" },
        timestamp: "2026-06-22T08:00:01.000Z",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });

    expect(mockGetInbox).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("title").textContent).toBe(
      "Existing session title",
    );
  });
});
