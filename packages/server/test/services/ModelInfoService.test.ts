import { describe, expect, it } from "vitest";
import { ModelInfoService } from "../../src/services/ModelInfoService.js";

describe("ModelInfoService", () => {
  it("uses session-specific context windows before model heuristics", () => {
    const service = new ModelInfoService();

    service.recordSessionContextWindow("session-1", 1_000_000, "claude");

    expect(
      service.getContextWindow("claude-opus-4-8", "claude", "session-1"),
    ).toBe(1_000_000);
    expect(
      service.getCachedContextWindow("claude-opus-4-8", "claude", "session-1"),
    ).toBe(1_000_000);
  });

  it("does not let heuristic model-list values downgrade observed windows", () => {
    const service = new ModelInfoService();

    service.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    service.ingestModels("claude", [
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        contextWindow: 200_000,
      },
    ]);

    expect(service.getContextWindow("claude-opus-4-8", "claude")).toBe(
      1_000_000,
    );
  });
});
