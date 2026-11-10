import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthService } from "../../src/auth/AuthService.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";

function appWithAuth(basePath?: string) {
  const authService = {
    isEnabled: () => true,
    hasAccount: () => true,
    isLocalhostOpen: () => false,
    validateSession: async () => false,
  } as unknown as AuthService;
  const root = new Hono();
  const app = basePath ? root.basePath(basePath) : root;
  app.use("/api/*", createAuthMiddleware({ authService, basePath }));
  app.get("/api/auth/status", (c) => c.text("auth"));
  app.get("/api/public/session-shares/:token", (c) => c.text("public"));
  app.get("/api/projects", (c) => c.text("private"));
  return app;
}

describe("auth middleware path exemptions", () => {
  it.each([undefined, "/yep"])(
    "matches exemptions after the base path (%s)",
    async (basePath) => {
      const app = appWithAuth(basePath);
      const prefix = basePath ?? "";
      const get = (path: string) => app.request(`${prefix}${path}`, {}, {});

      expect((await get("/api/auth/status")).status).toBe(200);
      expect((await get("/api/public/session-shares/abc")).status).toBe(200);
      expect((await get("/api/projects")).status).toBe(401);
    },
  );

  it("does not treat a lookalike prefix as the base path", async () => {
    const app = appWithAuth("/yep");
    // `/yepx/...` never reaches the base-pathed routes at all.
    const res = await app.request(
      "/yepx/api/public/session-shares/abc",
      {},
      {},
    );
    expect(res.status).toBe(404);
  });
});
