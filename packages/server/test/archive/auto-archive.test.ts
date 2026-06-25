import { describe, expect, it } from "vitest";
import { shouldSkipAutoArchiveForStarredSession } from "../../src/app.js";

describe("auto archive guards", () => {
  it("skips sessions starred in persisted metadata", () => {
    expect(
      shouldSkipAutoArchiveForStarredSession(
        { isStarred: false },
        { isStarred: true },
      ),
    ).toBe(true);
  });

  it("skips sessions starred in session summaries", () => {
    expect(
      shouldSkipAutoArchiveForStarredSession({ isStarred: true }, undefined),
    ).toBe(true);
  });

  it("allows non-starred sessions to be auto-archived", () => {
    expect(
      shouldSkipAutoArchiveForStarredSession({ isStarred: false }, undefined),
    ).toBe(false);
  });
});
