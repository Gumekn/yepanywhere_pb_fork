import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type {
  ProjectGitBaseComparison,
  ProjectGitStatusSummary,
} from "@yep-anywhere/shared";

const execFileAsync = promisify(execFile);

const GIT_STATUS_TIMEOUT_MS = 2_000;

/**
 * How long a git status summary stays fresh before it is recomputed.
 *
 * `GET /api/projects` asks for every project's summary on each request, and the
 * mobile client polls that endpoint frequently. Without a cache each request
 * spawned `2 x N` git subprocesses (status + stash list per project), which is
 * the single most expensive uncached path in the project list. A short TTL
 * mirrors the ProjectScanner snapshot window and collapses bursts of polls into
 * one git invocation per project.
 */
const GIT_STATUS_CACHE_TTL_MS = 3_000;

export const NOT_A_GIT_REPO_SUMMARY: ProjectGitStatusSummary = {
  isGitRepo: false,
  branch: null,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  isClean: true,
  stagedCount: 0,
  unstagedCount: 0,
  deletedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  stashCount: 0,
  base: null,
  lastFetchedAt: null,
};

export async function getProjectGitStatusSummary(
  projectPath: string,
): Promise<ProjectGitStatusSummary | null> {
  try {
    const [statusResult, stashResult, remoteRefsOutput, fetchHeadPath] =
      await Promise.all([
        execFileAsync(
          "git",
          ["-C", projectPath, "status", "--porcelain=v2", "--branch"],
          {
            maxBuffer: 512 * 1024,
            timeout: GIT_STATUS_TIMEOUT_MS,
          },
        ),
        execFileAsync(
          "git",
          ["-C", projectPath, "stash", "list", "--format=%gd"],
          {
            maxBuffer: 128 * 1024,
            timeout: GIT_STATUS_TIMEOUT_MS,
          },
        ).catch(() => ({ stdout: "", stderr: "" })),
        execFileAsync(
          "git",
          [
            "-C",
            projectPath,
            "for-each-ref",
            "--format=%(refname)%09%(symref)%09%(objectname)",
            ...REMOTE_DEFAULT_BRANCH_PATTERNS,
          ],
          {
            maxBuffer: 128 * 1024,
            timeout: GIT_STATUS_TIMEOUT_MS,
          },
        )
          .then((result) => result.stdout)
          .catch(() => ""),
        resolveFetchHeadPath(projectPath),
      ]);
    const summary = parseGitStatusSummary(
      statusResult.stdout,
      countNonEmptyLines(stashResult.stdout),
    );
    const headOid = parseHeadOid(statusResult.stdout);
    const [{ base, unrelatedBaseRef }, lastFetchedAt] = await Promise.all([
      resolveBaseComparison(projectPath, summary, headOid, remoteRefsOutput),
      readFetchedAt(fetchHeadPath),
    ]);
    return { ...summary, base, unrelatedBaseRef, lastFetchedAt };
  } catch (err) {
    if (isNotGitRepoError(err)) {
      return NOT_A_GIT_REPO_SUMMARY;
    }
    return null;
  }
}

/** Remote refs that can identify a remote's default branch. */
const REMOTE_DEFAULT_BRANCH_PATTERNS = [
  "refs/remotes/*/HEAD",
  "refs/remotes/*/main",
  "refs/remotes/*/master",
];

const REMOTES_PREFIX = "refs/remotes/";

interface RemoteRefEntry {
  remote: string;
  name: string;
  /** Short symref target for `<remote>/HEAD`, e.g. "origin/main" */
  target: string | null;
  oid: string;
}

export function parseRemoteDefaultRefs(output: string): RemoteRefEntry[] {
  const entries: RemoteRefEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [refname, symref, oid] = line.split("\t");
    if (!refname?.startsWith(REMOTES_PREFIX) || !oid) continue;
    const shortName = refname.slice(REMOTES_PREFIX.length);
    const slash = shortName.lastIndexOf("/");
    if (slash <= 0) continue;
    entries.push({
      remote: shortName.slice(0, slash),
      name: shortName.slice(slash + 1),
      target: symref?.startsWith(REMOTES_PREFIX)
        ? symref.slice(REMOTES_PREFIX.length)
        : null,
      oid,
    });
  }
  return entries;
}

/**
 * Pick the remote default branch to compare HEAD against.
 *
 * Uses the remote of the current upstream when there is one (falling back to
 * `origin`, then to the only remote present), and prefers `<remote>/HEAD`'s
 * target over `main` over `master`.
 */
export function selectBaseRef(
  entries: RemoteRefEntry[],
  upstream: string | null,
): { ref: string; oid: string } | null {
  if (entries.length === 0) return null;
  const remotes = [...new Set(entries.map((entry) => entry.remote))];
  let remote: string | undefined;
  if (upstream) {
    remote = remotes
      .filter((candidate) => upstream.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0];
  }
  remote ??= remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  if (!remote) return null;

  const forRemote = entries.filter((entry) => entry.remote === remote);
  const head = forRemote.find((entry) => entry.name === "HEAD");
  if (head?.target) return { ref: head.target, oid: head.oid };
  for (const name of ["main", "master"]) {
    const entry = forRemote.find((candidate) => candidate.name === name);
    if (entry) return { ref: `${remote}/${name}`, oid: entry.oid };
  }
  return null;
}

export function parseHeadOid(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      return value === "(initial)" || !value ? null : value;
    }
  }
  return null;
}

const MAX_MEMO_ENTRIES = 512;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_MEMO_ENTRIES) map.clear();
  map.set(key, value);
}

/**
 * `HEAD...base` counts keyed by `${headOid}...${baseOid}`; immutable per key.
 * "unrelated" marks a base with no common ancestor (e.g. a hosting
 * provider's placeholder "Initial commit" on main while work happens on
 * another branch), which is not a meaningful comparison target.
 */
const aheadBehindMemo = new Map<
  string,
  { ahead: number; behind: number } | "unrelated"
>();

interface BaseResolution {
  base: ProjectGitBaseComparison | null;
  unrelatedBaseRef: string | null;
}

const NO_BASE: BaseResolution = { base: null, unrelatedBaseRef: null };

async function resolveBaseComparison(
  projectPath: string,
  summary: ProjectGitStatusSummary,
  headOid: string | null,
  remoteRefsOutput: string,
): Promise<BaseResolution> {
  const selected = selectBaseRef(
    parseRemoteDefaultRefs(remoteRefsOutput),
    summary.upstream,
  );
  if (!selected || !headOid) return NO_BASE;
  if (selected.ref === summary.upstream) {
    return {
      base: {
        ref: selected.ref,
        ahead: summary.ahead,
        behind: summary.behind,
      },
      unrelatedBaseRef: null,
    };
  }

  const memoKey = `${headOid}...${selected.oid}`;
  let counts = aheadBehindMemo.get(memoKey);
  if (!counts) {
    try {
      counts = await computeAheadBehind(projectPath, headOid, selected.oid);
    } catch {
      return NO_BASE;
    }
    setBounded(aheadBehindMemo, memoKey, counts);
  }
  if (counts === "unrelated") {
    return { base: null, unrelatedBaseRef: selected.ref };
  }
  return { base: { ref: selected.ref, ...counts }, unrelatedBaseRef: null };
}

async function computeAheadBehind(
  projectPath: string,
  headOid: string,
  baseOid: string,
): Promise<{ ahead: number; behind: number } | "unrelated"> {
  try {
    await execFileAsync(
      "git",
      ["-C", projectPath, "merge-base", headOid, baseOid],
      { maxBuffer: 16 * 1024, timeout: GIT_STATUS_TIMEOUT_MS },
    );
  } catch (err) {
    // `git merge-base` exits 1 without output when there is no common
    // ancestor; anything else is a real failure.
    const e = err as { code?: number | string; stdout?: string };
    if (e.code === 1 && !e.stdout?.trim()) return "unrelated";
    throw err;
  }

  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      projectPath,
      "rev-list",
      "--left-right",
      "--count",
      `${headOid}...${baseOid}`,
    ],
    { maxBuffer: 16 * 1024, timeout: GIT_STATUS_TIMEOUT_MS },
  );
  const [aheadText, behindText] = stdout.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadText ?? "0", 10) || 0,
    behind: Number.parseInt(behindText ?? "0", 10) || 0,
  };
}

/** Resolved `$GIT_DIR/FETCH_HEAD` per project path (stable for a checkout). */
const fetchHeadPathMemo = new Map<string, string>();

async function resolveFetchHeadPath(
  projectPath: string,
): Promise<string | null> {
  const memo = fetchHeadPathMemo.get(projectPath);
  if (memo) return memo;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "--git-path", "FETCH_HEAD"],
      { maxBuffer: 16 * 1024, timeout: GIT_STATUS_TIMEOUT_MS },
    );
    const relative = stdout.trim();
    if (!relative) return null;
    const resolved = resolvePath(projectPath, relative);
    setBounded(fetchHeadPathMemo, projectPath, resolved);
    return resolved;
  } catch {
    return null;
  }
}

async function readFetchedAt(
  fetchHeadPath: string | null,
): Promise<string | null> {
  if (!fetchHeadPath) return null;
  try {
    const info = await stat(fetchHeadPath);
    return info.mtime.toISOString();
  } catch {
    return null;
  }
}

export function parseGitStatusSummary(
  output: string,
  stashCount = 0,
): ProjectGitStatusSummary {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let deletedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length);
      head = value === "(initial)" ? null : value.slice(0, 7);
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match?.[1] && match[2]) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(" ")[1];
      const stagedStatus = xy?.[0];
      const unstagedStatus = xy?.[1];
      if (stagedStatus === "D" || unstagedStatus === "D") {
        deletedCount++;
      }
      if (stagedStatus && stagedStatus !== "." && stagedStatus !== "D") {
        stagedCount++;
      }
      if (unstagedStatus && unstagedStatus !== "." && unstagedStatus !== "D") {
        unstagedCount++;
      }
    } else if (line.startsWith("? ")) {
      untrackedCount++;
    } else if (line.startsWith("u ")) {
      conflictedCount++;
    }
  }

  // Stashes are parked work, not working tree changes; they are reported via
  // `stashCount` but do not make the project look dirty.
  const isClean =
    stagedCount === 0 &&
    unstagedCount === 0 &&
    deletedCount === 0 &&
    untrackedCount === 0 &&
    conflictedCount === 0;

  return {
    isGitRepo: true,
    branch,
    head,
    upstream,
    ahead,
    behind,
    isClean,
    stagedCount,
    unstagedCount,
    deletedCount,
    untrackedCount,
    conflictedCount,
    stashCount,
  };
}

function countNonEmptyLines(output: string): number {
  return output.split("\n").filter((line) => line.trim() !== "").length;
}

function isNotGitRepoError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { code?: number | string; stderr?: string };
    if (e.code === 128) return true;
    if (
      typeof e.stderr === "string" &&
      e.stderr.includes("not a git repository")
    ) {
      return true;
    }
  }
  return false;
}

interface GitStatusCacheEntry {
  value: ProjectGitStatusSummary | null;
  timestamp: number;
}

export interface GitStatusSummaryCacheOptions {
  /** Freshness window in milliseconds. Defaults to {@link GIT_STATUS_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Override the underlying git invocation (primarily for tests). */
  compute?: (projectPath: string) => Promise<ProjectGitStatusSummary | null>;
}

/**
 * Per-project-path cache for git status summaries.
 *
 * Combines a short TTL with single-flight deduplication so concurrent callers
 * (e.g. the `getProjectGitStatusSummaries` worker pool during `GET
 * /api/projects`) share one in-flight git invocation per project instead of
 * spawning a fresh subprocess each time. Cache entries are keyed by absolute
 * project path and bounded by the active project set.
 */
export class GitStatusSummaryCache {
  private readonly ttlMs: number;
  private readonly compute: (
    projectPath: string,
  ) => Promise<ProjectGitStatusSummary | null>;
  private readonly cache = new Map<string, GitStatusCacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<ProjectGitStatusSummary | null>
  >();

  constructor(options: GitStatusSummaryCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? GIT_STATUS_CACHE_TTL_MS;
    this.compute = options.compute ?? getProjectGitStatusSummary;
  }

  async get(projectPath: string): Promise<ProjectGitStatusSummary | null> {
    const now = Date.now();
    const cached = this.cache.get(projectPath);
    if (cached && now - cached.timestamp < this.ttlMs) {
      return cached.value;
    }

    const existing = this.inFlight.get(projectPath);
    if (existing) return existing;

    const promise = this.compute(projectPath)
      .then((value) => {
        // Skip caching when invalidate() ran while this computation was in
        // flight: its result may predate the change that caused invalidation.
        if (this.inFlight.get(projectPath) === promise) {
          this.cache.set(projectPath, { value, timestamp: Date.now() });
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(projectPath) === promise) {
          this.inFlight.delete(projectPath);
        }
      });

    this.inFlight.set(projectPath, promise);
    return promise;
  }

  /** Drop the cached summary for a project so the next read recomputes it. */
  invalidate(projectPath: string): void {
    this.cache.delete(projectPath);
    // Detach any in-flight computation so the next read starts a fresh one.
    this.inFlight.delete(projectPath);
  }

  /** Drop all cached summaries. */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}
