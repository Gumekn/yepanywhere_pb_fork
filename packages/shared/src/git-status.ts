export interface GitFileChange {
  /** Relative file path within the repo */
  path: string;
  /** Git status code: M, A, D, ?, R, T, U */
  status: string;
  /** Whether the change is staged (in the index) */
  staged: boolean;
  /** Lines added (null for binary or untracked files) */
  linesAdded: number | null;
  /** Lines deleted (null for binary or untracked files) */
  linesDeleted: number | null;
  /** Original path (for renames) */
  origPath?: string;
}

export interface GitStatusInfo {
  /** Whether the project path is a git repository */
  isGitRepo: boolean;
  /** Current branch name (null if detached HEAD) */
  branch: string | null;
  /** Upstream branch (e.g. "origin/main") */
  upstream: string | null;
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Changed files with status and line counts */
  files: GitFileChange[];
}

/**
 * Commit relationship between HEAD and the remote default branch
 * (e.g. `origin/main`). Based on the local remote-tracking ref, so it only
 * reflects remote changes after a `git fetch`.
 */
export interface ProjectGitBaseComparison {
  /** Remote default branch ref, e.g. "origin/main" */
  ref: string;
  /** Commits in HEAD that are not in the base ref */
  ahead: number;
  /** Commits in the base ref that are not in HEAD */
  behind: number;
}

export interface ProjectGitStatusSummary {
  /** Whether the project path is a git repository */
  isGitRepo: boolean;
  /** Current branch name (null if detached HEAD or not a repo) */
  branch: string | null;
  /** Short HEAD commit hash when detached */
  head: string | null;
  /** Upstream branch (e.g. "origin/main") */
  upstream: string | null;
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Number of files with staged changes */
  stagedCount: number;
  /** Number of files with unstaged changes */
  unstagedCount: number;
  /** Number of deleted files */
  deletedCount: number;
  /** Number of untracked files */
  untrackedCount: number;
  /** Number of files with merge conflicts */
  conflictedCount: number;
  /** Number of stashed changes (does not affect `isClean`) */
  stashCount: number;
  /**
   * Comparison against the remote default branch. Null when it cannot be
   * resolved (no remote, no `origin/HEAD`/`main`/`master`, or no commits).
   */
  base?: ProjectGitBaseComparison | null;
  /**
   * Remote default branch that was skipped because it shares no history with
   * HEAD (e.g. a placeholder "Initial commit" on main). `base` is null then.
   */
  unrelatedBaseRef?: string | null;
  /** ISO timestamp of the last fetch (FETCH_HEAD mtime), null if never fetched */
  lastFetchedAt?: string | null;
  /** Error from the most recent Yep-initiated fetch, null when it succeeded */
  fetchError?: string | null;
}

export type ProjectGitFetchStatus =
  | "fetched"
  | "skipped"
  | "failed"
  | "no-remote"
  | "not-git";

export interface ProjectGitFetchResult {
  projectId: string;
  status: ProjectGitFetchStatus;
  error?: string;
}

export interface ProjectGitFetchResponse {
  results: ProjectGitFetchResult[];
}
