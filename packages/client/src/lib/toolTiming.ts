import type { Message } from "../types";

/** Pair only this call's source events, never the surrounding turn's times. */
export function getToolTiming(id: string, messages: Message[] = []) {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.POSITIVE_INFINITY;
  let durationMs: number | undefined;
  for (const message of messages) {
    const time = Date.parse(message.timestamp ?? "");
    const content = message.message?.content ?? message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id === id && Number.isFinite(time))
        start = Math.min(start, time);
      if (block.type === "tool_result" && block.tool_use_id === id) {
        if (Number.isFinite(time)) end = Math.min(end, time);
        if (
          typeof block.durationMs === "number" &&
          Number.isFinite(block.durationMs) &&
          block.durationMs >= 0
        )
          durationMs ??= block.durationMs;
      }
    }
  }
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    timestamp: Number.isFinite(start)
      ? new Date(start).toISOString()
      : undefined,
    completedAt:
      Number.isFinite(start) && Number.isFinite(end) && end > start
        ? new Date(end).toISOString()
        : undefined,
  };
}
