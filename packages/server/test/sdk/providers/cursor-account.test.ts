import { describe, expect, it, vi } from "vitest";
import {
  CursorAccountService,
  cursorSessionCookie,
  parseCursorUsage,
} from "../../../src/sdk/providers/cursor-account.js";

const token = `header.${Buffer.from(JSON.stringify({ sub: "auth0|user_TEST123" })).toString("base64url")}.signature`;
const usage = {
  membershipType: "ultra",
  billingCycleEnd: "2026-11-12T07:33:25Z",
  individualUsage: {
    plan: { totalPercentUsed: 3.18, autoPercentUsed: 3.446, apiPercentUsed: 0 },
    onDemand: { enabled: true, used: 125, limit: 1000 },
  },
};
function fixture() {
  const fetch = vi.fn(async () => new Response(JSON.stringify(usage)));
  const run = vi.fn(async () =>
    JSON.stringify({
      isAuthenticated: true,
      userInfo: {
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
      },
    }),
  );
  const deps = {
    findAgent: vi.fn(async () => "/agent"),
    run,
    readToken: vi.fn(async (): Promise<string | null> => token),
    readCachedIdentity: vi.fn(async () => ({
      authId: "auth0|user_TEST123",
      email: "test@example.com",
      displayName: "Cached User",
    })),
    fetch,
    now: () => 100000,
  };
  return { service: new CursorAccountService(deps), deps };
}

describe("Cursor account and usage", () => {
  it("keeps the matching signed-in account when CLI user-detail lookup times out", async () => {
    const { service, deps } = fixture();
    deps.run.mockRejectedValue(new Error("status timeout"));
    const validToken = `header.${Buffer.from(JSON.stringify({ sub: "auth0|user_TEST123", exp: 1000 })).toString("base64url")}.signature`;
    deps.readToken.mockResolvedValue(validToken);
    const result = await service.getAccount();
    expect(result).toMatchObject({
      authenticated: true,
      user: { email: "test@example.com", name: "Cached User" },
      plan: "ultra",
    });
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(validToken);
  });
  it.each(["mismatched", "expired", "missing"])(
    "does not borrow %s cached identity after a failed status check",
    async (kind) => {
      const { service, deps } = fixture();
      deps.run.mockRejectedValue(new Error("status timeout"));
      deps.readToken.mockResolvedValue(
        kind === "missing"
          ? null
          : `header.${Buffer.from(JSON.stringify({ sub: kind === "mismatched" ? "auth0|user_OTHER" : "auth0|user_TEST123", exp: kind === "expired" ? 50 : 1000 })).toString("base64url")}.signature`,
      );
      const result = await service.getAccount();
      expect(result).toMatchObject({
        authenticated: false,
        error: "status-unavailable",
        usage: null,
      });
      expect(result.user).toBeUndefined();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it("honors an explicit signed-out status even with cached credentials", async () => {
    const { service, deps } = fixture();
    deps.run.mockResolvedValue(JSON.stringify({ isAuthenticated: false }));
    deps.readToken.mockResolvedValue(
      `header.${Buffer.from(JSON.stringify({ sub: "auth0|user_TEST123", exp: 1000 })).toString("base64url")}.signature`,
    );
    expect(await service.getAccount()).toMatchObject({
      authenticated: false,
      error: "not-authenticated",
    });
    expect(deps.readCachedIdentity).not.toHaveBeenCalled();
  });
  it("fills missing user details from the same login's cache", async () => {
    const { service, deps } = fixture();
    deps.run.mockResolvedValue(
      JSON.stringify({
        isAuthenticated: true,
        message: "Logged in (unable to fetch user details)",
      }),
    );
    deps.readToken.mockResolvedValue(
      `header.${Buffer.from(JSON.stringify({ sub: "auth0|user_TEST123", exp: 1000 })).toString("base64url")}.signature`,
    );
    expect(await service.getAuthStatus()).toMatchObject({
      authenticated: true,
      user: { email: "test@example.com" },
    });
  });
  it("uses the JWT subject, not the numeric CLI user ID, and rejects non-JWT credentials", () => {
    expect(cursorSessionCookie(token)).toBe(
      `WorkosCursorSessionToken=user_TEST123%3A%3A${token}`,
    );
    expect(cursorSessionCookie("api-key")).toBeNull();
  });
  it("preserves reported percentages, known zero, cents, and missing data", () => {
    expect(parseCursorUsage(usage)).toMatchObject({
      plan: "ultra",
      usage: {
        totalPercentUsed: 3.18,
        cursorPercentUsed: 3.446,
        apiPercentUsed: 0,
        onDemand: { usedUsd: 1.25, limitUsd: 10 },
      },
    });
    expect(parseCursorUsage({})).toEqual({ plan: undefined, usage: null });
    expect(
      parseCursorUsage({
        individualUsage: {
          plan: { totalPercentUsed: -1, apiPercentUsed: null },
        },
      }).usage,
    ).toBeNull();
  });
  it("returns public identity and shares cached requests without exposing credentials", async () => {
    const { service, deps } = fixture();
    const [first, second] = await Promise.all([
      service.getAccount(),
      service.getAccount(),
    ]);
    expect(first).toEqual(second);
    expect(first.user).toEqual({
      email: "test@example.com",
      name: "Test User",
    });
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.fetch).toHaveBeenCalledWith(
      "https://cursor.com/api/usage-summary",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          Cookie: cursorSessionCookie(token),
        }),
      }),
    );
    expect(JSON.stringify(first)).not.toContain(token);
    await service.getAccount();
    expect(deps.fetch).toHaveBeenCalledOnce();
  });
  it("retains dated usage on refresh failure but clears it on account switch", async () => {
    const { service, deps } = fixture();
    const first = await service.getAccount();
    deps.fetch.mockResolvedValue(new Response("", { status: 429 }));
    expect(await service.getAccount({ fresh: true })).toMatchObject({
      error: "rate-limited",
      usage: first.usage,
      stale: true,
      fetchedAt: first.fetchedAt,
    });
    deps.run.mockResolvedValue(
      JSON.stringify({
        isAuthenticated: true,
        userInfo: { email: "other@example.com" },
      }),
    );
    expect(await service.getAccount({ fresh: true })).toMatchObject({
      error: "rate-limited",
      usage: null,
      user: { email: "other@example.com" },
    });
  });
  it("does not query usage when signed out and distinguishes expired dashboard auth", async () => {
    const { service, deps } = fixture();
    deps.fetch.mockResolvedValue(new Response("", { status: 401 }));
    expect(await service.getAccount()).toMatchObject({
      authenticated: true,
      error: "auth-expired",
      usage: null,
    });
    deps.run.mockResolvedValue(JSON.stringify({ isAuthenticated: false }));
    expect(await service.getAccount({ fresh: true })).toMatchObject({
      authenticated: false,
      error: "not-authenticated",
      usage: null,
    });
    expect(deps.fetch).toHaveBeenCalledOnce();
  });
});
