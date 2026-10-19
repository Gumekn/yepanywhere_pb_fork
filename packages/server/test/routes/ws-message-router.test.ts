import { gzipSync } from "node:zlib";
import type { RemoteClientMessage } from "@yep-anywhere/shared";
import { BinaryFormat, encodeCompressedJsonFrame } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { createConnectionState } from "../../src/routes/ws-handlers.js";
import {
  decodeFrameToParsedMessage,
  routeClientMessageSafely,
} from "../../src/routes/ws-message-router.js";

function createMockWs() {
  return {
    close: vi.fn<(code?: number, reason?: string) => void>(),
    send: vi.fn(),
  };
}

function createDecodeDeps() {
  return {
    uploads: new Map(),
    send: vi.fn(),
    uploadManager: {} as never,
    handleBinaryUploadChunk: vi.fn(async () => undefined),
  };
}

describe("WebSocket Message Router", () => {
  it("defaults outbound connection state to binary frames", () => {
    expect(createConnectionState().useBinaryFrames).toBe(true);
    expect(createConnectionState().useCompressedJsonFrames).toBe(false);
    expect(
      createConnectionState({ useCompressedJsonFrames: true })
        .useCompressedJsonFrames,
    ).toBe(true);
  });

  it("decodes text JSON frames", async () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const deps = createDecodeDeps();

    const parsed = await decodeFrameToParsedMessage(
      ws,
      JSON.stringify({ type: "ping", id: "p1" }),
      {},
      connState,
      deps,
    );

    expect(parsed).toEqual({ type: "ping", id: "p1" });
  });

  it("decodes plaintext binary JSON frames (phase 0)", async () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const deps = createDecodeDeps();
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify({ type: "ping", id: "p2" }),
    );
    const frame = new Uint8Array(1 + jsonBytes.length);
    frame[0] = BinaryFormat.JSON;
    frame.set(jsonBytes, 1);

    const parsed = await decodeFrameToParsedMessage(
      ws,
      frame,
      { isBinary: true },
      connState,
      deps,
    );

    expect(parsed).toEqual({ type: "ping", id: "p2" });
    expect(connState.useBinaryFrames).toBe(true);
  });

  it("decodes compressed binary JSON frames", async () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const deps = createDecodeDeps();
    const compressed = gzipSync(
      JSON.stringify({ type: "ping", id: "compressed" }),
    );

    const parsed = await decodeFrameToParsedMessage(
      ws,
      encodeCompressedJsonFrame(compressed),
      { isBinary: true },
      connState,
      deps,
    );

    expect(parsed).toEqual({ type: "ping", id: "compressed" });
    expect(connState.useCompressedJsonFrames).toBe(true);
  });

  it("closes unknown plaintext binary formats with code 4002", async () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const deps = createDecodeDeps();
    const frame = new Uint8Array([0x7f, 0x00]);

    const parsed = await decodeFrameToParsedMessage(
      ws,
      frame,
      { isBinary: true },
      connState,
      deps,
    );

    expect(parsed).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(
      4002,
      expect.stringContaining("0x7f"),
    );
  });

  it("routes message handlers and returns 500 response on handler failure", async () => {
    const send = vi.fn();
    const handlers = {
      onRequest: vi.fn(async () => {
        throw new Error("boom");
      }),
      onSubscribe: vi.fn(async () => undefined),
      onUnsubscribe: vi.fn(async () => undefined),
      onUploadStart: vi.fn(async () => undefined),
      onUploadChunk: vi.fn(async () => undefined),
      onUploadEnd: vi.fn(async () => undefined),
      onPing: vi.fn(async () => undefined),
    };
    const requestMsg = {
      type: "request",
      id: "req-1",
      method: "GET",
      path: "/health",
    } as const;

    await routeClientMessageSafely(requestMsg, send, handlers);

    expect(handlers.onRequest).toHaveBeenCalledWith(requestMsg);
    expect(send).toHaveBeenCalledWith({
      type: "response",
      id: "req-1",
      status: 500,
      body: { error: "Internal server error" },
    });
  });
  it("routes terminal messages after removal of device signaling", async () => {
    const send = vi.fn();
    const handlers = {
      onRequest: vi.fn(async () => undefined),
      onSubscribe: vi.fn(async () => undefined),
      onUnsubscribe: vi.fn(async () => undefined),
      onUploadStart: vi.fn(async () => undefined),
      onUploadChunk: vi.fn(async () => undefined),
      onUploadEnd: vi.fn(async () => undefined),
      onPing: vi.fn(async () => undefined),
      onTerminalMessage: vi.fn(async () => undefined),
    };
    const messages: RemoteClientMessage[] = [
      { type: "terminal_open", terminalId: "term-1", cols: 80, rows: 24 },
      { type: "terminal_input", terminalId: "term-1", data: "bHMK" },
      { type: "terminal_resize", terminalId: "term-1", cols: 100, rows: 40 },
      { type: "terminal_close", terminalId: "term-1" },
    ];
    for (const message of messages) {
      await routeClientMessageSafely(message, send, handlers);
    }
    expect(handlers.onTerminalMessage.mock.calls).toEqual(
      messages.map((message) => [message]),
    );
    expect(send).not.toHaveBeenCalled();
  });
});
