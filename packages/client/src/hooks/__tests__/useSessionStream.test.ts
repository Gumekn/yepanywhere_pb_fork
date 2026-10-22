import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SubscriptionError,
  isNonRetryableError,
} from "../../lib/connection/types";
import { useSessionStream } from "../useSessionStream";

type Handlers = {
  onOpen?: () => void;
  onError?: (error: Error) => void;
};

const mocks = vi.hoisted(() => ({
  handlers: [] as Handlers[],
  subscribeSession: vi.fn(),
  connectionManager: {
    on: vi.fn(() => () => {}),
    markConnected: vi.fn(),
    recordEvent: vi.fn(),
    recordHeartbeat: vi.fn(),
    handleError: vi.fn(),
  },
}));

vi.mock("../../lib/connection", async () => {
  const types = await vi.importActual<
    typeof import("../../lib/connection/types")
  >("../../lib/connection/types");
  return {
    connectionManager: mocks.connectionManager,
    getWebSocketConnection: () => ({
      subscribeSession: mocks.subscribeSession,
    }),
    SubscriptionError: types.SubscriptionError,
    isNonRetryableError: types.isNonRetryableError,
  };
});

function lastHandlers(): Handlers {
  const handlers = mocks.handlers.at(-1);
  if (!handlers) throw new Error("no subscription");
  return handlers;
}

describe("useSessionStream subscription failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.handlers.length = 0;
    mocks.subscribeSession.mockImplementation(
      (_id: string, handlers: Handlers) => {
        mocks.handlers.push(handlers);
        return { close: vi.fn() };
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    mocks.subscribeSession.mockReset();
    mocks.connectionManager.handleError.mockClear();
  });

  it("retries only the failed subscription with backoff on a server error", () => {
    const { unmount } = renderHook(() =>
      useSessionStream("session", { onMessage: vi.fn() }),
    );
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(1);

    act(() => lastHandlers().onError?.(new SubscriptionError(500, "boom")));
    expect(mocks.connectionManager.handleError).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(999));
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(2);

    // Second consecutive failure doubles the delay.
    act(() => lastHandlers().onError?.(new SubscriptionError(503, "busy")));
    act(() => vi.advanceTimersByTime(1_999));
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(3);

    // A successful open resets the backoff.
    act(() => lastHandlers().onOpen?.());
    act(() => lastHandlers().onError?.(new SubscriptionError(500, "again")));
    act(() => vi.advanceTimersByTime(1_000));
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(4);

    // Unmount cancels a pending retry.
    act(() => lastHandlers().onError?.(new SubscriptionError(500, "late")));
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(4);
    expect(mocks.connectionManager.handleError).not.toHaveBeenCalled();
  });

  it("stops on a 4xx such as a missing session", () => {
    renderHook(() => useSessionStream("gone", { onMessage: vi.fn() }));
    act(() =>
      lastHandlers().onError?.(new SubscriptionError(404, "Session not found")),
    );
    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.subscribeSession).toHaveBeenCalledTimes(1);
    expect(mocks.connectionManager.handleError).not.toHaveBeenCalled();
  });

  it("hands transport errors to the connection manager", () => {
    renderHook(() => useSessionStream("session", { onMessage: vi.fn() }));
    const error = new Error("socket closed");
    expect(isNonRetryableError(error)).toBe(false);
    act(() => lastHandlers().onError?.(error));
    expect(mocks.connectionManager.handleError).toHaveBeenCalledWith(error);
  });
});
