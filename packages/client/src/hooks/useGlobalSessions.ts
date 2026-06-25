import { type SessionKind, sessionMatchesKind } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GlobalSessionItem,
  type GlobalSessionStats,
  type ProjectOption,
  api,
} from "../api/client";
import {
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionMetadataChangedEvent,
  type SessionSeenEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
  useFileActivity,
} from "./useFileActivity";

const REFETCH_DEBOUNCE_MS = 500;
const PENDING_TITLE_REFETCH_DELAYS_MS = [1500, 4000, 8000] as const;

function hasResolvedTitle(session: {
  customTitle?: string | null;
  title?: string | null;
}): boolean {
  return Boolean((session.customTitle ?? session.title)?.trim());
}

function needsPendingTitleRefetch(session: {
  customTitle?: string | null;
  title?: string | null;
  messageCount?: number;
}): boolean {
  return !hasResolvedTitle(session) || session.messageCount === 0;
}

function matchesSessionKindFilters(
  session: { customTitle?: string | null; title?: string | null },
  options: {
    sessionKind?: SessionKind | null;
    excludeSessionKind?: SessionKind | null;
  },
): boolean {
  if (
    options.sessionKind &&
    !sessionMatchesKind(session, options.sessionKind)
  ) {
    return false;
  }

  if (
    options.excludeSessionKind &&
    sessionMatchesKind(session, options.excludeSessionKind)
  ) {
    return false;
  }

  return true;
}

function mergeFetchedSession(
  existing: GlobalSessionItem,
  incoming: GlobalSessionItem,
): GlobalSessionItem {
  if (hasResolvedTitle(existing) && !hasResolvedTitle(incoming)) {
    return {
      ...incoming,
      title: existing.title,
      customTitle: existing.customTitle ?? incoming.customTitle,
    };
  }

  return incoming;
}

export interface UseGlobalSessionsOptions {
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
  sessionKind?: SessionKind | null;
  excludeSessionKind?: SessionKind | null;
  includeStats?: boolean;
  /** Skip initial fetch and live refetches while the consuming UI is hidden. */
  enabled?: boolean;
}

/** Default stats when no data loaded */
const DEFAULT_STATS: GlobalSessionStats = {
  totalCount: 0,
  unreadCount: 0,
  starredCount: 0,
  archivedCount: 0,
  providerCounts: {},
  executorCounts: {},
};

export function useGlobalSessions(options: UseGlobalSessionsOptions = {}) {
  const {
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
    sessionKind,
    excludeSessionKind,
    includeStats = false,
    enabled = true,
  } = options;
  const [sessions, setSessions] = useState<GlobalSessionItem[]>([]);
  const [stats, setStats] = useState<GlobalSessionStats>(DEFAULT_STATS);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTitleRefetchTimersRef = useRef<
    Map<string, Set<ReturnType<typeof setTimeout>>>
  >(new Map());
  const latestFetchRef = useRef<(() => Promise<void>) | null>(null);
  const latestRefreshStatsRef = useRef<(() => Promise<void>) | null>(null);
  const hasInitialLoadRef = useRef(false);
  const sessionsRef = useRef<GlobalSessionItem[]>([]);
  sessionsRef.current = sessions;
  const projectsRef = useRef<ProjectOption[]>([]);
  projectsRef.current = projects;

  // Track the options used for the last fetch (for loadMore pagination)
  const lastFetchOptionsRef = useRef<{
    projectId?: string | null;
    searchQuery?: string;
    limit?: number;
    includeArchived?: boolean;
    starred?: boolean;
    sessionKind?: SessionKind | null;
    excludeSessionKind?: SessionKind | null;
    includeStats?: boolean;
    enabled?: boolean;
  }>({});

  const clearPendingTitleRefetch = useCallback((sessionId: string) => {
    const timers = pendingTitleRefetchTimersRef.current.get(sessionId);
    if (!timers) return;

    for (const timer of timers) {
      clearTimeout(timer);
    }
    pendingTitleRefetchTimersRef.current.delete(sessionId);
  }, []);

  const refreshStats = useCallback(async () => {
    if (!enabled || !includeStats || projectId) {
      setStats(DEFAULT_STATS);
      return;
    }

    try {
      const data = await api.getGlobalSessionStats();
      setStats(data.stats ?? DEFAULT_STATS);
    } catch {
      // Keep the sessions list usable if the non-critical counts request fails.
      setStats(DEFAULT_STATS);
    }
  }, [enabled, includeStats, projectId]);
  latestRefreshStatsRef.current = refreshStats;

  const fetch = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }

    // Reset initial load flag when options change
    const optionsChanged =
      lastFetchOptionsRef.current.projectId !== projectId ||
      lastFetchOptionsRef.current.searchQuery !== searchQuery ||
      lastFetchOptionsRef.current.includeArchived !== includeArchived ||
      lastFetchOptionsRef.current.starred !== starred ||
      lastFetchOptionsRef.current.sessionKind !== sessionKind ||
      lastFetchOptionsRef.current.excludeSessionKind !== excludeSessionKind ||
      lastFetchOptionsRef.current.includeStats !== includeStats ||
      lastFetchOptionsRef.current.enabled !== enabled;

    if (optionsChanged) {
      hasInitialLoadRef.current = false;
    }

    lastFetchOptionsRef.current = {
      projectId,
      searchQuery,
      limit,
      includeArchived,
      starred,
      sessionKind,
      excludeSessionKind,
      includeStats,
      enabled,
    };

    // Only show loading state on initial load
    if (sessionsRef.current.length === 0 || optionsChanged) {
      setLoading(true);
    }
    setError(null);

    try {
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        includeArchived,
        starred,
        includeStats: false,
        kind: sessionKind ?? undefined,
        excludeKind: excludeSessionKind ?? undefined,
      });

      for (const session of data.sessions) {
        if (hasResolvedTitle(session)) {
          clearPendingTitleRefetch(session.id);
        }
      }

      if (!hasInitialLoadRef.current || optionsChanged) {
        setSessions(data.sessions);
        hasInitialLoadRef.current = true;
      } else {
        // On refetch, preserve order and update in-place
        setSessions((prev) => {
          const newDataMap = new Map(data.sessions.map((s) => [s.id, s]));

          // Update existing sessions in their current order
          const updated = prev.map((existing) => {
            const newData = newDataMap.get(existing.id);
            return newData ? mergeFetchedSession(existing, newData) : existing;
          });

          // Filter out sessions that no longer exist
          const filtered = updated.filter((s) => newDataMap.has(s.id));

          // Add any new sessions at the top
          const existingIds = new Set(prev.map((s) => s.id));
          const newSessions = data.sessions.filter(
            (s) => !existingIds.has(s.id),
          );

          return [...newSessions, ...filtered];
        });
      }

      setHasMore(data.hasMore);
      if (!includeStats || projectId) {
        setStats(DEFAULT_STATS);
      }
      setProjects(data.projects);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
    sessionKind,
    excludeSessionKind,
    includeStats,
    enabled,
    clearPendingTitleRefetch,
  ]);
  latestFetchRef.current = fetch;

  const schedulePendingTitleRefetch = useCallback((sessionId: string) => {
    if (pendingTitleRefetchTimersRef.current.has(sessionId)) return;

    const timers = new Set<ReturnType<typeof setTimeout>>();
    pendingTitleRefetchTimersRef.current.set(sessionId, timers);

    for (const delayMs of PENDING_TITLE_REFETCH_DELAYS_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (timers.size === 0) {
          pendingTitleRefetchTimersRef.current.delete(sessionId);
        }
        void latestFetchRef.current?.();
      }, delayMs);
      timers.add(timer);
    }
  }, []);

  // Load more sessions (pagination)
  const loadMore = useCallback(async () => {
    if (!enabled || !hasMore || sessions.length === 0) return;

    const lastSession = sessions[sessions.length - 1];
    if (!lastSession) return;

    try {
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        after: lastSession.updatedAt,
        includeArchived,
        starred,
        includeStats: false,
        kind: sessionKind ?? undefined,
        excludeKind: excludeSessionKind ?? undefined,
      });

      setSessions((prev) => {
        // Deduplicate when appending
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = data.sessions.filter((s) => !existingIds.has(s.id));
        return [...prev, ...newSessions];
      });

      setHasMore(data.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [
    hasMore,
    sessions,
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
    sessionKind,
    excludeSessionKind,
    enabled,
  ]);

  // Debounced refetch
  const debouncedRefetch = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      fetch();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetch]);

  const handleReconnect = useCallback(() => {
    void latestRefreshStatsRef.current?.();
    return fetch();
  }, [fetch]);

  // Handle session ownership changes
  const handleSessionStatusChange = useCallback((event: SessionStatusEvent) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === event.sessionId
          ? { ...session, ownership: event.ownership }
          : session,
      ),
    );

    // Clear activity when session goes to none ownership
    if (event.ownership.owner === "none") {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === event.sessionId
            ? {
                ...session,
                pendingInputType: undefined,
                activity: undefined,
              }
            : session,
        ),
      );
    }
  }, []);

  // Handle process state changes
  const handleProcessStateChange = useCallback((event: ProcessStateEvent) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === event.sessionId
          ? { ...session, activity: event.activity }
          : session,
      ),
    );

    // When state changes to "in-turn", clear pendingInputType
    if (event.activity === "in-turn") {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === event.sessionId
            ? { ...session, pendingInputType: undefined }
            : session,
        ),
      );
    }
  }, []);

  // Handle new session created
  const handleSessionCreated = useCallback(
    (event: SessionCreatedEvent) => {
      if (!enabled) return;

      // If we have a project filter, only add sessions from that project
      if (projectId && event.session.projectId !== projectId) return;

      // If we have a starred filter, only add starred sessions
      if (starred && !event.session.isStarred) return;

      if (
        !matchesSessionKindFilters(event.session, {
          sessionKind,
          excludeSessionKind,
        })
      ) {
        return;
      }

      // If we have a search query, refetch to let server filter
      if (searchQuery) {
        debouncedRefetch();
        return;
      }

      if (needsPendingTitleRefetch(event.session)) {
        schedulePendingTitleRefetch(event.session.id);
      }

      setSessions((prev) => {
        // Check for duplicates
        if (prev.some((s) => s.id === event.session.id)) {
          return prev;
        }

        // Look up project name from loaded projects list
        const project = projectsRef.current.find(
          (p) => p.id === event.session.projectId,
        );
        const projectName = project?.name ?? event.session.projectId;

        // Convert SessionSummary to GlobalSessionItem
        const globalSession: GlobalSessionItem = {
          id: event.session.id,
          title: event.session.title,
          createdAt: event.session.createdAt,
          updatedAt: event.session.updatedAt,
          messageCount: event.session.messageCount,
          provider: event.session.provider,
          projectId: event.session.projectId,
          projectName,
          ownership: event.session.ownership,
          pendingInputType: event.session.pendingInputType,
          activity: event.session.activity,
          hasUnread: event.session.hasUnread,
          customTitle: event.session.customTitle,
          isArchived: event.session.isArchived,
          isStarred: event.session.isStarred,
          contextUsage: event.session.contextUsage,
          model: event.session.model,
          reasoningEffort: event.session.reasoningEffort,
          serviceTier: event.session.serviceTier,
        };

        return [globalSession, ...prev];
      });
    },
    [
      projectId,
      searchQuery,
      starred,
      sessionKind,
      excludeSessionKind,
      enabled,
      debouncedRefetch,
      schedulePendingTitleRefetch,
    ],
  );

  // Handle session metadata changes
  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      if (!enabled) return;

      setSessions((prev) => {
        const updated = prev.map((session) => {
          if (session.id !== event.sessionId) return session;

          return {
            ...session,
            ...(event.title !== undefined && { customTitle: event.title }),
            ...(event.archived !== undefined && { isArchived: event.archived }),
            ...(event.starred !== undefined && { isStarred: event.starred }),
          };
        });

        const filtered = updated.filter((session) =>
          matchesSessionKindFilters(session, {
            sessionKind,
            excludeSessionKind,
          }),
        );

        // If this hook has a starred filter, remove sessions that are no longer starred
        if (starred && event.starred === false) {
          return filtered.filter((s) => s.id !== event.sessionId);
        }

        return filtered;
      });

      if (sessionKind || excludeSessionKind) {
        debouncedRefetch();
      }
    },
    [starred, sessionKind, excludeSessionKind, enabled, debouncedRefetch],
  );

  // Handle session seen events
  const handleSessionSeen = useCallback((event: SessionSeenEvent) => {
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== event.sessionId) return session;

        return {
          ...session,
          hasUnread: false,
        };
      }),
    );
  }, []);

  // Handle session content updates (auto-generated title, messageCount, contextUsage)
  const handleSessionUpdated = useCallback(
    (event: SessionUpdatedEvent) => {
      if (!enabled) return;

      if (event.title?.trim()) {
        clearPendingTitleRefetch(event.sessionId);
      } else if (event.title === null || event.messageCount === 0) {
        schedulePendingTitleRefetch(event.sessionId);
      }

      setSessions((prev) => {
        const updated = prev.map((session) => {
          if (session.id !== event.sessionId) return session;
          const ignoreUnresolvedTitle =
            event.title !== undefined &&
            !event.title?.trim() &&
            hasResolvedTitle(session);

          return {
            ...session,
            ...(event.title !== undefined &&
              !ignoreUnresolvedTitle && { title: event.title }),
            ...(event.messageCount !== undefined && {
              messageCount: event.messageCount,
            }),
            ...(event.updatedAt !== undefined && {
              updatedAt: event.updatedAt,
            }),
            ...(event.contextUsage !== undefined && {
              contextUsage: event.contextUsage,
            }),
            ...(event.model !== undefined && { model: event.model }),
            ...(event.reasoningEffort !== undefined && {
              reasoningEffort: event.reasoningEffort,
            }),
            ...(event.serviceTier !== undefined && {
              serviceTier: event.serviceTier,
            }),
          };
        });

        return updated.filter((session) =>
          matchesSessionKindFilters(session, {
            sessionKind,
            excludeSessionKind,
          }),
        );
      });

      if (sessionKind || excludeSessionKind) {
        debouncedRefetch();
      }
    },
    [
      clearPendingTitleRefetch,
      schedulePendingTitleRefetch,
      sessionKind,
      excludeSessionKind,
      enabled,
      debouncedRefetch,
    ],
  );

  // Subscribe to SSE events
  useFileActivity(
    enabled
      ? {
          onSessionStatusChange: handleSessionStatusChange,
          onSessionCreated: handleSessionCreated,
          onProcessStateChange: handleProcessStateChange,
          onSessionMetadataChange: handleSessionMetadataChange,
          onSessionSeen: handleSessionSeen,
          onSessionUpdated: handleSessionUpdated,
          onReconnect: handleReconnect,
        }
      : {},
  );

  // Initial fetch and refetch when options change
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    fetch();
  }, [enabled, fetch]);

  // Global counts are fetched independently so the sessions list can use the
  // server's early-stop path instead of forcing a full stats scan.
  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
      }
      for (const timers of pendingTitleRefetchTimersRef.current.values()) {
        for (const timer of timers) {
          clearTimeout(timer);
        }
      }
      pendingTitleRefetchTimersRef.current.clear();
    };
  }, []);

  return {
    sessions,
    stats,
    projects,
    loading,
    error,
    hasMore,
    loadMore,
    refetch: fetch,
  };
}
