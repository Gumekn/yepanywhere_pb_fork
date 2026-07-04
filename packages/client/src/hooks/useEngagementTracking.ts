import { useCallback, useEffect, useRef } from "react";
import { api } from "../api/client";

/**
 * Tracks user engagement with a session to determine when to mark it as "seen".
 *
 * Definition of "seen": if the session page is visible, the user has seen it.
 * - Navigating into the session = seen (the page is visible at that moment)
 * - New content arriving while the page is visible = seen
 * - Page in the background = not seen (new content stays unread until the user
 *   returns)
 *
 * This intentionally avoids heuristics like "tab focused + recent interaction".
 * Such checks sound careful but in practice cause sessions to stay unread after
 * a quick glance (debounce timers dropped on unmount, mobile scroll not
 * counting as interaction, etc.). For a mobile-first monitor, "I opened it"
 * is the right semantic.
 *
 * We use two different timestamps:
 * - activityAt: Triggers the mark-seen action (includes SSE streaming activity)
 * - updatedAt: The timestamp we send to mark-seen (file mtime)
 *
 * The server takes max(provided timestamp, server now) when recording lastSeen,
 * so late file writes (e.g., tool results flushed after a process stops) that
 * bump mtime won't cause false unread notifications.
 */

interface UseEngagementTrackingOptions {
  /** Session ID to track */
  sessionId: string;
  /**
   * ISO timestamp that triggers the mark-seen action.
   * Can include SSE activity timestamps to immediately mark content as seen
   * while viewing live streams.
   */
  activityAt: string | null;
  /**
   * ISO timestamp to record when marking seen (file mtime).
   * This is what hasUnread() compares against, so it must match the file's
   * actual updatedAt to avoid race conditions.
   */
  updatedAt: string | null;
  /** ISO timestamp of when user last viewed this session */
  lastSeenAt?: string;
  /** Whether the server reports this session as having unread content */
  hasUnread?: boolean;
  /** Whether engagement tracking is enabled (e.g., false for external sessions) */
  enabled?: boolean;
}

export function useEngagementTracking(options: UseEngagementTrackingOptions) {
  const {
    sessionId,
    activityAt,
    updatedAt,
    lastSeenAt,
    hasUnread = false,
    enabled = true,
  } = options;

  const mountedRef = useRef(true);
  // Track the activityAt we've already marked as seen (avoids duplicate calls)
  const markedSeenRef = useRef<string | null>(null);

  // Check if there's content that needs to be marked as seen.
  // This includes:
  // 1. New activity since last seen (activityAt > lastSeenAt)
  // 2. Server reports unread content (hasUnread) - handles edge cases where
  //    timestamps are equal but content is still considered unread
  const hasNewContent = useCallback(() => {
    if (!activityAt) return false;
    if (!lastSeenAt) return true; // Never seen before
    return activityAt > lastSeenAt || hasUnread;
  }, [activityAt, lastSeenAt, hasUnread]);

  // Mark session as seen at updatedAt (file mtime), triggered by activityAt.
  // No debounce: "page visible" is the only gate, so we mark immediately.
  const markSeen = useCallback(async () => {
    if (!enabled || !mountedRef.current) return;
    if (!activityAt || !updatedAt) return;
    if (markedSeenRef.current === activityAt) return;
    if (!hasNewContent()) return;

    try {
      await api.markSessionSeen(sessionId, updatedAt);
      if (mountedRef.current) {
        markedSeenRef.current = activityAt;
      }
    } catch (error) {
      console.warn(
        "[useEngagementTracking] Failed to mark session as seen:",
        error,
      );
    }
  }, [enabled, activityAt, updatedAt, hasNewContent, sessionId]);

  // Mark as seen when new content arrives while the page is visible.
  // Covers the initial navigation too: activityAt first becomes available with
  // the page visible, so this fires immediately on entry.
  useEffect(() => {
    if (!enabled) return;
    if (document.visibilityState !== "visible") return;
    if (hasNewContent()) {
      markSeen();
    }
  }, [enabled, hasNewContent, markSeen]);

  // Mark as seen when the page becomes visible (e.g., switching back to the tab
  // or returning from background). Catches content that arrived while hidden.
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && hasNewContent()) {
        markSeen();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, hasNewContent, markSeen]);

  // Cleanup
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Force mark as seen (for explicit user action, bypasses visibility check)
  const forceMarkSeen = useCallback(async () => {
    if (!enabled || !updatedAt) return;

    try {
      await api.markSessionSeen(sessionId, updatedAt);
      if (mountedRef.current) {
        markedSeenRef.current = activityAt;
      }
    } catch (error) {
      console.warn(
        "[useEngagementTracking] Failed to force mark session as seen:",
        error,
      );
    }
  }, [enabled, sessionId, activityAt, updatedAt]);

  return {
    /** Manually mark the session as seen (bypasses visibility check) */
    forceMarkSeen,
  };
}
