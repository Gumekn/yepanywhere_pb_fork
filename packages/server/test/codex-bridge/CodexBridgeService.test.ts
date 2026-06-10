import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CodexBridgeService } from "../../src/codex-bridge/CodexBridgeService.js";
import type { JsonRpcMessage } from "../../src/codex-bridge/types.js";
import type { EventBus } from "../../src/watcher/index.js";

describe("CodexBridgeService", () => {
  let upstreamServer: Server;
  let upstreamWss: WebSocketServer;
  let upstreamPort: number;
  let bridgePort: number;
  let bridge: CodexBridgeService;
  let upstreamSocket: WebSocket | null;
  let upstreamMessages: JsonRpcMessage[];
  let upstreamIsBinaryFlags: boolean[];
  let emittedEvents: unknown[];

  beforeEach(async () => {
    upstreamMessages = [];
    upstreamIsBinaryFlags = [];
    emittedEvents = [];
    upstreamSocket = null;

    upstreamPort = await findAvailablePort();
    upstreamServer = createServer();
    upstreamWss = new WebSocketServer({ server: upstreamServer });
    upstreamWss.on("connection", (ws) => {
      upstreamSocket = ws;
      ws.on("message", (data, isBinary) => {
        upstreamIsBinaryFlags.push(isBinary);
        upstreamMessages.push(JSON.parse(data.toString()) as JsonRpcMessage);
      });
    });
    await listen(upstreamServer, upstreamPort);

    bridgePort = await findAvailablePort();
    const eventBus = {
      emit: vi.fn((event) => emittedEvents.push(event)),
      subscribe: vi.fn(),
      subscriberCount: 0,
    } as unknown as EventBus;
    bridge = new CodexBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      eventBus,
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.shutdown();
    await closeWebSocketServer(upstreamWss);
    await closeServer(upstreamServer);
  });

  it("proxies JSON-RPC and records thread sessions", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      const clientMessagePromise = waitForJsonFrame(client);
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/start",
          params: { cwd: join(tmpdir(), "codex-bridge-test") },
        }),
      );

      await waitFor(() => upstreamMessages.length === 1);
      expect(upstreamMessages[0]).toMatchObject({
        id: 1,
        method: "thread/start",
      });
      expect(upstreamIsBinaryFlags[0]).toBe(false);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-a",
            thread: {
              id: "thread-a",
              preview: "Build the thing",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-a",
              status: { type: "idle" },
              turns: [],
            },
          },
        }),
      );

      const clientFrame = await clientMessagePromise;
      expect(clientFrame.isBinary).toBe(false);
      const sessions = bridge.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "thread-a",
        title: "Build the thing",
        projectPath: "/tmp/project-a",
        model: "gpt-5.3-codex",
      });
      expect(bridge.getStatus()).toMatchObject({
        listening: true,
        connectionCount: 1,
        sessionCount: 1,
      });
    } finally {
      client.close();
    }
  });

  it("keeps idle empty thread records out of displayable session views", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "empty-thread" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-empty",
            thread: {
              id: "empty-thread",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-empty",
              status: { type: "idle" },
              turns: [],
            },
          },
        }),
      );

      await waitFor(() => bridge.listSessions().length === 1);
      expect(bridge.listSessionViews()).toEqual([]);
      expect(bridge.getSessionView("empty-thread")).toBeNull();
      expect(
        emittedEvents.some(
          (event) =>
            (event as { type?: string; session?: { id?: string } }).type ===
              "session-created" &&
            (event as { session?: { id?: string } }).session?.id ===
              "empty-thread",
        ),
      ).toBe(false);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId: "empty-thread" },
        }),
      );

      await waitFor(() => bridge.listSessionViews().length === 1);
      expect(bridge.getSessionView("empty-thread")).toMatchObject({
        session: {
          id: "empty-thread",
          messageCount: 0,
          ownership: { owner: "external" },
        },
        activity: "in-turn",
      });
      expect(
        emittedEvents.some(
          (event) =>
            (event as { type?: string; session?: { id?: string } }).type ===
              "session-created" &&
            (event as { session?: { id?: string } }).session?.id ===
              "empty-thread",
        ),
      ).toBe(true);
    } finally {
      client.close();
    }
  });

  it("records approval requests and answers them from Yep", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-b" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-b",
            thread: {
              id: "thread-b",
              preview: "Needs approval",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-b",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      const forwardedApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-b",
            turnId: "turn-1",
            itemId: "item-1",
            startedAtMs: Date.now(),
            command: "ls -la",
            cwd: "/tmp/project-b",
            reason: "Need to inspect files",
          },
        }),
      );

      expect(await forwardedApproval).toMatchObject({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
      });
      const pending = bridge.getPendingInputRequest("thread-b");
      expect(pending).toMatchObject({
        sessionId: "thread-b",
        type: "tool-approval",
        toolName: "Bash",
      });
      expect(bridge.listSessions()[0]?.pendingInputType).toBe("tool-approval");

      const beforeResponseCount = upstreamMessages.length;
      const accepted = bridge.respondToInput(
        "thread-b",
        pending?.id ?? "",
        "approve",
      );
      expect(accepted).toBe(true);
      await waitFor(() => upstreamMessages.length === beforeResponseCount + 1);
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-1",
        result: { decision: "accept" },
      });
      expect(bridge.getPendingInputRequest("thread-b")).toBeNull();

      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          result: { decision: "accept" },
        }),
      );
      await delay(100);
      expect(upstreamMessages.length).toBe(beforeResponseCount + 1);
      expect(
        emittedEvents.some(
          (event) =>
            (event as { type?: string; activity?: string }).type ===
              "process-state-changed" &&
            (event as { activity?: string }).activity === "waiting-input",
        ),
      ).toBe(true);
    } finally {
      client.close();
    }
  });

  it("serves sidecar HTTP control API", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-http" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-http",
            thread: {
              id: "thread-http",
              preview: "HTTP control",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-http",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      const forwardedApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-http",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-http",
            turnId: "turn-1",
            itemId: "item-1",
            startedAtMs: Date.now(),
            command: "pwd",
            cwd: "/tmp/project-http",
          },
        }),
      );
      expect(await forwardedApproval).toMatchObject({
        id: "approval-http",
        method: "item/commandExecution/requestApproval",
      });

      const baseUrl = `http://127.0.0.1:${bridgePort}`;
      const sessions = await fetchJson<{ sessions: unknown[] }>(
        `${baseUrl}/sessions`,
      );
      expect(sessions.sessions).toHaveLength(1);

      const sessionViews = await fetchJson<{ sessions: unknown[] }>(
        `${baseUrl}/session-views`,
      );
      expect(sessionViews.sessions).toHaveLength(1);

      const pending = await fetchJson<{
        request: { id: string; sessionId: string; toolName: string } | null;
      }>(`${baseUrl}/sessions/thread-http/pending-input`);
      expect(pending.request).toMatchObject({
        sessionId: "thread-http",
        toolName: "Bash",
      });

      const beforeResponseCount = upstreamMessages.length;
      const response = await fetchJson<{ accepted: boolean }>(
        `${baseUrl}/sessions/thread-http/input`,
        {
          method: "POST",
          body: JSON.stringify({
            requestId: pending.request?.id,
            response: "approve",
          }),
        },
      );
      expect(response.accepted).toBe(true);
      await waitFor(() => upstreamMessages.length === beforeResponseCount + 1);
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-http",
        result: { decision: "accept" },
      });
    } finally {
      client.close();
    }
  });

  it("surfaces queued command approvals and accepts Codex policy amendments", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-c" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-c",
            thread: {
              id: "thread-c",
              preview: "Queued approvals",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-c",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      const forwardedFirstApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-c",
            turnId: "turn-1",
            itemId: "item-1",
            startedAtMs: Date.now(),
            command: "mdfind -name 'cuijie'",
            cwd: "/tmp/project-c",
            availableDecisions: [
              "accept",
              {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: ["mdfind", "-name", "cuijie"],
                },
              },
              "cancel",
            ],
            proposedExecpolicyAmendment: ["mdfind", "-name", "cuijie"],
          },
        }),
      );
      expect(await forwardedFirstApproval).toMatchObject({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
      });

      const forwardedSecondApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-2",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-c",
            turnId: "turn-1",
            itemId: "item-2",
            startedAtMs: Date.now(),
            command: "find / -iname '*cuijie*' -print",
            cwd: "/tmp/project-c",
          },
        }),
      );
      expect(await forwardedSecondApproval).toMatchObject({
        id: "approval-2",
        method: "item/commandExecution/requestApproval",
      });

      const firstPending = bridge.getPendingInputRequest("thread-c");
      expect(firstPending?.toolInput).toMatchObject({
        command: "mdfind -name 'cuijie'",
      });

      const beforePersistentResponseCount = upstreamMessages.length;
      const acceptedPersistent = bridge.respondToInput(
        "thread-c",
        firstPending?.id ?? "",
        "approve_accept_edits",
      );
      expect(acceptedPersistent).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforePersistentResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-1",
        result: {
          decision: {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["mdfind", "-name", "cuijie"],
            },
          },
        },
      });

      const secondPending = bridge.getPendingInputRequest("thread-c");
      expect(secondPending?.toolInput).toMatchObject({
        command: "find / -iname '*cuijie*' -print",
      });

      const beforeSecondResponseCount = upstreamMessages.length;
      const acceptedSecond = bridge.respondToInput(
        "thread-c",
        secondPending?.id ?? "",
        "approve",
      );
      expect(acceptedSecond).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforeSecondResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-2",
        result: { decision: "accept" },
      });
      expect(bridge.getPendingInputRequest("thread-c")).toBeNull();
    } finally {
      client.close();
    }
  });
});

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No port assigned"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function waitForJson(ws: WebSocket): Promise<JsonRpcMessage> {
  return (await waitForJsonFrame(ws)).message;
}

async function waitForJsonFrame(
  ws: WebSocket,
): Promise<{ message: JsonRpcMessage; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 5000);
    const handler = (data: WebSocket.RawData, isBinary: boolean) => {
      clearTimeout(timer);
      ws.off("message", handler);
      resolve({
        message: JSON.parse(data.toString()) as JsonRpcMessage,
        isBinary,
      });
    };
    ws.on("message", handler);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
