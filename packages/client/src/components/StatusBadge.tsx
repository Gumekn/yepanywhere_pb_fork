import type { AgentActivity } from "../hooks/useFileActivity";
import type { SessionStatus } from "../types";
import { ThinkingIndicator } from "./ThinkingIndicator";

type BadgeVariant = "self" | "external" | "none";
type NotificationVariant = "needs-input" | "unread" | "continue";
type PendingInputType = "tool-approval" | "user-question";

interface SessionStatusBadgeProps {
  /** Session ownership object */
  status: SessionStatus;
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** Whether session has unread content */
  hasUnread?: boolean;
  /** Current agent activity (in-turn/waiting-input) for activity indicators */
  activity?: AgentActivity;
  /** Whether the session was interrupted and can be resumed */
  interrupted?: boolean;
}

interface CountBadgeProps {
  /** Badge variant */
  variant: BadgeVariant;
  /** Count to display (e.g., "2 Active") */
  count: number;
}

interface NotificationBadgeProps {
  /** Type of notification badge */
  variant: NotificationVariant;
  /** Optional label override */
  label?: string;
}

/**
 * Notification badge indicating action needed or unread content.
 * - "needs-input" (blue): Tool approval or user question pending
 * - "unread" (orange): New content since last viewed
 * - "continue" (amber): Session was interrupted (e.g. by a server restart) and can be resumed
 */
export function NotificationBadge({ variant, label }: NotificationBadgeProps) {
  const defaultLabel =
    variant === "needs-input"
      ? "Input Needed"
      : variant === "continue"
        ? "Continue"
        : "New";

  return (
    <span className={`status-badge notification-${variant}`}>
      {label ?? defaultLabel}
    </span>
  );
}

/**
 * Status badge for a single session in a list.
 * Priority: needs-input (blue) > in-turn (pulsing) > hold > unread (CSS) > idle (nothing).
 * Ownership is intentionally not treated as activity.
 */
export function SessionStatusBadge({
  status: _status,
  pendingInputType,
  hasUnread: _hasUnread,
  activity,
  interrupted,
}: SessionStatusBadgeProps) {
  // Priority 1: Needs input (tool approval or user question)
  if (pendingInputType || activity === "waiting-input") {
    const label =
      pendingInputType === "tool-approval" ? "Approval Needed" : "Question";
    return <NotificationBadge variant="needs-input" label={label} />;
  }

  // Priority 2: In-turn (agent is thinking) - show pulsing indicator
  if (activity === "in-turn") {
    return <ThinkingIndicator variant="pill" />;
  }

  if (activity === "hold") {
    return <span className="status-badge status-self">Hold</span>;
  }

  // Unread content is now handled via CSS class on session list item
  // (bold/bright text like Gmail instead of a badge)

  // Priority 3: Interrupted (e.g. by a server restart) - prompt the user to continue
  if (interrupted) {
    return <NotificationBadge variant="continue" />;
  }

  // Active sessions (self-owned) don't need a separate indicator - "Thinking" badge
  // already shows when the process is actively in-turn
  return null;
}

/**
 * Status badge showing a count of active sessions.
 * Used on the projects list page.
 */
export function ActiveCountBadge({ variant, count }: CountBadgeProps) {
  if (count === 0) return null;

  const label =
    variant === "self"
      ? `${count} Active`
      : variant === "external"
        ? `${count} External`
        : null;

  if (!label) return null;

  return <span className={`status-badge status-${variant}`}>{label}</span>;
}
