import { describe, expect, it } from "vitest";
import { isSyntheticUserPromptText } from "../../src/sessions/user-prompt-classification.js";

describe("isSyntheticUserPromptText", () => {
  it("treats Codex goal host context as synthetic, not a user prompt", () => {
    expect(
      isSyntheticUserPromptText(
        '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>',
      ),
    ).toBe(true);
    expect(
      isSyntheticUserPromptText(
        '<codex_internal_context source="user_goal">\nUser set the goal: "ship"\n</codex_internal_context>',
      ),
    ).toBe(true);
    expect(
      isSyntheticUserPromptText("<goal_context>\nlegacy\n</goal_context>"),
    ).toBe(true);
  });

  it("keeps ordinary prompts that mention the markers", () => {
    expect(
      isSyntheticUserPromptText("why does <codex_internal_context> show up?"),
    ).toBe(false);
  });
});
