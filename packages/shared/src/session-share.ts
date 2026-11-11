/**
 * Read-only session share links.
 *
 * A share is a frozen snapshot of one session, taken when the link is
 * created, and addressed by an unguessable token. Viewing a share needs no
 * login and exposes nothing beyond that one snapshot — no project path, no
 * session id, no live updates.
 */

/** Lifetime choices offered when a share link is created. */
export const SESSION_SHARE_EXPIRY_OPTIONS = [
  "1d",
  "7d",
  "30d",
  "never",
] as const;

export type SessionShareExpiry = (typeof SESSION_SHARE_EXPIRY_OPTIONS)[number];

export const DEFAULT_SESSION_SHARE_EXPIRY: SessionShareExpiry = "7d";

const EXPIRY_MS: Record<Exclude<SessionShareExpiry, "never">, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function isSessionShareExpiry(
  value: unknown,
): value is SessionShareExpiry {
  return (
    typeof value === "string" &&
    (SESSION_SHARE_EXPIRY_OPTIONS as readonly string[]).includes(value)
  );
}

/** Absolute expiry for a share created at `createdAtMs`, or null for never. */
export function resolveSessionShareExpiresAt(
  expiry: SessionShareExpiry,
  createdAtMs: number,
): string | null {
  if (expiry === "never") return null;
  return new Date(createdAtMs + EXPIRY_MS[expiry]).toISOString();
}

/** Share tokens are URL path segments and file names, so keep them inert. */
export function isSessionShareToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** Owner-side record of a share link. Never returned by public routes. */
export interface SessionShareRecord {
  token: string;
  projectId: string;
  sessionId: string;
  title: string | null;
  provider?: string;
  createdAt: string;
  /** ISO timestamp, or null when the link never expires. */
  expiresAt: string | null;
  messageCount: number;
  sizeBytes: number;
}

/** Session header frozen into a snapshot. Deliberately excludes paths/ids. */
export interface SessionShareSnapshotSession {
  title: string | null;
  provider?: string;
  model?: string;
  /** Project directory basename only, never the full path. */
  projectName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionShareSnapshot {
  version: 1;
  capturedAt: string;
  session: SessionShareSnapshotSession;
  /** Normalized session messages, as returned by the session detail API. */
  messages: unknown[];
  /** Inline media was dropped to keep the snapshot within the size budget. */
  mediaOmitted?: boolean;
  /** Older history could not be loaded completely; the snapshot is a tail. */
  truncated?: boolean;
}

/** Body of `GET /api/public/session-shares/:token`. */
export interface PublicSessionShareResponse {
  share: {
    createdAt: string;
    expiresAt: string | null;
  };
  snapshot: SessionShareSnapshot;
}
