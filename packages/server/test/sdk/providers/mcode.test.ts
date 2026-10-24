import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMcodeModelCatalog,
  parseMcodeModelValue,
  resolveMcodeModelValue,
} from "../../../src/sdk/providers/mcode-models.js";
import {
  buildMcodeElicitationContent,
  planMcodeQuestionnaire,
} from "../../../src/sdk/providers/mcode-questions.js";
import {
  convertMcodeUpdate,
  isMcodeTurnSettledAfter,
  toMcodePermission,
  toMcodeSessionMode,
} from "../../../src/sdk/providers/mcode.js";

// Shape captured from `mcode acp` 0.6.12 session/load configOptions.
const CONFIG_OPTIONS = [
  {
    type: "select",
    id: "permissionMode",
    currentValue: "bypassPermissions",
    options: [
      { value: "default", name: "Ask" },
      { value: "auto", name: "Auto" },
      { value: "bypassPermissions", name: "Full access" },
    ],
  },
  {
    type: "select",
    id: "model",
    currentValue: "m:minimax:MiniMax-M3:v:thinking",
    options: [
      { value: "m:minimax:MiniMax-M3.1-Flash:v:", name: "M3.1-Flash" },
      {
        value: "m:minimax:MiniMax-M3.1-Flash:v:thinking",
        name: "M3.1-Flash · thinking",
      },
      { value: "m:minimax:MiniMax-M3:v:", name: "M3" },
      { value: "m:minimax:MiniMax-M3:v:thinking", name: "M3 · thinking" },
      {
        value: "m:custom_provider%3Awork:gpt-6-sol:v:",
        name: "gpt-6-sol",
      },
    ],
  },
  {
    type: "select",
    id: "thinkingEffort",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

describe("MiniMax Code model catalog", () => {
  it("parses and folds model variants into reasoning efforts", () => {
    expect(
      parseMcodeModelValue("m:custom_provider%3Awork:gpt-6-sol:v:"),
    ).toEqual({
      providerId: "custom_provider:work",
      modelId: "gpt-6-sol",
      variant: "",
    });
    expect(parseMcodeModelValue("m:p:model:u")).toEqual({
      providerId: "p",
      modelId: "model",
    });
    expect(parseMcodeModelValue("nope")).toBeNull();

    const catalog = buildMcodeModelCatalog(CONFIG_OPTIONS);
    expect(catalog.map((model) => model.id)).toEqual([
      "minimax/MiniMax-M3",
      "minimax/MiniMax-M3.1-Flash",
      "custom_provider:work/gpt-6-sol",
    ]);
    expect(catalog[0]).toMatchObject({
      name: "M3",
      defaultReasoningEffort: "high",
      supportsEffort: true,
    });
    expect(
      catalog[0]?.supportedReasoningEfforts?.map((e) => e.reasoningEffort),
    ).toEqual(["off", "low", "high", "max"]);
    expect(catalog[2]?.supportedReasoningEfforts).toBeUndefined();
  });

  it("resolves picker choices to exact ACP model values", () => {
    expect(
      resolveMcodeModelValue(CONFIG_OPTIONS, "minimax/MiniMax-M3", "max"),
    ).toBe("m:minimax:MiniMax-M3:v:thinking");
    expect(
      resolveMcodeModelValue(CONFIG_OPTIONS, "minimax/MiniMax-M3", "off"),
    ).toBe("m:minimax:MiniMax-M3:v:");
    expect(
      resolveMcodeModelValue(
        CONFIG_OPTIONS,
        "custom_provider:work/gpt-6-sol",
        undefined,
      ),
    ).toBe("m:custom_provider%3Awork:gpt-6-sol:v:");
    expect(
      resolveMcodeModelValue(CONFIG_OPTIONS, "minimax/unknown", undefined),
    ).toBeNull();
  });
});

describe("MiniMax Code modes", () => {
  it("splits Yep modes into mcode permission policy and session mode", () => {
    expect(toMcodePermission("default")).toBe("default");
    expect(toMcodePermission("auto")).toBe("auto");
    expect(toMcodePermission("bypassPermissions")).toBe("bypassPermissions");
    expect(toMcodePermission("plan")).toBe("default");
    expect(toMcodePermission("acceptEdits")).toBe("default");
    expect(toMcodeSessionMode("plan")).toBe("plan");
    expect(toMcodeSessionMode("auto")).toBe("default");
  });
});

describe("MiniMax Code questionnaires", () => {
  // Mirrors mcode's Hx() form schema for a single-select step with "Other",
  // a multi-select step and a free-text step.
  const schema = {
    type: "object",
    properties: {
      runs: {
        type: "string",
        title: "采样次数",
        oneOf: [
          { const: "opt-20", title: "20 次", description: "快" },
          { const: "opt-50", title: "50 次" },
        ],
      },
      runs__other: { type: "string", title: "采样次数 \u2014 Other" },
      targets: {
        type: "array",
        title: "目标",
        items: {
          anyOf: [
            { const: "a", title: "A" },
            { const: "b", title: "B" },
          ],
        },
      },
      note: { type: "string", title: "备注" },
    },
    required: ["runs"],
  };

  it("maps form schema steps to Yep questions", () => {
    const plan = planMcodeQuestionnaire(schema, "Need input");
    expect(plan?.questions.map((q) => q.id)).toEqual([
      "runs",
      "targets",
      "note",
    ]);
    expect(plan?.questions[0]).toMatchObject({
      question: "采样次数",
      multiSelect: false,
      custom: true,
      required: true,
      options: [
        { label: "20 次", value: "opt-20", description: "快" },
        { label: "50 次", value: "opt-50", description: "" },
      ],
    });
    expect(plan?.questions[1]).toMatchObject({
      multiSelect: true,
      custom: false,
    });
    expect(plan?.questions[2]).toMatchObject({ options: [], custom: true });
  });

  it("maps answers back to elicitation content", () => {
    const plan = planMcodeQuestionnaire(schema, undefined);
    if (!plan) throw new Error("plan missing");
    expect(
      buildMcodeElicitationContent(plan, {
        runs: "opt-50",
        targets: ["a", "b"],
        note: "ok",
      }),
    ).toEqual({ runs: "opt-50", targets: ["a", "b"], note: "ok" });
    expect(
      buildMcodeElicitationContent(plan, { runs: "custom value" }),
    ).toEqual({ runs__other: "custom value" });
  });

  it("rejects schemas it cannot represent", () => {
    expect(
      planMcodeQuestionnaire({ properties: { x: { type: "number" } } }, ""),
    ).toBeNull();
    expect(planMcodeQuestionnaire(null, "")).toBeNull();
  });
});

describe("MiniMax Code ACP updates", () => {
  it("emits tool_use and tool_result for an already completed tool call", () => {
    const names = new Map<string, string>();
    const messages = convertMcodeUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "bash",
        kind: "execute",
        status: "completed",
        rawInput: { command: "ls" },
        rawOutput: { content: [{ type: "text", text: "a\nb" }] },
      },
      "mvs_1",
      names,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    expect(messages[1]).toMatchObject({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "a\nb" },
        ],
      },
    });
  });

  it("emits a failed tool_result from a terminal update", () => {
    const names = new Map([["call_2", "read"]]);
    const [message] = convertMcodeUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_2",
        status: "failed",
        rawOutput: { error: "ENOENT" },
      },
      "mvs_1",
      names,
    );
    expect(message).toMatchObject({
      message: {
        content: [{ tool_use_id: "call_2", content: "ENOENT", is_error: true }],
      },
    });
  });
});

describe("MiniMax Code questionnaire continuation", () => {
  it("treats the turn as settled only after a final assistant row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcode-continuation-"));
    const path = join(dir, "messages.jsonl");
    const row = (message: Record<string, unknown>) =>
      JSON.stringify({ message_id: String(Math.random()), message });
    try {
      await writeFile(
        path,
        `${row({ role: "assistant", stopReason: "stop", timestamp: 100 })}\n`,
      );
      expect(await isMcodeTurnSettledAfter(path, 200)).toBe(false);
      await writeFile(
        path,
        `${row({ role: "user", content: "Q/A", timestamp: 250 })}\n`,
        { flag: "a" },
      );
      expect(await isMcodeTurnSettledAfter(path, 200)).toBe(false);
      await writeFile(
        path,
        `${row({ role: "assistant", stopReason: "toolUse", timestamp: 260 })}\n`,
        { flag: "a" },
      );
      expect(await isMcodeTurnSettledAfter(path, 200)).toBe(false);
      await writeFile(
        path,
        `${row({ role: "assistant", stopReason: "stop", timestamp: 270 })}\n`,
        { flag: "a" },
      );
      expect(await isMcodeTurnSettledAfter(path, 200)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
