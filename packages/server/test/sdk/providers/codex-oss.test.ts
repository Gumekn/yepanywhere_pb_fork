import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDisplayReducer } from "../../../src/display/SessionDisplayReducer.js";
import { CodexOSSProvider } from "../../../src/sdk/providers/codex-oss.js";
import type { AgentSession } from "../../../src/sdk/providers/types.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

// Only the process boundary is simulated. Real readline, provider conversion
// and the display reducer consume the CLI's JSONL events.
function cliTurn(events: unknown[], exitCode: number | null): ChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    kill: vi.fn(() => true),
  });
  setImmediate(() => {
    stdout.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    stderr.end();
    setImmediate(() => child.emit("close", exitCode));
  });
  return child as unknown as ChildProcess;
}

const started = { type: "thread.started", thread_id: "session" };
const failed = { type: "turn.failed", error: { message: "Backend failed" } };
const completed = {
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function runTurns(
  turns: { events: unknown[]; exitCode: number | null }[],
  onMessage?: (message: SDKMessage, session: AgentSession) => Promise<void>,
) {
  for (const turn of turns) {
    vi.mocked(spawn).mockImplementationOnce(() =>
      cliTurn(turn.events, turn.exitCode),
    );
  }
  const provider = new CodexOSSProvider({ codexPath: process.execPath });
  const session = await provider.startSession({
    cwd: process.cwd(),
    initialMessage: { text: "first" },
  });
  for (let i = 1; i < turns.length; i++)
    session.queue.push({ text: `turn ${i + 1}` });
  const display = new SessionDisplayReducer(
    { sessionId: "session", branchScopeId: "active", epoch: "test" },
    "codex-oss",
  );
  const results: SDKMessage[] = [];
  const states: string[] = [];
  try {
    for await (const message of session.iterator) {
      display.message(message);
      await onMessage?.(message, session);
      if (message.type === "result") {
        results.push(message);
        states.push(display.snapshot().activity.state);
        if (results.length === turns.length) session.queue.close();
      }
    }
  } finally {
    session.queue.close();
    session.abort();
  }
  return { results, states };
}

afterEach(() => vi.clearAllMocks());

describe("CodexOSS turn completion", () => {
  it.each([
    {
      name: "turn.failed even with exit zero",
      events: [started, failed],
      exitCode: 0,
    },
    {
      name: "terminal error",
      events: [started, { type: "error", message: "Transport failed" }],
      exitCode: 0,
    },
    {
      name: "nonzero exit without a failure event",
      events: [started],
      exitCode: 1,
    },
    {
      name: "signal exit without a failure event",
      events: [started],
      exitCode: null,
    },
  ])("preserves failure for $name", async ({ events, exitCode }) => {
    const { results, states } = await runTurns([{ events, exitCode }]);
    expect(results).toMatchObject([
      {
        type: "result",
        session_id: "session",
        turnStatus: "failed",
        is_error: true,
      },
    ]);
    expect(states).toEqual(["failed"]);
  });

  it("resets failure state for a later successful turn", async () => {
    const { results, states } = await runTurns([
      { events: [started, failed], exitCode: 1 },
      { events: [completed], exitCode: 0 },
    ]);
    expect(results).toMatchObject([
      { turnStatus: "failed", is_error: true },
      { turnStatus: "completed", is_error: false },
    ]);
    expect(states).toEqual(["failed", "completed"]);
  });

  it("accepts an explicit completion after a recovered error", async () => {
    const { results, states } = await runTurns([
      {
        events: [started, { type: "error", message: "Retrying" }, completed],
        exitCode: 0,
      },
    ]);
    expect(results).toMatchObject([
      { turnStatus: "completed", is_error: false },
    ]);
    expect(states).toEqual(["completed"]);
  });

  it("reports a user abort as interrupted", async () => {
    const { results, states } = await runTurns(
      [{ events: [started], exitCode: null }],
      async (message, session) => {
        if (message.type === "system" && message.subtype === "init")
          session.abort();
      },
    );
    expect(results).toMatchObject([
      { turnStatus: "interrupted", is_error: false },
    ]);
    expect(states).toEqual(["interrupted"]);
  });

  it("still emits a failed result if the CLI closes while an error is being consumed", async () => {
    const { results, states } = await runTurns(
      [{ events: [started, failed], exitCode: 1 }],
      async (message) => {
        if (message.type === "error") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    );
    expect(results).toMatchObject([{ turnStatus: "failed", is_error: true }]);
    expect(states).toEqual(["failed"]);
  });
});
