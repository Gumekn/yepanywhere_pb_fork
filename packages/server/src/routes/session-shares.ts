/**
 * Session transcript export and read-only share links.
 *
 * Owner routes (behind the normal API auth):
 *   GET    /api/projects/:projectId/sessions/:sessionId/transcript
 *   POST   /api/session-shares
 *   GET    /api/session-shares?projectId=&sessionId=
 *   DELETE /api/session-shares/:token
 *
 * Public routes (no login; the unguessable token is the credential, and only
 * the frozen snapshot behind it is reachable):
 *   GET /api/public/session-shares/:token
 *   GET /api/public/session-shares/:token/transcript.md
 */

import * as path from "node:path";
import {
  DEFAULT_SESSION_SHARE_EXPIRY,
  type SessionShareExpiry,
  fromUrlProjectId,
  isSessionShareExpiry,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { type Context, Hono } from "hono";
import type { SessionShareService } from "../session-shares/SessionShareService.js";
import type { SessionPayloadLoader } from "../session-shares/session-payload-loader.js";
import {
  DEFAULT_TRANSCRIPT_TOOL_OUTPUT_LIMIT,
  type TranscriptMarkdownOptions,
  renderTranscriptMarkdown,
} from "../session-shares/transcript-markdown.js";
import { isLocatableSessionId } from "../sessions/session-locator.js";

export interface SessionTranscriptRoutesDeps {
  loadSession: SessionPayloadLoader;
}

export interface SessionShareRoutesDeps {
  shareService: SessionShareService;
}

function readTranscriptOptions(c: Context): TranscriptMarkdownOptions {
  const thinking = c.req.query("thinking")?.toLowerCase();
  const limitParam = c.req.query("toolOutputLimit");
  const parsedLimit =
    limitParam !== undefined ? Number.parseInt(limitParam, 10) : Number.NaN;
  return {
    includeThinking: thinking === "1" || thinking === "true",
    toolOutputLimit:
      Number.isFinite(parsedLimit) && parsedLimit >= 0
        ? parsedLimit
        : DEFAULT_TRANSCRIPT_TOOL_OUTPUT_LIMIT,
  };
}

function markdownResponse(c: Context, markdown: string): Response {
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(markdown);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function projectBasename(projectId: string): string | undefined {
  if (!isUrlProjectId(projectId)) return undefined;
  try {
    return path.basename(fromUrlProjectId(projectId)) || undefined;
  } catch {
    return undefined;
  }
}

export function createSessionTranscriptRoutes(
  deps: SessionTranscriptRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.get(
    "/projects/:projectId/sessions/:sessionId/transcript",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      if (!isUrlProjectId(projectId) || !isLocatableSessionId(sessionId)) {
        return c.json({ error: "Invalid project or session id" }, 400);
      }
      const format = c.req.query("format") ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        return c.json({ error: "format must be markdown or json" }, 400);
      }

      const loaded = await deps.loadSession(projectId, sessionId);
      if (!loaded.ok) {
        return c.json({ error: loaded.error }, loaded.status as 404);
      }
      const { session, messages, truncated, mediaOmitted } = loaded.payload;
      const header = {
        title:
          stringField(session.customTitle) ??
          stringField(session.title) ??
          null,
        provider: stringField(session.provider),
        model: stringField(session.model),
        projectName: projectBasename(projectId),
        createdAt: stringField(session.createdAt),
        updatedAt: stringField(session.updatedAt),
      };

      if (format === "json") {
        return c.json({
          session: header,
          messages,
          ...(truncated && { truncated: true }),
          ...(mediaOmitted && { mediaOmitted: true }),
        });
      }
      return markdownResponse(
        c,
        renderTranscriptMarkdown(header, messages, {
          ...readTranscriptOptions(c),
          extraHeaderRows: [
            ["Session ID", sessionId],
            ["History", truncated ? "partial (older turns omitted)" : null],
          ],
        }),
      );
    },
  );

  return routes;
}

export function createSessionShareRoutes(deps: SessionShareRoutesDeps): Hono {
  const routes = new Hono();

  routes.post("/session-shares", async (c) => {
    let body: {
      projectId?: unknown;
      sessionId?: unknown;
      expiresIn?: unknown;
      title?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { projectId, sessionId } = body;
    if (
      typeof projectId !== "string" ||
      !isUrlProjectId(projectId) ||
      typeof sessionId !== "string" ||
      !isLocatableSessionId(sessionId)
    ) {
      return c.json({ error: "Invalid project or session id" }, 400);
    }
    let expiresIn: SessionShareExpiry = DEFAULT_SESSION_SHARE_EXPIRY;
    if (body.expiresIn !== undefined) {
      if (!isSessionShareExpiry(body.expiresIn)) {
        return c.json({ error: "expiresIn must be 1d, 7d, 30d or never" }, 400);
      }
      expiresIn = body.expiresIn;
    }

    const result = await deps.shareService.create({
      projectId,
      sessionId,
      expiresIn,
      title: typeof body.title === "string" ? body.title.slice(0, 500) : null,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 404);
    }
    return c.json({ share: result.record }, 201);
  });

  routes.get("/session-shares", async (c) => {
    const shares = await deps.shareService.list({
      projectId: c.req.query("projectId") || undefined,
      sessionId: c.req.query("sessionId") || undefined,
    });
    return c.json({ shares });
  });

  routes.delete("/session-shares/:token", async (c) => {
    const removed = await deps.shareService.revoke(c.req.param("token"));
    if (!removed) return c.json({ error: "Share not found" }, 404);
    return c.json({ ok: true });
  });

  return routes;
}

export function createPublicSessionShareRoutes(
  deps: SessionShareRoutesDeps,
): Hono {
  const routes = new Hono();

  // Revocation must take effect immediately, and a share is not something a
  // search engine should index.
  routes.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Referrer-Policy", "no-referrer");
  });

  routes.get("/session-shares/:token", async (c) => {
    const share = await deps.shareService.getPublic(c.req.param("token"));
    if (!share) return c.json({ error: "Share not found or expired" }, 404);
    return c.json(share);
  });

  routes.get("/session-shares/:token/transcript.md", async (c) => {
    const share = await deps.shareService.getPublic(c.req.param("token"));
    if (!share) return c.json({ error: "Share not found or expired" }, 404);
    const { snapshot } = share;
    return markdownResponse(
      c,
      renderTranscriptMarkdown(snapshot.session, snapshot.messages, {
        ...readTranscriptOptions(c),
        extraHeaderRows: [
          ["Snapshot taken", snapshot.capturedAt],
          ["Link expires", share.share.expiresAt ?? "never"],
          [
            "History",
            snapshot.truncated ? "partial (older turns omitted)" : null,
          ],
        ],
      }),
    );
  });

  return routes;
}
