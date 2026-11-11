import { afterEach, expect, it, vi } from "vitest";
import {
  installPiSideConversations,
  snapshotMessages,
} from "../../resources/pi-side-conversation.mjs";
import {
  PI_SIDE_COMMAND,
  PI_SIDE_PREFIX,
  PiSideChannel,
} from "../../src/side-conversations/pi.js";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("yep.pi.side-token.v1")
  ];
});

it("requires extension discovery and consumes side packets without waiting for main agent_settled", async () => {
  const sink = vi.fn();
  const commands: Record<string, unknown>[] = [];
  const send = vi.fn(async (command: Record<string, unknown>) => {
    commands.push(command);
    if (command.type === "get_commands")
      return {
        data: {
          commands: [
            {
              name: PI_SIDE_COMMAND,
              description: "Yep private side conversation protocol v1",
            },
          ],
        },
      };
    const payload = JSON.parse(
      String(command.message).slice(PI_SIDE_COMMAND.length + 2),
    );
    channel.accept({
      type: "extension_ui_request",
      method: "notify",
      message: `${PI_SIDE_PREFIX}${JSON.stringify({ type: "control", id: payload.id, requestId: payload.requestId, data: { model: "m" } })}`,
    });
    if (payload.action === "send")
      channel.accept({
        type: "extension_ui_request",
        method: "notify",
        message: `${PI_SIDE_PREFIX}${JSON.stringify({ id: payload.id, type: "text", messageId: "reply", text: "side output", append: true })}`,
      });
    return { data: { disposition: "handled" } };
  });
  const channel = new PiSideChannel(send);
  const side = await channel.create("snapshot", sink);
  await side.send("why?", "request");
  expect(sink).toHaveBeenCalledWith({
    type: "text",
    id: "reply",
    text: "side output",
    append: true,
  });
  expect(channel.accept({ type: "agent_settled" })).toBe(false);
  expect(
    channel.accept({
      type: "extension_ui_request",
      method: "notify",
      message: `${PI_SIDE_PREFIX}broken`,
    }),
  ).toBe(true);
  await side.interrupt();
  await side.close();
  expect(
    commands.some((c) =>
      ["abort", "fork", "steer", "set_model"].includes(String(c.type)),
    ),
  ).toBe(false);
  const unavailable = new PiSideChannel(async () => ({
    data: { commands: [] },
  }));
  await expect(unavailable.create("snapshot", sink)).rejects.toThrow(
    /extension/,
  );
  channel.close();
});

it("copies valid snapshot messages without mutating unfinished parent tool calls", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "working" },
        { type: "toolCall", id: "done" },
        { type: "toolCall", id: "pending" },
      ],
    },
    { role: "toolResult", toolCallId: "done", content: [] },
    { role: "toolResult", toolCallId: "orphan", content: [] },
  ];
  const before = structuredClone(messages);
  const snapshot = snapshotMessages(messages);
  expect(messages).toEqual(before);
  expect(snapshot).toHaveLength(2);
  expect(snapshot[0].content).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain("pending");
  expect(JSON.stringify(snapshot)).not.toContain("orphan");
});

it("creates an isolated SDK session with inherited credentials, read-only tools and no parent writes", async () => {
  vi.stubEnv("YEP_PI_SIDE_TOKEN", "test-token");
  let handler!: (args: string, context: unknown) => Promise<void>;
  const parentWrite = vi.fn();
  const pi = {
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
    getThinkingLevel: () => "high",
    on: vi.fn(),
    sendMessage: parentWrite,
    appendEntry: parentWrite,
    setModel: parentWrite,
  };
  let finish!: () => void;
  let listen!: (event: Record<string, unknown>) => void;
  const prompt = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const session = {
    prompt,
    subscribe: vi.fn((listener: typeof listen) => {
      listen = listener;
      return vi.fn();
    }),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        stopReason: "stop",
      },
    ],
  };
  const manager = { appendMessage: vi.fn() };
  const runtime = {
    registerProvider: vi.fn(),
    refresh: vi.fn(async () => {}),
    setRuntimeApiKey: vi.fn(async () => {}),
  };
  const sdk = {
    ModelRuntime: { create: vi.fn(async () => runtime) },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    SessionManager: { inMemory: vi.fn(() => manager) },
    buildSessionContext: (entries: unknown[]) => ({ messages: entries }),
    createExtensionRuntime: () => ({}),
    createAgentSession: vi.fn(async () => ({ session })),
  };
  const notify = vi.fn();
  const entries = [
    { role: "user", content: [{ type: "text", text: "main snapshot" }] },
  ];
  const context = {
    cwd: "/tmp",
    model: { id: "m", provider: "yep-test" },
    sessionManager: { getBranch: () => entries, getLeafId: () => "leaf" },
    getSystemPrompt: () => "parent policy",
    modelRegistry: {
      getRegisteredProviderConfig: () => ({
        apiKey: "secret",
        baseUrl: "https://gateway.invalid",
      }),
      getRegisteredNativeProvider: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
    },
    ui: { notify },
  };
  installPiSideConversations(pi, async () => sdk);
  const command = (action: string, extra = {}) =>
    handler(
      JSON.stringify({
        token: "test-token",
        id: "side",
        requestId: action,
        action,
        ...extra,
      }),
      context,
    );
  const creating = command("create", { context: "snapshot" });
  const first = entries[0]?.content[0];
  if (first) first.text = "parent progressed";
  await creating;
  expect(process.env.YEP_PI_SIDE_TOKEN).toBeUndefined();
  expect(manager.appendMessage.mock.calls[0]?.[0]).toMatchObject({
    content: [{ text: "main snapshot" }],
  });
  expect(sdk.createAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      tools: ["read", "grep", "find", "ls"],
      excludeTools: ["mcp__*"],
      modelRuntime: runtime,
      thinkingLevel: "high",
    }),
  );
  expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("yep-test", "secret");
  await command("send", { text: "side question" });
  // The command returned while the child model promise is still pending.
  expect(prompt).toHaveBeenCalledWith(
    "side question",
    expect.objectContaining({ expandPromptTemplates: false }),
  );
  // Each step reports its reasoning, structured content and tool results,
  // never an empty prose-only entry.
  const toolStep = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "look" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "a" } },
      { type: "opaque" },
    ],
  };
  notify.mockClear();
  listen({ type: "message_start", message: { role: "assistant" } });
  listen({
    type: "message_update",
    message: toolStep,
    assistantMessageEvent: { type: "thinking_delta", delta: "look" },
  });
  listen({
    type: "message_update",
    message: toolStep,
    assistantMessageEvent: { type: "toolcall_end" },
  });
  listen({ type: "message_end", message: toolStep });
  listen({
    type: "tool_execution_end",
    toolCallId: "call",
    result: {
      content: [
        { type: "text", text: "x".repeat(9_000) },
        { type: "image", data: "bytes" },
      ],
    },
    isError: false,
  });
  const packets = notify.mock.calls.map(([value]) =>
    JSON.parse(String(value).slice("__YEP_PI_SIDE_V1__:".length)),
  );
  expect(packets.map((packet) => packet.type)).toEqual([
    "thinking",
    "blocks",
    "blocks",
    "tool_result",
    "activity",
  ]);
  expect(packets[2]).toMatchObject({
    id: "side",
    messageId: "side-side-1",
    content: [
      { type: "thinking", thinking: "look" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "a" } },
    ],
  });
  expect(packets[2].content).toHaveLength(2);
  expect(packets[3]).toMatchObject({ toolCallId: "call", isError: false });
  expect(packets[3].text).toHaveLength(8_000);
  await command("interrupt");
  expect(session.abort).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() =>
    expect(
      notify.mock.calls.some(([value]) =>
        String(value).includes('"type":"done"'),
      ),
    ).toBe(true),
  );
  await command("close");
  expect(session.dispose).toHaveBeenCalledTimes(1);
  expect(parentWrite).not.toHaveBeenCalled();
});

it("normalizes structured side packets with the main Pi tool mapping", async () => {
  const sink = vi.fn();
  let sideId = "";
  const send = vi.fn(async (command: Record<string, unknown>) => {
    if (command.type === "get_commands")
      return {
        data: {
          commands: [
            {
              name: PI_SIDE_COMMAND,
              description: "Yep private side conversation protocol v1",
            },
          ],
        },
      };
    const payload = JSON.parse(
      String(command.message).slice(PI_SIDE_COMMAND.length + 2),
    );
    sideId = payload.id;
    channel.accept({
      type: "extension_ui_request",
      method: "notify",
      message: `${PI_SIDE_PREFIX}${JSON.stringify({ type: "control", id: payload.id, requestId: payload.requestId, data: {} })}`,
    });
    return {};
  });
  const channel = new PiSideChannel(send);
  await channel.create("snapshot", sink);
  const packet = (event: Record<string, unknown>) =>
    channel.accept({
      type: "extension_ui_request",
      method: "notify",
      message: `${PI_SIDE_PREFIX}${JSON.stringify({ id: sideId, ...event })}`,
    });
  packet({
    type: "blocks",
    messageId: "m",
    content: [
      { type: "thinking", thinking: "t" },
      { type: "toolCall", id: "c", name: "ls", arguments: { path: "src" } },
      { type: "toolCall", name: "missing-id" },
    ],
  });
  packet({ type: "thinking", messageId: "m", text: "more", append: true });
  packet({ type: "tool_result", toolCallId: "c", text: "a.ts", isError: true });
  packet({ type: "tool_result", toolCallId: "c" });
  expect(sink.mock.calls.map(([event]) => event)).toEqual([
    {
      type: "blocks",
      id: "m",
      blocks: [
        { type: "thinking", thinking: "t" },
        {
          type: "tool_use",
          id: "c",
          name: "Glob",
          input: { path: "src", pattern: "*" },
        },
      ],
    },
    { type: "thinking", id: "m", text: "more", append: true },
    { type: "tool_result", toolUseId: "c", content: "a.ts", isError: true },
  ]);
  channel.close();
});
