import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DisplaySourcePage,
  SessionDisplayService,
} from "../../src/display/SessionDisplayService.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import { createSessionSubscription } from "../../src/subscriptions.js";
import { Process } from "../../src/supervisor/Process.js";

const selection = { projectId: "project", sessionId: "session" };
const resources: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of resources.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function setup() {
  let next: (value: IteratorResult<SDKMessage>) => void = () => {};
  const process = new Process(
    {
      next: () =>
        new Promise((resolve) => {
          next = resolve;
        }),
    },
    {
      projectPath: "/test",
      ...selection,
      provider: "codex",
      idleTimeoutMs: 60_000,
      abortFn: () => next({ done: true, value: undefined }),
    },
  );
  resources.push(() => process.terminate("test_complete"));
  const send = async (message: Record<string, unknown>) => {
    await new Promise<void>((resolve) => {
      const unsubscribe = process.subscribe((event) => {
        if (event.type !== "message") return;
        unsubscribe();
        resolve();
      });
      next({ done: false, value: message as SDKMessage });
    });
  };
  const service = new SessionDisplayService({
    runtime: {
      getProcessForSession: async () => process.getInfo(),
      subscribeSession: async (_id, emit, options) => {
        const subscription = createSessionSubscription(process, emit, options);
        await subscription.ready;
        return subscription;
      },
    },
    pollMs: 60_000,
    foldSettledTurns: false,
  });
  resources.push(() => service.dispose());
  service.configureSource({
    stamp: async () => "1",
    read: async (): Promise<DisplaySourcePage> => ({
      provider: "codex",
      messages: [
        {
          type: "user",
          uuid: "prompt",
          codexTurnId: "turn",
          message: { role: "user", content: "Run" },
        },
      ],
      stamp: "1",
      activity: "running",
    }),
    detail: async () => [],
  });
  const text = async () =>
    (await service.snapshot(selection)).nodes.flatMap((node) =>
      node.type === "segment" && node.segment.type === "assistant_text"
        ? [node.segment.content]
        : [],
    );
  const assistant = (content: string) =>
    send({
      type: "assistant",
      uuid: "answer-turn",
      codexTurnId: "turn",
      codexCorrelationKey: "codex:turn:agent-message:answer",
      codexMessagePhase: "final_answer",
      message: { role: "assistant", content },
    });
  const delta = (value: string) =>
    send({
      type: "stream_event",
      uuid: "answer-turn",
      codexTurnId: "turn",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: value },
      },
    });
  return { process, service, send, text, assistant, delta };
}

describe("streaming text catch-up through the runtime subscription", () => {
  it.each([0, 31_000])(
    "restores the prefix with existing history after %i ms away",
    async (awayMs) => {
      vi.useFakeTimers();
      const { process, service, text, assistant, delta } = setup();
      const prefix = "我看完了这次新增的代码。\n\n这里";
      await assistant(""); // Real Codex item/started shape, without message_start.
      await delta(prefix);
      await vi.advanceTimersByTimeAsync(awayMs);
      if (awayMs) expect(process.getMessageHistory()).toHaveLength(0);
      await service.subscribe(selection, vi.fn());
      expect(await text()).toEqual([prefix]);
      await delta("的格式化测试。");
      expect(await text()).toEqual([`${prefix}的格式化测试。`]);
      await assistant(`${prefix}的格式化测试。`);
      expect(await text()).toEqual([`${prefix}的格式化测试。`]);
      expect(process.getStreamingContent()).toBeNull();
    },
  );

  it("accepts the first live delta after Codex's empty item/started message", async () => {
    const { service, text, assistant, delta } = setup();
    await service.subscribe(selection, vi.fn());
    await assistant("");
    await delta("First paragraph");
    expect(await text()).toEqual(["First paragraph"]);
  });

  it("accumulates once for multiple subscribers and survives their cleanup", async () => {
    const { process, assistant, delta } = setup();
    const subscriptions = [false, true].map((displayProjection) =>
      createSessionSubscription(process, vi.fn(), { displayProjection }),
    );
    resources.push(() => {
      for (const subscription of subscriptions) subscription.cleanup();
    });
    await Promise.all(subscriptions.map((s) => s.ready));
    await assistant("");
    await delta("First");
    await vi.waitFor(() =>
      expect(process.getStreamingContent()?.text).toBe("First"),
    );
    for (const subscription of subscriptions) subscription.cleanup();
    await delta(" second");
    expect(process.getStreamingContent()?.text).toBe("First second");
  });

  it("keeps child output and late completion events out of the current answer", async () => {
    const { process, send, assistant, delta } = setup();
    await assistant("");
    await delta("Main");
    await send({
      type: "assistant",
      uuid: "child",
      parent_tool_use_id: "task",
      message: { role: "assistant", content: "Child answer" },
    });
    await send({
      type: "stream_event",
      uuid: "child",
      codexTurnId: "child-turn",
      codexThreadId: "another-session",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Child" },
      },
    });
    await delta(" continues");
    expect(process.getStreamingContent()?.text).toBe("Main continues");
    await send({
      type: "stream_event",
      uuid: "new-turn2",
      codexTurnId: "turn2",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "New answer" },
      },
    });
    await assistant("Main continues");
    await delta(" late");
    await send({
      type: "system",
      subtype: "turn_complete",
      codexTurnId: "turn",
    });
    expect(process.getStreamingContent()?.text).toBe("New answer");
    await send({
      type: "system",
      subtype: "turn_complete",
      codexTurnId: "turn2",
    });
    expect(process.getStreamingContent()).toBeNull();
  });

  it("preserves Claude block indices and appends only to the current text block", async () => {
    const { process, service, send, text } = setup();
    const event = (value: Record<string, unknown>) =>
      send({ type: "stream_event", event: value });
    await event({ type: "message_start", message: { id: "claude-message" } });
    await event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "First" },
    });
    await event({ type: "content_block_stop", index: 0 });
    await event({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "Second" },
    });
    await service.subscribe(selection, vi.fn());
    expect(await text()).toEqual(["First", "Second"]);
    // A new display subscription did not see message_start. The snapshot must
    // restore that identity before unkeyed provider deltas arrive.
    await event({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: " continues" },
    });
    expect(await text()).toEqual(["First", "Second continues"]);
    expect(process.getStreamingContent()?.text).toBe("FirstSecond continues");
    await event({ type: "message_stop" });
    expect(process.getStreamingContent()).toBeNull();
  });
});
