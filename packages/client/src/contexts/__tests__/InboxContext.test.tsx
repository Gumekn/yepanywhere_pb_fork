import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InboxProvider,
  type InboxResponse,
  useInboxContext,
} from "../InboxContext";

const { mockGetInbox } = vi.hoisted(() => ({
  mockGetInbox: vi.fn<() => Promise<InboxResponse>>(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getInbox: mockGetInbox,
  },
}));

vi.mock("../../hooks/useFileActivity", () => ({
  useFileActivity: vi.fn(),
}));

function InboxConsumer() {
  const { error, loading, totalItems } = useInboxContext();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error?.message ?? ""}</span>
      <span data-testid="total">{String(totalItems)}</span>
    </div>
  );
}

describe("InboxProvider", () => {
  beforeEach(() => {
    mockGetInbox.mockReset();
    mockGetInbox.mockResolvedValue({
      needsAttention: [],
      active: [],
      recentActivity: [],
      unread8h: [],
      unread24h: [],
    });
    window.history.replaceState({}, "", "/inbox");
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
