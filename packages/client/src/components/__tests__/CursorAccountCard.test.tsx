import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { CursorAccountCard } from "../CursorAccountCard";

const listeners = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: (event: string, listener: () => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  },
}));

const account = {
  installed: true,
  authenticated: true,
  user: { email: "cursor@example.com" },
  plan: "ultra",
  usage: {
    unlimited: false,
    totalPercentUsed: 3.18,
    cursorPercentUsed: 3.446,
    apiPercentUsed: 0,
    billingCycleEnd: "2026-11-12T00:00:00Z",
    onDemand: { enabled: true, usedUsd: 0, limitUsd: 1 },
  },
  fetchedAt: "2026-10-12T15:00:00Z",
};
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, "getCursorAccount").mockResolvedValue(account);
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const renderCard = (props: Parameters<typeof CursorAccountCard>[0] = {}) =>
  render(
    <StrictMode>
      <I18nProvider>
        <CursorAccountCard {...props} />
      </I18nProvider>
    </StrictMode>,
  );

function expandUsage() {
  fireEvent.click(
    screen.getByRole("button", { name: "Cursor usage & account Expand" }),
  );
}

describe("CursorAccountCard", () => {
  it("starts with an account summary and a collapsed usage section matching Codex", async () => {
    renderCard();
    await screen.findByText("cursor@example.com");
    expect(
      screen.getByRole("heading", { name: "Cursor account" }),
    ).toBeTruthy();
    expect(screen.getByText("Plan: ultra · This cycle 3.2%")).toBeTruthy();
    const toggle = screen.getByRole("button", {
      name: "Cursor usage & account Expand",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open Cursor dashboard" }),
    ).toBeNull();
    const requests = vi.mocked(api.getCursorAccount).mock.calls.length;
    expandUsage();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    fireEvent.click(
      screen.getByRole("button", { name: "Cursor usage & account Collapse" }),
    );
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(screen.getByText("cursor@example.com")).toBeTruthy();
    expect(vi.mocked(api.getCursorAccount).mock.calls.length).toBe(requests);
  });
  it("distinguishes an unavailable login check from being signed out", async () => {
    vi.mocked(api.getCursorAccount).mockResolvedValue({
      installed: true,
      authenticated: false,
      usage: null,
      error: "status-unavailable",
    });
    renderCard();
    expect(await screen.findByText("Account status unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "The Cursor login check did not finish. Your login may still be valid; refresh to try again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy login command" }),
    ).toBeNull();
  });
  it("renders real identity, separate allowance percentages, zero usage, and dashboard link", async () => {
    renderCard();
    expect(await screen.findByText("cursor@example.com")).toBeTruthy();
    expect(screen.getByText("Plan: ultra · This cycle 3.2%")).toBeTruthy();
    expandUsage();
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual([
      "3.18",
      "3.446",
      "0",
    ]);
    expect(
      screen
        .getByRole("link", { name: "Open Cursor dashboard" })
        .getAttribute("href"),
    ).toBe("https://cursor.com/dashboard?tab=usage");
  });
  it("refreshes account and runtime status without discarding the form", async () => {
    const onRefresh = vi.fn();
    renderCard({ onRefresh });
    await screen.findByText("cursor@example.com");
    expandUsage();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(api.getCursorAccount).toHaveBeenLastCalledWith({ fresh: true }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });
  it("keeps the last usage visible and labels it stale after a network failure", async () => {
    renderCard();
    await screen.findByText("cursor@example.com");
    vi.mocked(api.getCursorAccount).mockRejectedValue(new Error("offline"));
    expandUsage();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText(
        "Could not load the Cursor account and usage. Check your connection and retry.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Showing the last available usage; it may have changed.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    fireEvent.click(
      screen.getByRole("button", { name: "Cursor usage & account Collapse" }),
    );
    expect(
      screen
        .getByText("Showing the last available usage; it may have changed.")
        .closest("[hidden]"),
    ).toBeNull();
  });
  it("offers login instructions and never fabricates zero usage when signed out", async () => {
    vi.mocked(api.getCursorAccount).mockResolvedValue({
      installed: true,
      authenticated: false,
      usage: null,
      error: "not-authenticated",
    });
    renderCard({ providerInfo: { authenticated: true, user: account.user } });
    expect(
      await screen.findByText(
        "Run agent login on the server, then refresh to check your account.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("cursor@example.com")).toBeNull();
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expandUsage();
    expect(
      screen.getByRole("button", { name: "Copy login command" }),
    ).toBeTruthy();
  });
  it("explains why an old runtime cannot launch Cursor while still showing account usage", async () => {
    renderCard({ unavailableReason: "runtime-update-required" });
    await screen.findByText("cursor@example.com");
    expect(screen.getByRole("status").textContent).toContain(
      "runtime needs an update",
    );
  });
});

describe("Cursor account recovery after deployment or a network interruption", () => {
  beforeEach(() => vi.useFakeTimers());

  it("preserves the known provider identity and retries a failed initial request automatically", async () => {
    vi.mocked(api.getCursorAccount).mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      renderCard({ providerInfo: { authenticated: true, user: account.user } });
    });
    expect(screen.getByText("cursor@example.com")).toBeTruthy();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.queryByText("Account status unavailable")).toBeNull();
    expect(screen.queryByText(/This cycle/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    vi.mocked(api.getCursorAccount).mockResolvedValue(account);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(api.getCursorAccount).toHaveBeenLastCalledWith({ fresh: true });
    expect(screen.getByText("Plan: ultra · This cycle 3.2%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.each(["reconnect", "refresh", "online"])(
    "recovers on %s and cancels the pending retry without duplicate queries",
    async (event) => {
      vi.mocked(api.getCursorAccount).mockRejectedValue(
        new TypeError("offline"),
      );
      await act(async () => {
        renderCard();
      });
      const requests = vi.mocked(api.getCursorAccount).mock.calls.length;
      vi.mocked(api.getCursorAccount).mockResolvedValue(account);
      await act(async () => {
        if (event === "online") window.dispatchEvent(new Event("online"));
        else listeners.get(event)?.();
      });
      expect(screen.getByText("cursor@example.com")).toBeTruthy();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(api.getCursorAccount).toHaveBeenCalledTimes(requests + 1);
    },
  );

  it("caps automatic retries and still allows a manual retry while collapsed", async () => {
    vi.mocked(api.getCursorAccount).mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      renderCard();
    });
    const requests = vi.mocked(api.getCursorAccount).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getCursorAccount).toHaveBeenCalledTimes(requests + 3);
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);

    vi.mocked(api.getCursorAccount).mockResolvedValue(account);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.getByText("cursor@example.com")).toBeTruthy();
    expect(screen.getByText("Plan: ultra · This cycle 3.2%")).toBeTruthy();
  });

  it.each(["status-unavailable", "request-failed"] as const)(
    "bypasses the server's cached %s response when retrying",
    async (error) => {
      vi.mocked(api.getCursorAccount).mockResolvedValue({
        installed: true,
        authenticated: false,
        usage: null,
        error,
      });
      await act(async () => {
        renderCard();
      });
      vi.mocked(api.getCursorAccount).mockResolvedValue(account);
      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      expect(api.getCursorAccount).toHaveBeenLastCalledWith({ fresh: true });
      expect(screen.getByText("cursor@example.com")).toBeTruthy();
    },
  );

  it.each([401, 403, 404, 429])(
    "does not repeatedly request an HTTP %s error",
    async (status) => {
      vi.mocked(api.getCursorAccount).mockRejectedValue(
        Object.assign(new Error("API error"), { status }),
      );
      await act(async () => {
        renderCard();
      });
      const requests = vi.mocked(api.getCursorAccount).mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(api.getCursorAccount).toHaveBeenCalledTimes(requests);
    },
  );

  it("retries an HTTP 503 while the server is restarting", async () => {
    vi.mocked(api.getCursorAccount).mockRejectedValue(
      Object.assign(new Error("Unavailable"), { status: 503 }),
    );
    await act(async () => {
      renderCard();
    });
    vi.mocked(api.getCursorAccount).mockResolvedValue(account);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByText("cursor@example.com")).toBeTruthy();
  });

  it("cleans up retries and recovery listeners when the user leaves the Cursor form", async () => {
    vi.mocked(api.getCursorAccount).mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      renderCard();
    });
    const requests = vi.mocked(api.getCursorAccount).mock.calls.length;
    cleanup();
    expect(listeners.size).toBe(0);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.getCursorAccount).toHaveBeenCalledTimes(requests);
  });
});
