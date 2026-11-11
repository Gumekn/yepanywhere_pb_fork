import type { ProjectGitStatusSummary } from "@yep-anywhere/shared";

/**
 * Commit-level sync state shown next to the sidebar branch icon.
 *
 * - `unpushed` (↑): commits not yet on the upstream. Without an upstream the
 *   branch is local-only, so commits not in the remote default branch count.
 * - `incoming` (↓): commits on the remote default branch (e.g. `origin/main`)
 *   that HEAD does not contain. Falls back to the upstream when the default
 *   branch cannot be resolved.
 *
 * Both are computed from local remote-tracking refs, so `incoming` only grows
 * after a fetch (the sidebar refresh button triggers one).
 */
export interface GitSyncIndicator {
  unpushed: number;
  unpushedRef: string | null;
  incoming: number;
  incomingRef: string | null;
  /** ↑ and ↓ are measured against the same ref and both are non-zero. */
  diverged: boolean;
}

export function getGitSyncIndicator(
  status: ProjectGitStatusSummary,
): GitSyncIndicator {
  const base = status.base ?? null;
  const unpushedRef = status.upstream ?? base?.ref ?? null;
  const unpushed = status.upstream ? status.ahead : (base?.ahead ?? 0);
  const incomingRef = base?.ref ?? status.upstream;
  const incoming = base ? base.behind : status.behind;

  return {
    unpushed,
    unpushedRef,
    incoming,
    incomingRef,
    diverged:
      unpushed > 0 &&
      incoming > 0 &&
      unpushedRef !== null &&
      unpushedRef === incomingRef,
  };
}

export function formatGitCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
