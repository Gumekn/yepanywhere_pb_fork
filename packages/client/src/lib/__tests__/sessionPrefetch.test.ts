import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSessionDisplayView: vi.fn(),
  getSessionMetadata: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api }));

import {
  parseSessionRoute,
  resetSessionPrefetchForTests,
  startSessionPrefetch,
  takePrefetchedMetadata,
  takePrefetchedView,
} from "../sessionPrefetch";

afterEach(() => {
  resetSessionPrefetchForTests();
  vi.resetAllMocks();
});

describe("parseSessionRoute", () => {
  it("recognizes session routes under the base path", () => {
    expect(
      parseSessionRoute("/yep/projects/p1/sessions/s1", "", "/yep"),
    ).toEqual({ projectId: "p1", sessionId: "s1" });
    expect(
      parseSessionRoute("/projects/p1/sessions/s1/", "?branch=b2"),
    ).toEqual({ projectId: "p1", sessionId: "s1", branchId: "b2" });
  });

  it("ignores other routes, legacy history and malformed escapes", () => {
    expect(parseSessionRoute("/projects/p1", "")).toBeNull();
    expect(parseSessionRoute("/sessions/s1", "")).toBeNull();
    expect(parseSessionRoute("/projects/p1/sessions/s1/files", "")).toBeNull();
    expect(
      parseSessionRoute("/projects/p1/sessions/s1", "?history=legacy"),
    ).toBeNull();
    expect(parseSessionRoute("/projects/%E0%A4%A/sessions/s1", "")).toBeNull();
  });
});

describe("session prefetch", () => {
  const location = { pathname: "/yep/projects/p1/sessions/s1", search: "" };

  it("hands each prefetched read out once, to the matching view only", async () => {
    api.getSessionDisplayView.mockImplementation(
      async (
        _p: string,
        _s: string,
        options: { onResponse?: (i: unknown) => void },
      ) => {
        options.onResponse?.({ status: 200, serverTiming: "total;dur=4" });
        return { seq: 1 };
      },
    );
    api.getSessionMetadata.mockResolvedValue({ session: { id: "s1" } });
    expect(startSessionPrefetch(location, "/yep")).toBe(true);
    expect(api.getSessionDisplayView).toHaveBeenCalledWith("p1", "s1", {
      branchId: undefined,
      onResponse: expect.any(Function),
    });

    expect(takePrefetchedView("p1", "other")).toBeUndefined();
    expect(takePrefetchedView("p1", "s1", "branch")).toBeUndefined();
    await expect(takePrefetchedView("p1", "s1")).resolves.toEqual({
      snapshot: { seq: 1 },
      status: 200,
      serverTiming: "total;dur=4",
    });
    expect(takePrefetchedView("p1", "s1")).toBeUndefined();
    await expect(takePrefetchedMetadata("p1", "s1")).resolves.toEqual({
      session: { id: "s1" },
    });
    expect(takePrefetchedMetadata("p1", "s1")).toBeUndefined();
  });

  it("drops prefetches that are too old to count as fresh", () => {
    api.getSessionDisplayView.mockResolvedValue({});
    api.getSessionMetadata.mockResolvedValue({});
    let now = 1_000;
    startSessionPrefetch(location, "/yep", () => now);
    now += 10_001;
    expect(
      takePrefetchedView("p1", "s1", undefined, () => now),
    ).toBeUndefined();
    expect(
      takePrefetchedMetadata("p1", "s1", undefined, () => now),
    ).toBeUndefined();
  });

  it("does nothing off the session route and swallows unconsumed failures", async () => {
    expect(
      startSessionPrefetch({ pathname: "/yep/inbox", search: "" }, "/yep"),
    ).toBe(false);
    expect(api.getSessionDisplayView).not.toHaveBeenCalled();

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    api.getSessionDisplayView.mockRejectedValue(new Error("401"));
    api.getSessionMetadata.mockRejectedValue(new Error("401"));
    startSessionPrefetch(location, "/yep");
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
