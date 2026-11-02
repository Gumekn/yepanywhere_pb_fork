import { describe, expect, it } from "vitest";
import {
  piAnthropicModelTraits,
  piOpenAiCompatibleThinkingLevelMap,
  piPickerReasoningEfforts,
} from "../../src/sdk/providers/pi-model-compat.js";

describe("piAnthropicModelTraits", () => {
  it("forces the adaptive thinking payload for current Claude releases", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-4-8-fast",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4.8",
    ]) {
      expect(piAnthropicModelTraits(id).compat?.forceAdaptiveThinking, id).toBe(
        true,
      );
    }
  });

  it("leaves budget-based thinking alone for older or non-Claude models", () => {
    for (const id of [
      "claude-opus-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5",
      "glm-5.2",
      "gpt-5.6-sol",
    ]) {
      expect(piAnthropicModelTraits(id), id).toEqual({});
    }
  });

  it("advertises xhigh only where Anthropic supports it", () => {
    expect(piAnthropicModelTraits("claude-opus-4-6").thinkingLevelMap).toEqual({
      max: "max",
    });
    expect(
      piAnthropicModelTraits("claude-sonnet-4-6").thinkingLevelMap,
    ).toEqual({ max: "max" });
    expect(piAnthropicModelTraits("claude-opus-5").thinkingLevelMap).toEqual({
      max: "max",
      xhigh: "xhigh",
    });
    expect(piAnthropicModelTraits("claude-sonnet-5").thinkingLevelMap).toEqual({
      max: "max",
      xhigh: "xhigh",
    });
  });

  it("marks models that reject an explicit thinking disable", () => {
    // Upstream expresses this as `off: null`; without it Pi would send
    // `thinking: { type: "disabled" }` to a model that rejects it.
    for (const id of ["claude-fable-5", "claude-opus-5-5", "claude-opus-5.5"]) {
      expect(piAnthropicModelTraits(id).thinkingLevelMap, id).toEqual({
        max: "max",
        xhigh: "xhigh",
        off: null,
      });
    }
    // Opus 5 and Sonnet 5.5 still accept `thinking: disabled`.
    for (const id of ["claude-opus-5", "claude-sonnet-5-5"]) {
      expect(piAnthropicModelTraits(id).thinkingLevelMap?.off, id).toBe(
        undefined,
      );
    }
  });

  it("drops temperature for the models that reject it", () => {
    expect(piAnthropicModelTraits("claude-opus-5").compat).toEqual({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    });
    expect(piAnthropicModelTraits("claude-opus-4-8").compat).toEqual({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    });
    // Opus 4.6 and the Sonnet line still accept temperature.
    expect(piAnthropicModelTraits("claude-opus-4-6").compat).toEqual({
      forceAdaptiveThinking: true,
    });
    expect(piAnthropicModelTraits("claude-sonnet-5").compat).toEqual({
      forceAdaptiveThinking: true,
    });
  });
});

describe("piOpenAiCompatibleThinkingLevelMap", () => {
  it("carries the extended efforts without marking off unsupported", () => {
    // `off` must stay valid: Pi then omits reasoning_effort, while `off: null`
    // would clamp it to `minimal`, which Claude rejects.
    expect(piOpenAiCompatibleThinkingLevelMap("claude-opus-5-5")).toEqual({
      max: "max",
      xhigh: "xhigh",
    });
    expect(piOpenAiCompatibleThinkingLevelMap("claude-fable-5")).toEqual({
      max: "max",
      xhigh: "xhigh",
    });
    expect(piOpenAiCompatibleThinkingLevelMap("claude-opus-4-6")).toEqual({
      max: "max",
    });
  });

  it("leaves non-adaptive models unmapped", () => {
    for (const id of ["claude-opus-4-5", "gpt-6-sol", "MiniMax-M3.1-Flash"]) {
      expect(piOpenAiCompatibleThinkingLevelMap(id), id).toBeUndefined();
    }
  });
});

describe("piPickerReasoningEfforts", () => {
  it("offers xhigh and max where Pi will send them", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-sonnet-5-5",
      "claude-fable-5",
    ]) {
      expect(piPickerReasoningEfforts(id), id).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
    expect(piPickerReasoningEfforts("claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("keeps the three lossless levels for every other model", () => {
    for (const id of ["claude-haiku-4-5", "gpt-6-sol", "test-model"]) {
      expect(piPickerReasoningEfforts(id), id).toEqual([
        "low",
        "medium",
        "high",
      ]);
    }
  });
});
