/**
 * Warm Cursor ACP processes so sending a message does not pay for
 * authenticate + newSession on the critical path.
 *
 * One process is bound to one model (`--model` is a startup flag) and, after
 * newSession, to one chat. Resume reuses an already authenticated idle process
 * and still has to loadSession.
 */

import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { PermissionMode } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { canonicalizeProjectPath } from "../../projects/paths.js";
import { CURSOR_ACP_SESSIONS_DIR } from "../../sessions/cursor-reader.js";
import { ACPClient } from "./acp/client.js";
import { findCursorAgentPath } from "./cursor-cli.js";

const log = getLogger();
const PREPARE_TTL_MS = 10 * 60 * 1000;
const MAX_IDLE_CLIENTS = 2;

interface PreparedCursorSession {
  client: ACPClient;
  sessionId: string;
  permissionMode: PermissionMode | undefined;
}

interface PrepareSlot {
  promise: Promise<PreparedCursorSession>;
  at: number;
}

interface IdleClient {
  promise: Promise<ACPClient>;
  at: number;
}

export interface CursorPrepareClaim {
  client: ACPClient;
  /** Set when newSession already ran. Resume claims omit it. */
  sessionId?: string;
}

const slots = new Map<string, PrepareSlot>();
const idleClients = new Map<string, IdleClient>();

function toCursorMode(mode: PermissionMode | undefined): "agent" | "plan" {
  return mode === "plan" ? "plan" : "agent";
}

function prepareKey(cwd: string, model: string | undefined): string {
  return `${canonicalizeProjectPath(cwd)}\0${model ?? ""}`;
}

function modelKey(model: string | undefined): string {
  return model ?? "";
}

async function connectAuthenticated(
  model: string | undefined,
  cwd?: string,
): Promise<ACPClient> {
  const agentPath = await findCursorAgentPath();
  if (!agentPath) {
    throw new Error(
      "Cursor CLI not found. Install it from https://cursor.com/docs/cli/overview and run `agent login`.",
    );
  }
  const client = new ACPClient();
  try {
    const args = ["acp"];
    if (model) args.unshift("--model", model);
    await client.connect({
      command: agentPath,
      args,
      cwd: cwd ?? homedir(),
    });
    await client.initialize({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { subagents: {} },
    });
    await client.authenticate("cursor_login");
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

async function createPrepared(input: {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
}): Promise<PreparedCursorSession> {
  const cwd = canonicalizeProjectPath(input.cwd);
  const client = await connectAuthenticated(input.model, cwd);
  let sessionId: string | null = null;
  try {
    sessionId = await client.newSession(cwd);
    await client.setSessionMode(sessionId, toCursorMode(input.permissionMode));
    return {
      client,
      sessionId,
      permissionMode: input.permissionMode,
    };
  } catch (error) {
    client.close();
    if (sessionId) await deleteUnpromptedCursorSession(sessionId);
    throw error;
  }
}

async function applyMode(
  prepared: PreparedCursorSession,
  permissionMode: PermissionMode | undefined,
): Promise<void> {
  if (prepared.permissionMode === permissionMode) return;
  await prepared.client.setSessionMode(
    prepared.sessionId,
    toCursorMode(permissionMode),
  );
  prepared.permissionMode = permissionMode;
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, slot] of slots) {
    if (now - slot.at < PREPARE_TTL_MS) continue;
    slots.delete(id);
    void slot.promise
      .then(async (prepared) => {
        prepared.client.close();
        await deleteUnpromptedCursorSession(prepared.sessionId);
      })
      .catch(() => undefined);
  }
  for (const [key, idle] of idleClients) {
    if (now - idle.at < PREPARE_TTL_MS) continue;
    idleClients.delete(key);
    void idle.promise.then((client) => client.close()).catch(() => undefined);
  }
}

function evictOldestIdle(): void {
  let oldestKey: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, idle] of idleClients) {
    if (idle.at < oldestAt) {
      oldestAt = idle.at;
      oldestKey = key;
    }
  }
  if (!oldestKey) return;
  const idle = idleClients.get(oldestKey);
  idleClients.delete(oldestKey);
  void idle?.promise.then((client) => client.close()).catch(() => undefined);
}

export async function prepareCursorSession(input: {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
}): Promise<void> {
  sweepExpired();
  const id = prepareKey(input.cwd, input.model);
  const existing = slots.get(id);
  if (existing) {
    await existing.promise.then((prepared) =>
      applyMode(prepared, input.permissionMode),
    );
    return;
  }
  const promise = createPrepared(input);
  slots.set(id, { promise, at: Date.now() });
  try {
    await promise;
  } catch (error) {
    if (slots.get(id)?.promise === promise) slots.delete(id);
    throw error;
  }
}

export async function discardCursorPrepare(input: {
  cwd: string;
  model?: string;
}): Promise<void> {
  const slot = slots.get(prepareKey(input.cwd, input.model));
  if (!slot) return;
  slots.delete(prepareKey(input.cwd, input.model));
  try {
    const prepared = await slot.promise;
    prepared.client.close();
    await deleteUnpromptedCursorSession(prepared.sessionId);
  } catch (error) {
    log.warn({ err: error }, "Cursor prepare discard failed");
  }
}

export function warmCursorAuth(model?: string): Promise<void> {
  sweepExpired();
  const key = modelKey(model);
  const existing = idleClients.get(key);
  if (existing) return existing.promise.then(() => undefined);
  while (idleClients.size >= MAX_IDLE_CLIENTS) evictOldestIdle();
  const promise = connectAuthenticated(model);
  idleClients.set(key, { promise, at: Date.now() });
  void promise.catch(() => {
    if (idleClients.get(key)?.promise === promise) idleClients.delete(key);
  });
  return promise.then(() => undefined);
}

export async function claimCursorPrepare(input: {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
}): Promise<CursorPrepareClaim | null> {
  if (input.resumeSessionId) {
    const key = modelKey(input.model);
    const idle = idleClients.get(key);
    if (!idle) return null;
    idleClients.delete(key);
    try {
      const client = await idle.promise;
      void warmCursorAuth(input.model).catch((error) => {
        log.warn({ err: error }, "Cursor auth warm failed");
      });
      return { client };
    } catch (error) {
      log.warn({ err: error }, "Cursor resume warm claim failed");
      return null;
    }
  }

  const id = prepareKey(input.cwd, input.model);
  const slot = slots.get(id);
  if (!slot) return null;
  slots.delete(id);
  try {
    const prepared = await slot.promise;
    await applyMode(prepared, input.permissionMode);
    void warmCursorAuth(input.model).catch((error) => {
      log.warn({ err: error }, "Cursor auth warm failed");
    });
    return { client: prepared.client, sessionId: prepared.sessionId };
  } catch (error) {
    log.warn({ err: error }, "Cursor prepare claim failed");
    await slot.promise
      .then((prepared) => prepared.client.close())
      .catch(() => undefined);
    return null;
  }
}

/**
 * Drop a prepared chat that never received a prompt. A store.db means the CLI
 * already persisted a real session, so leave it alone.
 */
export async function deleteUnpromptedCursorSession(
  sessionId: string,
): Promise<void> {
  const root = resolve(CURSOR_ACP_SESSIONS_DIR);
  const dir = resolve(root, sessionId);
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) return;
  for (const name of ["store.db", "store.db-wal"]) {
    try {
      await stat(join(dir, name));
      return;
    } catch {
      // Not persisted yet.
    }
  }
  try {
    await stat(join(dir, "meta.json"));
  } catch {
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

export async function resetCursorPrepareStateForTests(): Promise<void> {
  const pending = [...slots.values()];
  const idle = [...idleClients.values()];
  slots.clear();
  idleClients.clear();
  await Promise.all([
    ...pending.map(async (slot) => {
      try {
        (await slot.promise).client.close();
      } catch {
        // Failed prepares have nothing to close.
      }
    }),
    ...idle.map(async (entry) => {
      try {
        (await entry.promise).close();
      } catch {
        // Failed warms have nothing to close.
      }
    }),
  ]);
}
