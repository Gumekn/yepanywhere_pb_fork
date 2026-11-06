import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GitRemoteFetcher, formatGitError } from "../src/git-remote-fetch.js";
import { getProjectGitStatusSummary } from "../src/git-status-summary.js";

describe("GitRemoteFetcher", () => {
  const repo = (commonDir: string, remotes = ["origin"]) => ({
    commonDir,
    remotes,
  });

  it("deduplicates worktrees sharing a repository and throttles successes", async () => {
    let now = 1_000;
    let finish: (() => void) | undefined;
    const runFetch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const fetcher = new GitRemoteFetcher({
      minIntervalMs: 10_000,
      resolveRepo: async () => repo("/repo/.git"),
      runFetch,
      now: () => now,
    });

    const a = fetcher.fetchPath("/repo");
    const b = fetcher.fetchPath("/repo-worktree");
    await vi.waitFor(() => expect(runFetch).toHaveBeenCalledTimes(1));
    finish?.();
    expect(await a).toEqual({ status: "fetched" });
    expect(await b).toEqual({ status: "fetched" });

    now += 5_000;
    expect(await fetcher.fetchPath("/repo")).toEqual({ status: "skipped" });

    now += 10_000;
    const c = fetcher.fetchPath("/repo");
    await vi.waitFor(() => expect(runFetch).toHaveBeenCalledTimes(2));
    finish?.();
    expect(await c).toEqual({ status: "fetched" });
  });

  it("records failures per path and clears them after a later success", async () => {
    const runFetch = vi
      .fn<(path: string, remote: string | null) => Promise<void>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("exit 128"), {
          stderr:
            "warning: noise\nfatal: unable to access 'https://x/': Could not resolve host\n",
        }),
      )
      .mockResolvedValueOnce(undefined);
    const fetcher = new GitRemoteFetcher({
      resolveRepo: async () => repo("/repo/.git"),
      runFetch,
    });

    expect(await fetcher.fetchPath("/repo")).toEqual({
      status: "failed",
      error: "fatal: unable to access 'https://x/': Could not resolve host",
    });
    expect(fetcher.getError("/repo")).toContain("Could not resolve host");

    // Failures are not throttled, so an immediate retry runs again.
    expect(await fetcher.fetchPath("/repo")).toEqual({ status: "fetched" });
    expect(fetcher.getError("/repo")).toBeNull();
  });

  it("skips non-git paths and repositories without remotes", async () => {
    const runFetch = vi.fn(async () => {});
    const fetcher = new GitRemoteFetcher({
      resolveRepo: async (path) =>
        path === "/plain" ? null : repo(`${path}/.git`, []),
      runFetch,
    });

    const outcomes = await fetcher.fetchPaths(["/plain", "/local-only"]);
    expect(outcomes.get("/plain")).toEqual({ status: "not-git" });
    expect(outcomes.get("/local-only")).toEqual({ status: "no-remote" });
    expect(runFetch).not.toHaveBeenCalled();
  });

  it("names the remote only when there is a single non-origin remote", async () => {
    const runFetch = vi.fn(async () => {});
    const fetcher = new GitRemoteFetcher({
      resolveRepo: async (path) =>
        path === "/single"
          ? repo("/single/.git", ["github"])
          : repo("/multi/.git", ["github", "gitlab"]),
      runFetch,
    });

    await fetcher.fetchPaths(["/single", "/multi"]);
    expect(runFetch).toHaveBeenCalledWith("/single", "github");
    expect(runFetch).toHaveBeenCalledWith("/multi", null);
  });

  it("formats timeouts distinctly", () => {
    expect(formatGitError({ killed: true })).toMatch(/timed out/);
  });
});

describe("remote sync against real git repositories", () => {
  let root: string;
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      env: gitEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  const commit = (cwd: string, message: string) =>
    git(cwd, "commit", "--allow-empty", "--no-gpg-sign", "-m", message);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yep-git-sync-"));
    const bare = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare], {
      env: gitEnv,
      stdio: "ignore",
    });
    const seed = join(root, "seed");
    execFileSync("git", ["clone", "-q", bare, seed], {
      env: gitEnv,
      stdio: "ignore",
    });
    git(seed, "checkout", "-q", "-b", "main");
    commit(seed, "initial");
    git(seed, "push", "-q", "origin", "main");
    for (const name of ["local", "other"]) {
      execFileSync("git", ["clone", "-q", bare, join(root, name)], {
        env: gitEnv,
        stdio: "ignore",
      });
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("shows commits merged to the remote only after a fetch", async () => {
    const local = join(root, "local");
    const other = join(root, "other");
    const fetcher = new GitRemoteFetcher({ minIntervalMs: 0 });

    commit(other, "merged by someone else");
    git(other, "push", "-q", "origin", "main");

    const before = await getProjectGitStatusSummary(local);
    expect(before).toMatchObject({
      upstream: "origin/main",
      behind: 0,
      base: { ref: "origin/main", ahead: 0, behind: 0 },
    });

    expect(await fetcher.fetchPath(local)).toEqual({ status: "fetched" });
    const after = await getProjectGitStatusSummary(local);
    expect(after).toMatchObject({
      behind: 1,
      base: { ref: "origin/main", ahead: 0, behind: 1 },
    });
    expect(after?.lastFetchedAt).toEqual(expect.any(String));

    // Pull so the next scenario starts in sync.
    git(local, "merge", "-q", "--ff-only", "origin/main");
  });

  it("compares a feature branch against origin/main separately from its upstream", async () => {
    const local = join(root, "local");
    const other = join(root, "other");
    const fetcher = new GitRemoteFetcher({ minIntervalMs: 0 });

    git(local, "checkout", "-q", "-b", "feat/x");
    commit(local, "feature work");
    git(local, "push", "-q", "-u", "origin", "feat/x");
    commit(local, "unpushed feature work");

    git(other, "pull", "-q", "--ff-only");
    commit(other, "main moved 1");
    commit(other, "main moved 2");
    git(other, "push", "-q", "origin", "main");

    expect(await fetcher.fetchPath(local)).toEqual({ status: "fetched" });
    const summary = await getProjectGitStatusSummary(local);
    expect(summary).toMatchObject({
      branch: "feat/x",
      upstream: "origin/feat/x",
      ahead: 1,
      behind: 0,
      base: { ref: "origin/main", ahead: 2, behind: 2 },
    });
  });

  it("ignores a default branch that shares no history with HEAD", async () => {
    const repoDir = join(root, "unrelated");
    const bare = join(root, "unrelated.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare], {
      env: gitEnv,
      stdio: "ignore",
    });
    execFileSync("git", ["init", "-q", "-b", "main", repoDir], {
      env: gitEnv,
      stdio: "ignore",
    });
    git(repoDir, "remote", "add", "origin", bare);
    // Placeholder commit on main, as created by a hosting provider.
    commit(repoDir, "Initial commit");
    git(repoDir, "push", "-q", "origin", "main");
    git(repoDir, "remote", "set-head", "origin", "main");
    // Real work lives on an orphan branch with its own history.
    git(repoDir, "checkout", "-q", "--orphan", "dev");
    commit(repoDir, "real work");
    git(repoDir, "push", "-q", "-u", "origin", "dev");

    const summary = await getProjectGitStatusSummary(repoDir);
    expect(summary).toMatchObject({
      upstream: "origin/dev",
      ahead: 0,
      behind: 0,
      base: null,
      unrelatedBaseRef: "origin/main",
    });
  });
});
