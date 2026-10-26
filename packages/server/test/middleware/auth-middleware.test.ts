import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";

describe("createAuthMiddleware basePath compatibility", () => {
  let authService: AuthService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-middleware-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("supersecret123");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("skips auth for /api/auth/* and /health when basePath is not set", async () => {
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware({ authService }));
    app.all("/health", (c) => c.text("ok"));
    app.all("/api/auth/login", (c) => c.text("login-ok"));
    app.all("/api/projects", (c) => c.text("projects-ok"));

    const loginRes = await app.request("/api/auth/login");
    expect(loginRes.status).toBe(200);

    const healthRes = await app.request("/health");
    expect(healthRes.status).toBe(200);

    const projectsRes = await app.request("/api/projects");
    expect(projectsRes.status).toBe(401);
  });

  it("skips auth for /yep/api/auth/* and /yep/health when basePath is /yep", async () => {
    const root = new Hono();
    const app = root.basePath("/yep");
    app.use("/api/*", createAuthMiddleware({ authService, basePath: "/yep" }));
    app.all("/health", (c) => c.text("ok"));
    app.all("/api/auth/login", (c) => c.text("login-ok"));
    app.all("/api/projects", (c) => c.text("projects-ok"));

    const loginRes = await root.request("/yep/api/auth/login");
    expect(loginRes.status).toBe(200);

    const healthRes = await root.request("/yep/health");
    expect(healthRes.status).toBe(200);

    const projectsRes = await root.request("/yep/api/projects");
    expect(projectsRes.status).toBe(401);
  });
});
