import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  applyCursorModelParameters,
  cursorLaunchModel,
  parseCursorModelExpression,
} from "../../../src/sdk/providers/cursor-model-selection.js";

describe("parseCursorModelExpression", () => {
  it("keeps plain and legacy model ids unchanged", () => {
    expect(cursorLaunchModel(undefined)).toBeUndefined();
    expect(parseCursorModelExpression("auto")).toEqual({
      launchModel: "auto",
      modelId: "auto",
      parameters: [],
    });
    expect(parseCursorModelExpression("gpt-5.6-sol-high-fast")).toEqual({
      launchModel: "gpt-5.6-sol-high-fast",
      modelId: "gpt-5.6-sol-high-fast",
      parameters: [],
    });
  });

  it("splits a parameterized expression into a base id and options", () => {
    expect(
      parseCursorModelExpression(
        "grok-4.7[context=500k,reasoning_effort=high,fast=false]",
      ),
    ).toEqual({
      launchModel: "grok-4.7",
      modelId: "grok-4.7",
      parameters: [
        { id: "context", value: "500k" },
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    });
  });

  it("leaves malformed bracket strings untouched", () => {
    for (const model of [
      "grok-4.7[]",
      "grok-4.7[context]",
      "grok-4.7[a=b=c]",
    ]) {
      expect(parseCursorModelExpression(model)).toEqual({
        launchModel: model,
        modelId: model,
        parameters: [],
      });
    }
  });
});

describe("applyCursorModelParameters", () => {
  function option(id: string, currentValue: string): SessionConfigOption {
    return {
      id,
      name: id,
      type: "select",
      currentValue,
      options: [{ value: currentValue, name: currentValue }],
    };
  }

  it("writes the model and each differing option once, then accepts the echoed values", async () => {
    const calls: Array<[string, string]> = [];
    const selected = new Map<string, string>();
    await applyCursorModelParameters(
      {
        setSessionConfigOption: async (_sessionId, configId, value) => {
          calls.push([configId, value]);
          selected.set(configId, value);
          return {
            configOptions: [...selected.entries()].map(([id, currentValue]) =>
              option(id, currentValue),
            ),
          };
        },
      },
      "session-1",
      "grok-4.7[context=500k,fast=false]",
    );
    expect(calls).toEqual([
      ["model", "grok-4.7"],
      ["context", "500k"],
      ["fast", "false"],
    ]);
  });

  it("skips options the new session already reports as active", async () => {
    const calls: Array<[string, string]> = [];
    const state = new Map([
      ["model", "grok-4.7"],
      ["context", "256k"],
      ["reasoning_effort", "high"],
      ["fast", "true"],
    ]);
    const snapshot = () =>
      [...state.entries()].map(([id, value]) => option(id, value));
    await applyCursorModelParameters(
      {
        getSessionConfigOptions: () => snapshot(),
        setSessionConfigOption: async (_sessionId, configId, value) => {
          calls.push([configId, value]);
          state.set(configId, value);
          return { configOptions: snapshot() };
        },
      },
      "session-1",
      "grok-4.7[context=500k,reasoning_effort=high,fast=false]",
    );
    expect(calls).toEqual([
      ["context", "500k"],
      ["fast", "false"],
    ]);
  });

  it("rewrites an option that a later write snapped back", async () => {
    const calls: Array<[string, string]> = [];
    let context = "256k";
    let fast = "true";
    let fastSets = 0;
    await applyCursorModelParameters(
      {
        getSessionConfigOptions: () => [
          option("model", "grok-4.7"),
          option("context", context),
          option("fast", fast),
        ],
        setSessionConfigOption: async (_sessionId, configId, value) => {
          calls.push([configId, value]);
          if (configId === "context") context = value;
          if (configId === "fast") {
            fast = value;
            fastSets += 1;
            if (fastSets === 1) context = "256k";
          }
          return {
            configOptions: [option("context", context), option("fast", fast)],
          };
        },
      },
      "session-1",
      "grok-4.7[context=500k,fast=false]",
    );
    expect(calls).toEqual([
      ["context", "500k"],
      ["fast", "false"],
      ["context", "500k"],
    ]);
  });

  it("recovers when the first pass clobbers an earlier option", async () => {
    let context = "256k";
    let fastSets = 0;
    await applyCursorModelParameters(
      {
        setSessionConfigOption: async (_sessionId, configId, value) => {
          if (configId === "context") context = value;
          if (configId === "fast") {
            fastSets += 1;
            if (fastSets === 1) context = "256k";
          }
          return {
            configOptions: [
              option("context", context),
              option("fast", "false"),
            ],
          };
        },
      },
      "session-1",
      "grok-4.7[context=500k,fast=false]",
    );
    expect(context).toBe("500k");
  });

  it("rejects a selection Cursor silently replaced with the default window", async () => {
    await expect(
      applyCursorModelParameters(
        {
          setSessionConfigOption: async () => ({
            configOptions: [option("context", "256k"), option("fast", "true")],
          }),
        },
        "session-1",
        "grok-4.7[context=500k,fast=false]",
      ),
    ).rejects.toThrow(
      /context=500k \(active: 256k\).*fast=false \(active: true\)/,
    );
  });

  it("does nothing for models without parameters", async () => {
    let calls = 0;
    await applyCursorModelParameters(
      {
        setSessionConfigOption: async () => {
          calls += 1;
          return { configOptions: [] };
        },
      },
      "session-1",
      "auto",
    );
    expect(calls).toBe(0);
  });
});
