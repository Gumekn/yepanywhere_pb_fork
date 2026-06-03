/**
 * TerminalService — manages server-owned PTY (pseudo-terminal) sessions.
 *
 * Design goals (POC v1):
 * - Server-owned PTYs: client disconnect does NOT kill the shell. Reattach
 *   from any client resumes the session.
 * - One PTY per `terminalId`. Multiple WebSocket clients can attach to the
 *   same terminal; all attached clients see the same output stream.
 * - Bounded scrollback: when a new client attaches to an existing terminal,
 *   it gets the last N KB of output as catch-up.
 * - Idle GC: when the last client detaches, the PTY is killed after
 *   IDLE_TIMEOUT_MS to avoid orphaned processes.
 *
 * Wire format: messages are JSON inside the existing encrypted envelope.
 * stdin/stdout bytes are base64-encoded (acceptable overhead for v1, can
 * upgrade to binary frames later if keystroke latency becomes an issue).
 */

import * as os from "node:os";
import * as path from "node:path";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@yep-anywhere/shared";
import * as pty from "node-pty";
import { getLogger } from "../logging/logger.js";

/** How long to keep a PTY alive after the last client detaches. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/** Scrollback ring buffer cap per terminal (bytes). */
const SCROLLBACK_MAX_BYTES = 256 * 1024;
/** Max number of concurrent terminals. */
const MAX_TERMINALS = 32;

type SendFn = (msg: TerminalServerMessage) => void;

interface AttachedClient {
  /** Unique id per attachment (NOT per terminal). */
  attachId: string;
  send: SendFn;
}

interface TerminalEntry {
  id: string;
  pty: pty.IPty;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  /** Live attachments. Keyed by attachId. */
  clients: Map<string, AttachedClient>;
  /** Ring of recent output chunks; total bytes <= SCROLLBACK_MAX_BYTES. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  idleTimer: NodeJS.Timeout | null;
  exited: boolean;
}

function resolveShell(requested?: string): string {
  if (requested && requested.trim().length > 0) return requested;
  if (process.env.SHELL) return process.env.SHELL;
  return os.platform() === "win32" ? "powershell.exe" : "/bin/bash";
}

function resolveCwd(requested?: string): string {
  const home = os.homedir();
  if (!requested) return home;
  try {
    const resolved = path.resolve(requested);
    return resolved;
  } catch {
    return home;
  }
}

export class TerminalService {
  private readonly log = getLogger();
  private readonly terminals = new Map<string, TerminalEntry>();

  /** All terminal ids currently alive on the server. */
  list(): { id: string; pid: number; cwd: string; clientCount: number }[] {
    return Array.from(this.terminals.values()).map((t) => ({
      id: t.id,
      pid: t.pty.pid,
      cwd: t.cwd,
      clientCount: t.clients.size,
    }));
  }

  /**
   * Handle a client→server terminal message. The `send` function is the
   * encryption-aware sender for the originating WebSocket connection. The
   * `attachId` should be unique per WebSocket (e.g., a per-connection UUID)
   * so the service can route per-client cleanup on disconnect.
   */
  async handleMessage(
    msg: TerminalClientMessage,
    attachId: string,
    send: SendFn,
  ): Promise<void> {
    switch (msg.type) {
      case "terminal_open":
        this.open(msg.terminalId, attachId, send, {
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          shell: msg.shell,
        });
        return;
      case "terminal_input":
        this.input(msg.terminalId, msg.data);
        return;
      case "terminal_resize":
        this.resize(msg.terminalId, msg.cols, msg.rows);
        return;
      case "terminal_close":
        this.close(msg.terminalId, attachId, msg.kill === true);
        return;
    }
  }

  /**
   * Drop all attachments for a given WS (by attachId). Called from the
   * connection close hook. Idle timer kicks in if no clients remain.
   */
  detachAll(attachId: string): void {
    for (const entry of this.terminals.values()) {
      if (entry.clients.delete(attachId)) {
        this.armIdleTimerIfEmpty(entry);
      }
    }
  }

  /** Kill all terminals (graceful shutdown). */
  shutdown(): void {
    for (const entry of this.terminals.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try {
        entry.pty.kill();
      } catch {
        // already dead
      }
    }
    this.terminals.clear();
  }

  // --------------------------------------------------------------------- //
  // internals
  // --------------------------------------------------------------------- //

  private open(
    terminalId: string,
    attachId: string,
    send: SendFn,
    opts: { cwd?: string; cols: number; rows: number; shell?: string },
  ): void {
    let entry = this.terminals.get(terminalId);
    let attached = false;

    if (entry) {
      attached = true;
    } else {
      if (this.terminals.size >= MAX_TERMINALS) {
        send({
          type: "terminal_error",
          terminalId,
          message: `Too many terminals (max ${MAX_TERMINALS})`,
        });
        return;
      }
      const spawned = this.spawn(terminalId, opts);
      if (!spawned) {
        send({
          type: "terminal_error",
          terminalId,
          message: "Failed to spawn shell",
        });
        return;
      }
      entry = spawned;
    }

    // Cancel any pending idle GC
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    entry.clients.set(attachId, { attachId, send });

    send({
      type: "terminal_opened",
      terminalId: entry.id,
      pid: entry.pty.pid,
      cwd: entry.cwd,
      attached,
    });

    // On reattach: ship the scrollback so the client can paint up-to-date.
    if (attached && entry.scrollbackBytes > 0) {
      const buf = Buffer.concat(entry.scrollback, entry.scrollbackBytes);
      send({
        type: "terminal_output",
        terminalId: entry.id,
        data: buf.toString("base64"),
      });
    }

    // Sync PTY size to the client viewport (fresh terminals already have
    // the right size; reattaches may have changed dimensions).
    if (opts.cols > 0 && opts.rows > 0) {
      this.resize(entry.id, opts.cols, opts.rows);
    }
  }

  private spawn(
    terminalId: string,
    opts: { cwd?: string; cols: number; rows: number; shell?: string },
  ): TerminalEntry | null {
    const shell = resolveShell(opts.shell);
    const cwd = resolveCwd(opts.cwd);
    const cols = Math.max(1, Math.min(opts.cols || 80, 1000));
    const rows = Math.max(1, Math.min(opts.rows || 24, 1000));

    let proc: pty.IPty;
    try {
      proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          YEP_ANYWHERE_TERMINAL: "1",
        } as Record<string, string>,
      });
    } catch (err) {
      this.log.warn(
        `[Terminal] spawn failed shell=${shell} cwd=${cwd} err=${err instanceof Error ? err.message : err}`,
      );
      return null;
    }

    const entry: TerminalEntry = {
      id: terminalId,
      pty: proc,
      cwd,
      shell,
      cols,
      rows,
      clients: new Map(),
      scrollback: [],
      scrollbackBytes: 0,
      idleTimer: null,
      exited: false,
    };
    this.terminals.set(terminalId, entry);

    proc.onData((data) => this.onPtyData(entry, data));
    proc.onExit(({ exitCode, signal }) =>
      this.onPtyExit(entry, exitCode, signal),
    );

    this.log.debug(
      `[Terminal] spawned id=${terminalId} pid=${proc.pid} shell=${shell} cwd=${cwd} ${cols}x${rows}`,
    );
    return entry;
  }

  private onPtyData(entry: TerminalEntry, data: string): void {
    // node-pty types `data` as string but it really is utf-8 bytes; we
    // encode to base64 via Buffer to avoid corrupting non-UTF8 sequences.
    const buf = Buffer.from(data, "utf8");

    // Update scrollback ring (drop oldest until under cap)
    entry.scrollback.push(buf);
    entry.scrollbackBytes += buf.length;
    while (
      entry.scrollbackBytes > SCROLLBACK_MAX_BYTES &&
      entry.scrollback.length > 0
    ) {
      const dropped = entry.scrollback.shift();
      if (dropped) entry.scrollbackBytes -= dropped.length;
    }

    if (entry.clients.size === 0) return;

    const payload = buf.toString("base64");
    for (const client of entry.clients.values()) {
      client.send({
        type: "terminal_output",
        terminalId: entry.id,
        data: payload,
      });
    }
  }

  private onPtyExit(
    entry: TerminalEntry,
    exitCode: number,
    signal: number | undefined,
  ): void {
    entry.exited = true;
    this.log.debug(
      `[Terminal] exited id=${entry.id} pid=${entry.pty.pid} code=${exitCode} signal=${signal ?? "-"}`,
    );
    for (const client of entry.clients.values()) {
      client.send({
        type: "terminal_exit",
        terminalId: entry.id,
        exitCode,
        signal,
      });
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.terminals.delete(entry.id);
  }

  private input(terminalId: string, b64: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry || entry.exited) return;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      return;
    }
    try {
      entry.pty.write(buf.toString("utf8"));
    } catch (err) {
      this.log.debug(
        `[Terminal] write failed id=${terminalId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.terminals.get(terminalId);
    if (!entry || entry.exited) return;
    const c = Math.max(1, Math.min(cols || entry.cols, 1000));
    const r = Math.max(1, Math.min(rows || entry.rows, 1000));
    if (c === entry.cols && r === entry.rows) return;
    entry.cols = c;
    entry.rows = r;
    try {
      entry.pty.resize(c, r);
    } catch (err) {
      this.log.debug(
        `[Terminal] resize failed id=${terminalId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private close(terminalId: string, attachId: string, kill: boolean): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    entry.clients.delete(attachId);
    if (kill) {
      try {
        entry.pty.kill();
      } catch {
        // already dead
      }
      // onExit handler will clean up the map
      return;
    }
    this.armIdleTimerIfEmpty(entry);
  }

  private armIdleTimerIfEmpty(entry: TerminalEntry): void {
    if (entry.clients.size > 0 || entry.exited) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.clients.size === 0 && !entry.exited) {
        this.log.debug(
          `[Terminal] idle GC id=${entry.id} pid=${entry.pty.pid}`,
        );
        try {
          entry.pty.kill();
        } catch {
          // already dead
        }
      }
    }, IDLE_TIMEOUT_MS);
  }
}
