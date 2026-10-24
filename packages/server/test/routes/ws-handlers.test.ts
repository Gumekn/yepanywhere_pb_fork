import { gunzipSync } from "node:zlib";
import {
  BinaryFormat,
  type YepMessage,
  decodeCompressedJsonFrame,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type WSAdapter,
  type WsHandlerDeps,
  cleanupTerminalAttachments,
  createConnectionState,
  createSendFn,
  handleMessage,
  handleSessionSubscribe,
  handleUnsubscribe,
} from "../../src/routes/ws-handlers.js";
import type { RuntimeController } from "../../src/runtime/types.js";

type SentFrame = string | ArrayBuffer | Uint8Array<ArrayBuffer>;

function frameToBytes(frame: SentFrame): Uint8Array {
  if (typeof frame === "string") {
    return new TextEncoder().encode(frame);
  }
  return frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
}

function decodeJsonFrame(frame: SentFrame): unknown {
  const bytes = frameToBytes(frame);
  if (bytes[0] === BinaryFormat.COMPRESSED_JSON) {
    const compressed = decodeCompressedJsonFrame(bytes);
    return JSON.parse(gunzipSync(compressed).toString("utf8"));
  }
  if (bytes[0] === BinaryFormat.JSON) {
    return JSON.parse(new TextDecoder().decode(bytes.slice(1)));
  }
  if (typeof frame === "string") {
    return JSON.parse(frame);
  }
  throw new Error(`Unexpected frame type: ${bytes[0]}`);
}

async function waitForFrames(sent: SentFrame[], count: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (sent.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} frames, got ${sent.length}`);
}

describe("WebSocket handlers", () => {
  it("preserves terminal attachment routing and detachment", async () => {
    const send = vi.fn();
    const terminalService = { handleMessage: vi.fn(), detachAll: vi.fn() };
    const message = {
      type: "terminal_open",
      terminalId: "terminal-1",
      cols: 80,
      rows: 24,
    };
    const ws: WSAdapter = { send: vi.fn(), close: vi.fn() };
    const deps = { terminalService } as unknown as WsHandlerDeps;
    await handleMessage(
      ws,
      new Map(),
      new Map(),
      createConnectionState(),
      send,
      JSON.stringify(message),
      deps,
      {},
      "attachment-1",
    );
    expect(terminalService.handleMessage).toHaveBeenCalledWith(
      message,
      "attachment-1",
      send,
    );
    cleanupTerminalAttachments("attachment-1", deps.terminalService);
    expect(terminalService.detachAll).toHaveBeenCalledWith("attachment-1");
  });

  it("keeps outbound frame order while compressing large JSON asynchronously", async () => {
    const sent: SentFrame[] = [];
    const ws: WSAdapter = {
      send: vi.fn((data: SentFrame) => {
        sent.push(data);
      }),
      close: vi.fn(),
    };
    const connState = createConnectionState({ useCompressedJsonFrames: true });
    const send = createSendFn(ws, connState);

    send({
      type: "response",
      id: "large",
      status: 200,
      body: { text: "x".repeat(32 * 1024) },
    } as YepMessage);
    send({
      type: "event",
      subscriptionId: "sub-1",
      eventType: "status",
      data: { state: "idle" },
    } as YepMessage);

    await waitForFrames(sent, 2);

    expect(frameToBytes(sent[0])?.[0]).toBe(BinaryFormat.COMPRESSED_JSON);
    expect(decodeJsonFrame(sent[0])).toMatchObject({
      type: "response",
      id: "large",
    });
    expect(decodeJsonFrame(sent[1])).toMatchObject({
      type: "event",
      eventType: "status",
    });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("cleans up a session subscription that resolves after unsubscribe", async () => {
    let resolveSubscription: ((value: { cleanup(): void }) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const cleanup = vi.fn();
    const runtimeController = {
      subscribeSession: vi.fn(
        (
          _sessionId: string,
          _emit: (eventType: string, data: unknown) => void,
          options?: { signal?: AbortSignal },
        ) => {
          observedSignal = options?.signal;
          return new Promise<{ cleanup(): void }>((resolve) => {
            resolveSubscription = resolve;
          });
        },
      ),
    } as unknown as RuntimeController;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();

    const pending = handleSessionSubscribe(
      subscriptions,
      {
        type: "subscribe",
        subscriptionId: "sub-race",
        channel: "session",
        sessionId: "session-race",
      },
      send,
      runtimeController,
    );
    handleUnsubscribe(subscriptions, {
      type: "unsubscribe",
      subscriptionId: "sub-race",
    });

    expect(observedSignal?.aborted).toBe(true);
    resolveSubscription?.({ cleanup });
    await pending;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(subscriptions.has("sub-race")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  describe("session subscription failures", () => {
    function displayRejecting(error: unknown) {
      return {
        subscribe: vi.fn(async () => {
          throw error;
        }),
      } as unknown as Parameters<typeof handleSessionSubscribe>[4];
    }
    const msg = {
      type: "subscribe" as const,
      subscriptionId: "sub-missing",
      channel: "session" as const,
      sessionId: "gone",
      display: { projectId: "project" },
    };

    it("answers a missing session with its 404 instead of a generic 500", async () => {
      const subscriptions = new Map<string, () => void>();
      const send = vi.fn();
      const notFound = Object.assign(new Error("Session not found"), {
        status: 404,
        code: "SESSION_NOT_FOUND",
      });
      await handleSessionSubscribe(
        subscriptions,
        msg,
        send,
        {} as RuntimeController,
        displayRejecting(notFound),
      );
      expect(send).toHaveBeenCalledWith({
        type: "response",
        id: "sub-missing",
        status: 404,
        body: { error: "Session not found", code: "SESSION_NOT_FOUND" },
      });
      expect(subscriptions.has("sub-missing")).toBe(false);
    });

    it("hides internal errors behind a 500", async () => {
      const send = vi.fn();
      await handleSessionSubscribe(
        new Map(),
        msg,
        send,
        {} as RuntimeController,
        displayRejecting(new Error("disk exploded at /secret/path")),
      );
      expect(send).toHaveBeenCalledWith({
        type: "response",
        id: "sub-missing",
        status: 500,
        body: { error: "Internal server error" },
      });
    });

    it("stays silent when the client already unsubscribed", async () => {
      const subscriptions = new Map<string, () => void>();
      const send = vi.fn();
      let reject!: (error: unknown) => void;
      const display = {
        subscribe: vi.fn(
          () =>
            new Promise((_resolve, rejectFn) => {
              reject = rejectFn;
            }),
        ),
      } as unknown as Parameters<typeof handleSessionSubscribe>[4];
      const pending = handleSessionSubscribe(
        subscriptions,
        msg,
        send,
        {} as RuntimeController,
        display,
      );
      handleUnsubscribe(subscriptions, {
        type: "unsubscribe",
        subscriptionId: "sub-missing",
      });
      reject(Object.assign(new Error("gone"), { status: 404 }));
      await pending;
      expect(send).not.toHaveBeenCalled();
    });
  });
});
