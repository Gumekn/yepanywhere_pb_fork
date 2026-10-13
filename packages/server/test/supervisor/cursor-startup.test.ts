import { describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";

describe("Cursor native session initialization", () => {
  it.each(["create", "start", "resume"] as const)(
    "waits beyond the legacy five-second fallback for %s",
    async (flow) => {
      vi.useFakeTimers();
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const queue = new MessageQueue();
      const provider = {
        name: "cursor",
        displayName: "Cursor",
        startSession: async () => ({
          iterator: (async function* () {
            await gate;
            yield {
              type: "system" as const,
              subtype: "init",
              session_id: "native-cursor-session",
            };
            for await (const _message of queue.generator())
              yield {
                type: "result" as const,
                session_id: "native-cursor-session",
              };
          })(),
          queue,
          abort: () => {
            ready();
            queue.close();
          },
        }),
      } as AgentProvider;
      const supervisor = new Supervisor({ provider });
      try {
        let settled = false;
        const pending = (
          flow === "create"
            ? supervisor.createSession("/tmp/cursor")
            : flow === "start"
              ? supervisor.startSession("/tmp/cursor", { text: "hello" })
              : supervisor.resumeSession(
                  "native-cursor-session",
                  "/tmp/cursor",
                  { text: "hello" },
                )
        ).then((value) => {
          settled = true;
          return value;
        });
        await vi.advanceTimersByTimeAsync(6_000);
        expect(settled).toBe(false);
        ready();
        const result = await pending;
        expect(result).toMatchObject({ sessionId: "native-cursor-session" });
        expect(
          supervisor.getProcessForSession("native-cursor-session"),
        ).toBeDefined();
      } finally {
        ready();
        queue.close();
        await supervisor.shutdown();
        vi.useRealTimers();
      }
    },
  );
});
