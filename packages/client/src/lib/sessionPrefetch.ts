/**
 * One-shot prefetch for the session route on a cold app start.
 *
 * When the app is opened directly on `/projects/:projectId/sessions/:id`
 * (PWA relaunch, notification click, reload), the session view would only be
 * requested after the entry bundle, the router and the lazy SessionPage chunk
 * have all loaded. The entry starts the two first-paint reads immediately and
 * the session hook consumes them once. Unused or stale results are dropped.
 */
import type { SessionDisplaySnapshot } from "@yep-anywhere/shared";
import { api } from "../api/client";

/** A prefetched read older than this is not trusted as "fresh". */
const PREFETCH_MAX_AGE_MS = 10_000;

const SESSION_ROUTE = /^\/projects\/([^/]+)\/sessions\/([^/]+)\/?$/;

export interface PrefetchedView {
  snapshot: SessionDisplaySnapshot;
  status?: number;
  serverTiming?: string | null;
}

type Metadata = Awaited<ReturnType<typeof api.getSessionMetadata>>;

interface Prefetch {
  key: string;
  startedAt: number;
  view?: Promise<PrefetchedView>;
  metadata?: Promise<Metadata>;
}

let current: Prefetch | null = null;

function keyOf(projectId: string, sessionId: string, branchId?: string) {
  return `${projectId}\0${sessionId}\0${branchId ?? "active"}`;
}

/** Route params from a location, or null when it is not a session view. */
export function parseSessionRoute(
  pathname: string,
  search: string,
  basename = "",
): { projectId: string; sessionId: string; branchId?: string } | null {
  const path =
    basename && pathname.startsWith(basename)
      ? pathname.slice(basename.length) || "/"
      : pathname;
  const match = SESSION_ROUTE.exec(path);
  if (!match?.[1] || !match[2]) return null;
  const params = new URLSearchParams(search);
  // The explicit legacy transcript does not use the display view.
  if (params.get("history") === "legacy") return null;
  let projectId: string;
  let sessionId: string;
  try {
    projectId = decodeURIComponent(match[1]);
    sessionId = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const branchId = params.get("branch") || undefined;
  return { projectId, sessionId, ...(branchId ? { branchId } : {}) };
}

/** Start the first-paint reads for a session route; returns whether it did. */
export function startSessionPrefetch(
  location: Pick<Location, "pathname" | "search">,
  basename = "",
  now: () => number = Date.now,
): boolean {
  const route = parseSessionRoute(location.pathname, location.search, basename);
  if (!route) return false;
  const prefetch: Prefetch = {
    key: keyOf(route.projectId, route.sessionId, route.branchId),
    startedAt: now(),
  };
  let response: { status?: number; serverTiming?: string | null } = {};
  prefetch.view = api
    .getSessionDisplayView(route.projectId, route.sessionId, {
      branchId: route.branchId,
      onResponse: (info) => {
        response = info;
      },
    })
    .then((snapshot) => ({ snapshot, ...response }));
  prefetch.metadata = api.getSessionMetadata(route.projectId, route.sessionId);
  // Unconsumed failures must not surface as unhandled rejections; the hook
  // repeats the request normally.
  prefetch.view.catch(() => undefined);
  prefetch.metadata.catch(() => undefined);
  current = prefetch;
  return true;
}

function take<K extends "view" | "metadata">(
  kind: K,
  projectId: string,
  sessionId: string,
  branchId: string | undefined,
  now: () => number,
): Prefetch[K] | undefined {
  const prefetch = current;
  if (!prefetch || prefetch.key !== keyOf(projectId, sessionId, branchId))
    return undefined;
  if (now() - prefetch.startedAt > PREFETCH_MAX_AGE_MS) {
    current = null;
    return undefined;
  }
  const value = prefetch[kind];
  prefetch[kind] = undefined;
  if (!prefetch.view && !prefetch.metadata) current = null;
  return value;
}

export function takePrefetchedView(
  projectId: string,
  sessionId: string,
  branchId?: string,
  now: () => number = Date.now,
): Promise<PrefetchedView> | undefined {
  return take("view", projectId, sessionId, branchId, now);
}

export function takePrefetchedMetadata(
  projectId: string,
  sessionId: string,
  branchId?: string,
  now: () => number = Date.now,
): Promise<Metadata> | undefined {
  return take("metadata", projectId, sessionId, branchId, now);
}

export function resetSessionPrefetchForTests(): void {
  current = null;
}
