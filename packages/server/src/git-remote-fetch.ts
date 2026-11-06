import { execFile, spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type { ProjectGitFetchStatus } from "@yep-anywhere/shared";

const execFileAsync = promisify(execFile);

const GIT_PROBE_TIMEOUT_MS = 2_000;
const GIT_FETCH_TIMEOUT_MS = 20_000;
/** A repository fetched successfully within this window is not fetched again. */
const GIT_FETCH_MIN_INTERVAL_MS = 15_000;
const GIT_FETCH_CONCURRENCY = 3;
const MAX_ERROR_LENGTH = 300;
const MAX_STDERR_LENGTH = 16 * 1024;

export interface GitFetchOutcome {
  status: ProjectGitFetchStatus;
  error?: string;
}

export interface GitRepoInfo {
  /** Absolute git common dir; worktrees of one repository share it. */
  commonDir: string;
  remotes: string[];
}

export interface GitRemoteFetcherOptions {
  minIntervalMs?: number;
  concurrency?: number;
  /** Returns null when the path is not inside a git repository. */
  resolveRepo?: (projectPath: string) => Promise<GitRepoInfo | null>;
  runFetch?: (projectPath: string, remote: string | null) => Promise<void>;
  now?: () => number;
}

/**
 * Runs `git fetch` for projects on explicit user request so that ahead/behind
 * counts (which are computed from local remote-tracking refs) can reflect
 * commits that landed on the remote.
 *
 * Fetches are deduplicated per repository (git common dir), throttled after a
 * recent success, bounded in concurrency, and strictly non-interactive.
 */
export class GitRemoteFetcher {
  private readonly minIntervalMs: number;
  private readonly concurrency: number;
  private readonly resolveRepo: (
    projectPath: string,
  ) => Promise<GitRepoInfo | null>;
  private readonly runFetch: (
    projectPath: string,
    remote: string | null,
  ) => Promise<void>;
  private readonly now: () => number;
  private readonly lastSuccessByRepo = new Map<string, number>();
  private readonly inFlightByRepo = new Map<string, Promise<GitFetchOutcome>>();
  private readonly errorByPath = new Map<string, string>();

  constructor(options: GitRemoteFetcherOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? GIT_FETCH_MIN_INTERVAL_MS;
    this.concurrency = Math.max(
      1,
      options.concurrency ?? GIT_FETCH_CONCURRENCY,
    );
    this.resolveRepo = options.resolveRepo ?? resolveGitRepoInfo;
    this.runFetch = options.runFetch ?? runGitFetch;
    this.now = options.now ?? Date.now;
  }

  /** Fetch several project paths with bounded concurrency. */
  async fetchPaths(paths: string[]): Promise<Map<string, GitFetchOutcome>> {
    const unique = [...new Set(paths)];
    const outcomes = new Map<string, GitFetchOutcome>();
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < unique.length) {
        const path = unique[nextIndex];
        nextIndex++;
        if (!path) continue;
        outcomes.set(path, await this.fetchPath(path));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, unique.length) }, () =>
        worker(),
      ),
    );
    return outcomes;
  }

  async fetchPath(projectPath: string): Promise<GitFetchOutcome> {
    const outcome = await this.fetchPathUnrecorded(projectPath);
    if (outcome.status === "failed" && outcome.error) {
      this.errorByPath.set(projectPath, outcome.error);
    } else {
      this.errorByPath.delete(projectPath);
    }
    return outcome;
  }

  /** Error from the most recent fetch attempt for this path, if it failed. */
  getError(projectPath: string): string | null {
    return this.errorByPath.get(projectPath) ?? null;
  }

  private async fetchPathUnrecorded(
    projectPath: string,
  ): Promise<GitFetchOutcome> {
    let repo: GitRepoInfo | null;
    try {
      repo = await this.resolveRepo(projectPath);
    } catch (err) {
      return { status: "failed", error: formatGitError(err) };
    }
    if (!repo) return { status: "not-git" };
    if (repo.remotes.length === 0) return { status: "no-remote" };

    const key = repo.commonDir;
    const existing = this.inFlightByRepo.get(key);
    if (existing) return existing;

    const lastSuccess = this.lastSuccessByRepo.get(key);
    if (
      lastSuccess !== undefined &&
      this.now() - lastSuccess < this.minIntervalMs
    ) {
      return { status: "skipped" };
    }

    // Plain `git fetch` uses the current branch's remote or `origin`; only
    // name a remote when neither can apply.
    const remote =
      !repo.remotes.includes("origin") && repo.remotes.length === 1
        ? (repo.remotes[0] ?? null)
        : null;

    const promise = this.runFetch(projectPath, remote)
      .then((): GitFetchOutcome => {
        this.lastSuccessByRepo.set(key, this.now());
        return { status: "fetched" };
      })
      .catch(
        (err): GitFetchOutcome => ({
          status: "failed",
          error: formatGitError(err),
        }),
      )
      .finally(() => {
        if (this.inFlightByRepo.get(key) === promise) {
          this.inFlightByRepo.delete(key);
        }
      });
    this.inFlightByRepo.set(key, promise);
    return promise;
  }
}

async function resolveGitRepoInfo(
  projectPath: string,
): Promise<GitRepoInfo | null> {
  let commonDirOutput: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "--git-common-dir"],
      { maxBuffer: 16 * 1024, timeout: GIT_PROBE_TIMEOUT_MS },
    );
    commonDirOutput = stdout.trim();
  } catch (err) {
    if (isNotGitRepoError(err)) return null;
    throw err;
  }
  if (!commonDirOutput) return null;

  const { stdout: remoteOutput } = await execFileAsync(
    "git",
    ["-C", projectPath, "remote"],
    { maxBuffer: 16 * 1024, timeout: GIT_PROBE_TIMEOUT_MS },
  );
  return {
    commonDir: resolvePath(projectPath, commonDirOutput),
    remotes: remoteOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function runGitFetch(
  projectPath: string,
  remote: string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-C",
        projectPath,
        // Never let a user-triggered fetch kick off gc/maintenance.
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "fetch",
        "--quiet",
        ...(remote ? [remote] : []),
      ],
      {
        // New session without a controlling terminal, so ssh cannot fall back
        // to prompting on /dev/tty (host keys, passphrases).
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          SSH_ASKPASS_REQUIRE: "never",
        },
      },
    );

    let stderr = "";
    let killed = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_LENGTH) stderr += chunk;
    });

    const timer = setTimeout(() => {
      killed = true;
      // Kill the whole process group (git plus its ssh/remote helper).
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, GIT_FETCH_TIMEOUT_MS);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        Object.assign(new Error(`git fetch exited with ${code ?? signal}`), {
          code,
          signal,
          killed,
          stderr,
        }),
      );
    });
  });
}

export function formatGitError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      killed?: boolean;
      signal?: string | null;
      stderr?: string | Buffer;
      message?: string;
    };
    if (e.killed) {
      return `git fetch timed out after ${GIT_FETCH_TIMEOUT_MS / 1000}s`;
    }
    const stderr =
      typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    const lines = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const meaningful =
      lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines[0];
    if (meaningful) return truncate(meaningful);
    if (e.message) return truncate(e.message.split("\n")[0] ?? e.message);
  }
  return truncate(String(err));
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_LENGTH
    ? `${value.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : value;
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
