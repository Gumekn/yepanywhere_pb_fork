import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { getToolTiming } from "../toolTiming";

function event(
  type: "tool_use" | "tool_result",
  id: string,
  timestamp?: string,
): Message {
  return {
    type: type === "tool_use" ? "assistant" : "user",
    timestamp,
    message: {
      content: [
        type === "tool_use"
          ? { type, id, name: "Bash", input: {} }
          : { type, tool_use_id: id, content: "ok" },
      ],
    },
  } as Message;
}

describe("getToolTiming", () => {
  it("pairs this tool's first call and result, ignoring parallel calls and replay duplicates", () => {
    expect(
      getToolTiming("a", [
        event("tool_use", "b", "2026-01-01T00:00:00Z"),
        event("tool_use", "a", "2026-01-01T00:00:02Z"),
        event("tool_result", "a", "2026-01-01T00:00:05Z"),
        event("tool_use", "a", "2026-01-01T00:00:10Z"),
        event("tool_result", "a", "2026-01-01T00:00:11Z"),
        event("tool_result", "b", "2026-01-01T00:01:00Z"),
      ]),
    ).toEqual({
      timestamp: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
    });
  });

  it.each([undefined, "bad", "2026-01-01T00:00:00Z", "2025-12-31T23:59:59Z"])(
    "omits missing, malformed or non-increasing end times (%s)",
    (end) => {
      expect(
        getToolTiming("a", [
          event("tool_use", "a", "2026-01-01T00:00:00Z"),
          event("tool_result", "a", end),
        ]).completedAt,
      ).toBeUndefined();
    },
  );

  it("retains native zero duration without absolute timestamps", () => {
    const message = event("tool_result", "a");
    message.message = {
      content: [
        { type: "tool_result", tool_use_id: "a", content: "ok", durationMs: 0 },
      ],
    };
    expect(getToolTiming("a", [message])).toEqual({
      timestamp: undefined,
      completedAt: undefined,
      durationMs: 0,
    });
  });

  it("does not use a result as a start timestamp", () => {
    expect(
      getToolTiming("a", [event("tool_result", "a", "2026-01-01T00:00:05Z")]),
    ).toEqual({ timestamp: undefined, completedAt: undefined });
  });
});
