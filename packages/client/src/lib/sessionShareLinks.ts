import { isSessionShareToken } from "@yep-anywhere/shared";
import { API_BASE, appPath } from "./apiPath";

/** Client route that renders a share token, relative to the app base. */
export const SHARE_ROUTE_PREFIX = "/share/";

function origin(): string {
  return window.location.origin;
}

/** Public page for a share token (no login required). */
export function buildShareUrl(token: string): string {
  return `${origin()}${appPath(`${SHARE_ROUTE_PREFIX}${encodeURIComponent(token)}`)}`;
}

/** Plain-text transcript of a share, for handing to an agent. */
export function buildShareMarkdownUrl(token: string): string {
  return `${origin()}${API_BASE}/public/session-shares/${encodeURIComponent(token)}/transcript.md`;
}

/** Owner-side Markdown export of a live session (subject to normal auth). */
export function buildSessionTranscriptUrl(
  projectId: string,
  sessionId: string,
): string {
  return `${origin()}${API_BASE}/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/transcript`;
}

/** Share token when `pathname` is a share page, else null. */
export function matchShareRoute(
  pathname: string,
  basename: string | undefined,
): string | null {
  const base = (basename ?? "").replace(/\/$/, "");
  if (base && !pathname.startsWith(base)) return null;
  const rest = base ? pathname.slice(base.length) : pathname;
  if (!rest.startsWith(SHARE_ROUTE_PREFIX)) return null;
  const token = rest.slice(SHARE_ROUTE_PREFIX.length).replace(/\/$/, "");
  return isSessionShareToken(token) ? token : null;
}
