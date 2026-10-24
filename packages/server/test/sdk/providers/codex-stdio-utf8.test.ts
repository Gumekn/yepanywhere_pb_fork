import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient as BridgeClient } from "../../../src/codex-bridge/CodexAppServerClient.js";
import {
  CodexAppServerClient,
  CodexProvider,
} from "../../../src/sdk/providers/codex.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const text = "水果留在 groups，工具移到外层，蔬菜丢失。 café 🥬";

interface Request {
  id?: number;
  method: string;
}

function appServer(onRequest: (request: Request) => unknown) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(),
  });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as Request;
    if (request.id === undefined) return;
    const result = request.method === "initialize" ? {} : onRequest(request);
    const bytes = Buffer.from(
      `${JSON.stringify({ id: request.id, result })}\n`,
    );
    // Force every possible multi-byte character boundary, without relying on
    // OS pipe chunk sizes or timing. No real Codex process/model is invoked.
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
  return child;
}

function notify(stdout: PassThrough) {
  const notification = {
    method: "item/agentMessage/delta",
    params: { threadId: "thread", turnId: "turn", itemId: "item", delta: text },
  };
  const bytes = Buffer.from(`${JSON.stringify(notification)}\n`);
  const split = bytes.indexOf(Buffer.from("蔬")) + 1;
  stdout.write(bytes.subarray(0, split));
  // Finish the split character and send another complete JSON line together.
  stdout.write(Buffer.concat([bytes.subarray(split), bytes]));
  return notification;
}

afterEach(() => vi.clearAllMocks());

describe("Codex stdio UTF-8 decoding", () => {
  it("preserves fragmented history responses and live notifications", async () => {
    const child = appServer(() => ({ text }));
    const client = new CodexAppServerClient("codex", process.cwd(), {});
    try {
      await client.connect();
      await expect(client.request("thread/read")).resolves.toEqual({ text });
      const notification = notify(child.stdout);
      await expect(client.nextNotification()).resolves.toMatchObject(
        notification,
      );
      await expect(client.nextNotification()).resolves.toMatchObject(
        notification,
      );
    } finally {
      await client.closeAndWait();
    }
  });

  it("preserves fragmented bridge responses and notifications", async () => {
    const child = appServer(() => ({ text }));
    const onNotification = vi.fn();
    const client = new BridgeClient({
      codexPathOverride: "codex",
      onNotification,
    });
    try {
      await client.start();
      await expect(client.request("thread/read")).resolves.toEqual({ text });
      const notification = notify(child.stdout);
      expect(onNotification).toHaveBeenCalledTimes(2);
      expect(onNotification).toHaveBeenNthCalledWith(
        1,
        notification.method,
        notification.params,
      );
      expect(onNotification).toHaveBeenNthCalledWith(
        2,
        notification.method,
        notification.params,
      );
    } finally {
      client.close();
    }
  });

  it("preserves fragmented model display names and descriptions", async () => {
    appServer(() => ({
      data: [{ id: "utf8-model", displayName: text, description: text }],
    }));
    const provider = new CodexProvider({ codexPath: process.execPath });
    const models = await provider.getAvailableModels();
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "utf8-model",
          name: text,
          description: text,
        }),
      ]),
    );
  });
});
