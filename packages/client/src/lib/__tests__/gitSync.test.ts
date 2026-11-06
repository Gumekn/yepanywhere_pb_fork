import type { ProjectGitStatusSummary } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { formatGitCount, getGitSyncIndicator } from "../gitSync";

const BASE_STATUS: ProjectGitStatusSummary = {
  isGitRepo: true,
  branch: "main",
  head: "abc1234",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  isClean: true,
  stagedCount: 0,
  unstagedCount: 0,
  deletedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  stashCount: 0,
};

describe("getGitSyncIndicator", () => {
  it("uses origin/main for incoming and the upstream for unpushed on a feature branch", () => {
    expect(
      getGitSyncIndicator({
        ...BASE_STATUS,
        branch: "feat/x",
        upstream: "origin/feat/x",
        ahead: 1,
        behind: 2,
        base: { ref: "origin/main", ahead: 6, behind: 3 },
      }),
    ).toEqual({
      unpushed: 1,
      unpushedRef: "origin/feat/x",
      incoming: 3,
      incomingRef: "origin/main",
      diverged: false,
    });
  });

  it("treats a branch without upstream as unpushed relative to origin/main", () => {
    expect(
      getGitSyncIndicator({
        ...BASE_STATUS,
        branch: "local-only",
        upstream: null,
        base: { ref: "origin/main", ahead: 2, behind: 1 },
      }),
    ).toMatchObject({ unpushed: 2, incoming: 1, diverged: true });
  });

  it("falls back to upstream counts when the default branch is unknown", () => {
    expect(
      getGitSyncIndicator({ ...BASE_STATUS, ahead: 1, behind: 4, base: null }),
    ).toMatchObject({
      unpushed: 1,
      incoming: 4,
      incomingRef: "origin/main",
      diverged: true,
    });
  });

  it("reports nothing without any remote refs", () => {
    expect(
      getGitSyncIndicator({ ...BASE_STATUS, upstream: null, base: null }),
    ).toEqual({
      unpushed: 0,
      unpushedRef: null,
      incoming: 0,
      incomingRef: null,
      diverged: false,
    });
  });
});

describe("formatGitCount", () => {
  it("caps large counts", () => {
    expect(formatGitCount(7)).toBe("7");
    expect(formatGitCount(120)).toBe("99+");
  });
});
