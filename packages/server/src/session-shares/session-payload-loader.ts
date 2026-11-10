/**
 * Load a complete session through the app's own session detail route.
 *
 * The detail handler is the single place that knows how every provider's
 * history is read, merged, paginated and augmented (rendered Markdown, diff
 * highlights). Re-implementing that for exports would drift; replaying the
 * route in-process keeps a frozen share byte-for-byte what the owner sees.
 */

import { WS_INTERNAL_AUTHENTICATED } from "../middleware/internal-auth.js";

/** Default ceiling for one captured session, including inline media. */
export const DEFAULT_MAX_SESSION_PAYLOAD_BYTES = 40 * 1024 * 1024;
/** Older-page requests per capture, so a pathological cursor cannot spin. */
const MAX_OLDER_PAGES = 200;
const OLDER_PAGE_SIZE = 500;

interface PaginationLike {
  hasOlderMessages?: boolean;
  truncatedBeforeMessageId?: string;
  rolloutRevision?: string;
}

interface SessionDetailBody {
  session?: Record<string, unknown>;
  messages?: unknown[];
  pagination?: PaginationLike;
  error?: string;
}

export interface LoadedSessionPayload {
  session: Record<string, unknown>;
  messages: unknown[];
  /** Inline media was dropped because the full payload exceeded the budget. */
  mediaOmitted: boolean;
  /** Older history remained after the page budget ran out. */
  truncated: boolean;
  /** Approximate JSON size of `messages`. */
  sizeBytes: number;
}

export type SessionPayloadResult =
  | { ok: true; payload: LoadedSessionPayload }
  | { ok: false; status: number; error: string };

export type SessionPayloadLoader = (
  projectId: string,
  sessionId: string,
) => Promise<SessionPayloadResult>;

export interface InProcessSessionPayloadLoaderOptions {
  /** The Hono app's `fetch`; requests are routed in-process, not over TCP. */
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>;
  /** Reverse-proxy prefix the app's routes are mounted under (e.g. `/yep`). */
  basePath?: string;
  maxBytes?: number;
}

function messageKey(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { uuid?: unknown; id?: unknown };
  if (typeof record.uuid === "string" && record.uuid) return record.uuid;
  if (typeof record.id === "string" && record.id) return record.id;
  return null;
}

/** Prepend an older page, dropping rows the newer page already holds. */
function prependOlder(older: unknown[], newer: unknown[]): unknown[] {
  const seen = new Set<string>();
  for (const message of newer) {
    const key = messageKey(message);
    if (key) seen.add(key);
  }
  const fresh = older.filter((message) => {
    const key = messageKey(message);
    return !key || !seen.has(key);
  });
  return [...fresh, ...newer];
}

export function createInProcessSessionPayloadLoader(
  options: InProcessSessionPayloadLoaderOptions,
): SessionPayloadLoader {
  const basePath = (options.basePath ?? "").replace(/\/$/, "");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SESSION_PAYLOAD_BYTES;

  const request = async (
    projectId: string,
    sessionId: string,
    params: URLSearchParams,
  ): Promise<{ status: number; body: SessionDetailBody | null }> => {
    const url = `http://127.0.0.1${basePath}/api/projects/${encodeURIComponent(
      projectId,
    )}/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`;
    const response = await options.fetch(
      new Request(url, { headers: { "X-Yep-Anywhere": "true" } }),
      // Same trust marker the local websocket relay uses: this request never
      // left the process, so the cookie check does not apply.
      { [WS_INTERNAL_AUTHENTICATED]: true },
    );
    let body: SessionDetailBody | null = null;
    try {
      body = (await response.json()) as SessionDetailBody;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };

  const loadOnce = async (
    projectId: string,
    sessionId: string,
    deferMedia: boolean,
  ): Promise<SessionPayloadResult> => {
    const baseParams = () => {
      const params = new URLSearchParams();
      params.set("view", "canonical");
      params.set("deferMedia", deferMedia ? "1" : "0");
      params.set("deferThinking", "0");
      return params;
    };

    const first = await request(projectId, sessionId, baseParams());
    if (first.status !== 200 || !first.body?.session) {
      return {
        ok: false,
        status: first.status === 200 ? 500 : first.status,
        error: first.body?.error ?? "Failed to load session",
      };
    }

    const session = first.body.session;
    let messages = Array.isArray(first.body.messages)
      ? first.body.messages
      : [];
    let pagination = first.body.pagination;
    let sizeBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
    let pages = 0;

    while (
      pagination?.hasOlderMessages &&
      pagination.truncatedBeforeMessageId &&
      pages < MAX_OLDER_PAGES &&
      sizeBytes <= maxBytes
    ) {
      pages += 1;
      const params = baseParams();
      params.set("tailCompactions", "2");
      params.set("maxMessages", String(OLDER_PAGE_SIZE));
      params.set("beforeMessageId", pagination.truncatedBeforeMessageId);
      if (pagination.rolloutRevision) {
        params.set("rolloutRevision", pagination.rolloutRevision);
      }
      const older = await request(projectId, sessionId, params);
      if (older.status !== 200 || !Array.isArray(older.body?.messages)) break;
      const olderMessages = older.body.messages;
      if (olderMessages.length === 0) {
        pagination = undefined;
        break;
      }
      messages = prependOlder(olderMessages, messages);
      sizeBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      const next = older.body.pagination;
      // A cursor that does not move would loop until the page budget.
      if (
        next?.truncatedBeforeMessageId === pagination.truncatedBeforeMessageId
      ) {
        break;
      }
      pagination = next;
    }

    return {
      ok: true,
      payload: {
        session,
        messages,
        mediaOmitted: deferMedia,
        truncated: Boolean(pagination?.hasOlderMessages),
        sizeBytes,
      },
    };
  };

  return async (projectId, sessionId) => {
    const full = await loadOnce(projectId, sessionId, false);
    if (!full.ok || full.payload.sizeBytes <= maxBytes) return full;

    // Inline images are what usually blow the budget; text alone is rarely
    // this large, so retry once without them before giving up.
    const lean = await loadOnce(projectId, sessionId, true);
    if (!lean.ok) return lean;
    if (lean.payload.sizeBytes > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: `Session is too large to capture (${Math.round(
          lean.payload.sizeBytes / 1024 / 1024,
        )}MB, max ${Math.round(maxBytes / 1024 / 1024)}MB)`,
      };
    }
    return lean;
  };
}
