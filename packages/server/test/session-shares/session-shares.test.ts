import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../src/auth/AuthService.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";
import { WS_INTERNAL_AUTHENTICATED } from "../../src/middleware/internal-auth.js";
import {
  createPublicSessionShareRoutes,
  createSessionShareRoutes,
  createSessionTranscriptRoutes,
} from "../../src/routes/session-shares.js";
import { SessionShareService } from "../../src/session-shares/SessionShareService.js";
import {
  type SessionPayloadLoader,
  createInProcessSessionPayloadLoader,
} from "../../src/session-shares/session-payload-loader.js";
import { renderTranscriptMarkdown } from "../../src/session-shares/transcript-markdown.js";

const PROJECT_ID = Buffer.from("/Users/someone/work/amap").toString(
  "base64url",
);
const SESSION_ID = "session-abc";

function message(
  uuid: string,
  type: "user" | "assistant",
  content: unknown,
  timestamp = "2026-11-10T02:29:11.000Z",
) {
  return { uuid, type, message: { role: type, content }, timestamp };
}

const MESSAGES = [
  message("u1", "user", [{ type: "text", text: "Analyze the project" }]),
  message("a1", "assistant", [
    { type: "thinking", thinking: "secret reasoning" },
    {
      type: "tool_use",
      id: "call_1",
      name: "Bash",
      input: { command: "ls" },
    },
  ]),
  message("u2", "user", [
    { type: "tool_result", tool_use_id: "call_1", content: "README.md\n```" },
  ]),
  message("a2", "assistant", [{ type: "text", text: "Here is the map." }]),
];

function staticLoader(messages = MESSAGES): SessionPayloadLoader {
  return vi.fn(async (projectId: string, sessionId: string) =>
    projectId === PROJECT_ID && sessionId === SESSION_ID
      ? {
          ok: true as const,
          payload: {
            session: {
              id: SESSION_ID,
              projectId,
              title: "Capability map",
              provider: "dsh",
              createdAt: "2026-11-10T02:29:11.000Z",
              projectPath: "/Users/someone/work/amap",
            },
            messages,
            mediaOmitted: false,
            truncated: false,
            sizeBytes: JSON.stringify(messages).length,
          },
        }
      : { ok: false as const, status: 404, error: "Session not found" },
  );
}

describe("renderTranscriptMarkdown", () => {
  it("folds tool results under their call and hides thinking by default", () => {
    const markdown = renderTranscriptMarkdown(
      { title: "Capability map", provider: "dsh" },
      MESSAGES,
    );
    expect(markdown).toContain("# Capability map");
    expect(markdown).toContain("- Provider: dsh");
    expect(markdown).toContain("## User · 2026-11-10 02:29:11Z");
    expect(markdown).toContain("### Tool: Bash");
    // The result holds a triple backtick, so the fence must be longer.
    expect(markdown).toContain("````\nREADME.md\n```\n````");
    expect(markdown).toContain("Here is the map.");
    expect(markdown).not.toContain("secret reasoning");
    // Tool-result-only user turns are not printed as their own section.
    expect(markdown.match(/## User/g)).toHaveLength(1);
  });

  it("includes thinking and truncates long tool output on request", () => {
    const long = message("u2", "user", [
      { type: "tool_result", tool_use_id: "call_1", content: "x".repeat(50) },
    ]);
    const markdown = renderTranscriptMarkdown(
      {},
      [MESSAGES[0], MESSAGES[1], long],
      { includeThinking: true, toolOutputLimit: 10 },
    );
    expect(markdown).toContain("> secret reasoning");
    expect(markdown).toContain("… [40 more characters truncated]");
  });
});

describe("SessionShareService", () => {
  let dataDir: string;
  let now: number;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-shares-"));
    now = Date.parse("2026-11-10T00:00:00.000Z");
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function service(loader = staticLoader()) {
    return new SessionShareService({
      dataDir,
      loadSession: loader,
      now: () => now,
    });
  }

  it("freezes the session at creation and hides owner identifiers", async () => {
    const shares = service();
    const created = await shares.create({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      expiresIn: "1d",
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.record.expiresAt).toBe("2026-11-11T00:00:00.000Z");
    expect(created.record.title).toBe("Capability map");

    const view = await shares.getPublic(created.record.token);
    expect(view?.snapshot.messages).toHaveLength(MESSAGES.length);
    expect(view?.snapshot.session).toEqual({
      title: "Capability map",
      provider: "dsh",
      projectName: "amap",
      createdAt: "2026-11-10T02:29:11.000Z",
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain(PROJECT_ID);
    expect(serialized).not.toContain("/Users/someone");

    const stat = await fs.stat(
      path.join(dataDir, "session-shares", "snapshots"),
    );
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("stops serving a share once it expires, and prunes it", async () => {
    const shares = service();
    const created = await shares.create({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      expiresIn: "1d",
    });
    if (!created.ok) throw new Error(created.error);
    now += 24 * 60 * 60 * 1000;
    expect(await shares.getPublic(created.record.token)).toBeNull();
    expect(await shares.list()).toEqual([]);
  });

  it("keeps never-expiring shares and revokes them on demand", async () => {
    const shares = service();
    const created = await shares.create({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      expiresIn: "never",
      title: "Custom title",
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.record.expiresAt).toBeNull();
    now += 10 * 365 * 24 * 60 * 60 * 1000;
    expect(
      (await shares.getPublic(created.record.token))?.snapshot.session.title,
    ).toBe("Custom title");
    expect(
      await shares.list({ projectId: PROJECT_ID, sessionId: SESSION_ID }),
    ).toHaveLength(1);

    expect(await shares.revoke(created.record.token)).toBe(true);
    expect(await shares.getPublic(created.record.token)).toBeNull();
    expect(await shares.revoke(created.record.token)).toBe(false);
  });

  it("rejects tokens that are not share-shaped", async () => {
    expect(await service().getPublic("../../etc/passwd")).toBeNull();
  });

  it("propagates a missing session without writing anything", async () => {
    const result = await service().create({
      projectId: PROJECT_ID,
      sessionId: "missing",
      expiresIn: "7d",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    await expect(fs.readdir(dataDir)).resolves.toEqual([]);
  });
});

describe("createInProcessSessionPayloadLoader", () => {
  it("walks older pages and marks requests as internally authenticated", async () => {
    const app = new Hono().basePath("/yep");
    const seenEnv: unknown[] = [];
    app.get("/api/projects/:projectId/sessions/:sessionId", (c) => {
      seenEnv.push(
        (c.env as Record<symbol, unknown>)[WS_INTERNAL_AUTHENTICATED],
      );
      const before = c.req.query("beforeMessageId");
      if (!before) {
        return c.json({
          session: { id: SESSION_ID },
          messages: [MESSAGES[2], MESSAGES[3]],
          pagination: {
            hasOlderMessages: true,
            truncatedBeforeMessageId: "c1",
          },
        });
      }
      // Overlaps the newer page by one row, which must be de-duplicated.
      return c.json({
        session: { id: SESSION_ID },
        messages: [MESSAGES[0], MESSAGES[1], MESSAGES[2]],
        pagination: { hasOlderMessages: false },
      });
    });

    const loader = createInProcessSessionPayloadLoader({
      fetch: (request, env) => app.fetch(request, env as object),
      basePath: "/yep",
    });
    const result = await loader(PROJECT_ID, SESSION_ID);
    if (!result.ok) throw new Error(result.error);
    expect(
      result.payload.messages.map((m) => (m as { uuid: string }).uuid),
    ).toEqual(["u1", "a1", "u2", "a2"]);
    expect(result.payload.truncated).toBe(false);
    expect(seenEnv).toEqual([true, true]);
  });

  it("retries without media when the full payload is over budget", async () => {
    const app = new Hono();
    app.get("/api/projects/:projectId/sessions/:sessionId", (c) =>
      c.json({
        session: { id: SESSION_ID },
        messages:
          c.req.query("deferMedia") === "1"
            ? [MESSAGES[0]]
            : [MESSAGES[0], { blob: "x".repeat(2000) }],
      }),
    );
    const loader = createInProcessSessionPayloadLoader({
      fetch: (request, env) => app.fetch(request, env as object),
      maxBytes: 1000,
    });
    const result = await loader(PROJECT_ID, SESSION_ID);
    if (!result.ok) throw new Error(result.error);
    expect(result.payload.mediaOmitted).toBe(true);
    expect(result.payload.messages).toHaveLength(1);
  });
});

describe("session share routes behind auth", () => {
  let dataDir: string;
  let app: Hono;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-share-routes-"));
    const loader = staticLoader();
    const shareService = new SessionShareService({
      dataDir,
      loadSession: loader,
    });
    const authService = {
      isEnabled: () => true,
      hasAccount: () => true,
      isLocalhostOpen: () => false,
      validateSession: async () => false,
    } as unknown as AuthService;

    const inner = new Hono().basePath("/yep");
    app = inner as unknown as Hono;
    app.use("/api/*", createAuthMiddleware({ authService, basePath: "/yep" }));
    app.route("/api", createSessionTranscriptRoutes({ loadSession: loader }));
    app.route("/api", createSessionShareRoutes({ shareService }));
    app.route("/api/public", createPublicSessionShareRoutes({ shareService }));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  // The node server always supplies bindings; the auth middleware reads them.
  const request = (url: string, init?: RequestInit) =>
    app.request(url, init, {});

  it("requires login for owner routes but not for public share reads", async () => {
    const created = await request("/yep/api/session-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_ID, sessionId: SESSION_ID }),
    });
    expect(created.status).toBe(401);

    const transcript = await request(
      `/yep/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/transcript`,
    );
    expect(transcript.status).toBe(401);

    const missing = await request(
      "/yep/api/public/session-shares/abcdefghijklmnopqrstuvwx",
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves a created share as JSON and Markdown to anonymous readers", async () => {
    const owner = new Hono();
    const shareService = new SessionShareService({
      dataDir,
      loadSession: staticLoader(),
    });
    owner.route("/", createSessionShareRoutes({ shareService }));
    const createdRes = await owner.request("/session-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        expiresIn: "30d",
      }),
    });
    expect(createdRes.status).toBe(201);
    const { share } = (await createdRes.json()) as { share: { token: string } };

    const json = await request(`/yep/api/public/session-shares/${share.token}`);
    expect(json.status).toBe(200);
    const body = (await json.json()) as {
      snapshot: { messages: unknown[] };
    };
    expect(body.snapshot.messages).toHaveLength(MESSAGES.length);

    const markdown = await request(
      `/yep/api/public/session-shares/${share.token}/transcript.md`,
    );
    expect(markdown.headers.get("Content-Type")).toContain("text/markdown");
    expect(await markdown.text()).toContain("- Link expires:");

    const badExpiry = await owner.request("/session-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        expiresIn: "1y",
      }),
    });
    expect(badExpiry.status).toBe(400);
  });

  it("exports an owner transcript in Markdown and JSON", async () => {
    const owner = new Hono();
    owner.route(
      "/",
      createSessionTranscriptRoutes({ loadSession: staticLoader() }),
    );
    const md = await owner.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/transcript?thinking=1`,
    );
    expect(md.status).toBe(200);
    const text = await md.text();
    expect(text).toContain("- Session ID: session-abc");
    expect(text).toContain("> secret reasoning");

    const json = await owner.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/transcript?format=json`,
    );
    expect(
      ((await json.json()) as { messages: unknown[] }).messages,
    ).toHaveLength(MESSAGES.length);

    const missing = await owner.request(
      `/projects/${PROJECT_ID}/sessions/nope/transcript`,
    );
    expect(missing.status).toBe(404);
  });
});
