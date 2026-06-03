/**
 * Shared types for the remote terminal feature.
 *
 * A terminal is a long-lived PTY (pseudo-terminal) on the server that a
 * client attaches to over the same authenticated WebSocket used by the rest
 * of the relay protocol. Stdin/stdout bytes are base64-encoded inside JSON
 * messages so they ride the existing encrypted JSON envelope without any
 * changes to the binary framing layer.
 *
 * Routing pattern mirrors `DeviceClientMessage` / `DeviceServerMessage`:
 * messages are added to the `RemoteClientMessage` / `YepMessage` unions and
 * dispatched by `ws-message-router.ts`.
 */

// ============================================================================
// Client → Server
// ============================================================================

/**
 * Client requests a new terminal session, or attaches to an existing one.
 * If `terminalId` matches an existing server-side PTY, the client attaches
 * to it (server-owned process semantics — survives client disconnect).
 * Otherwise the server spawns a new shell at `cwd`.
 */
export interface TerminalOpen {
  type: "terminal_open";
  /** Client-generated stable id (UUID). Used for attach/detach. */
  terminalId: string;
  /** Working directory for a fresh terminal. Ignored when attaching. */
  cwd?: string;
  /** Initial terminal size in cells. */
  cols: number;
  rows: number;
  /** Shell to launch (default: $SHELL or /bin/bash). Ignored on attach. */
  shell?: string;
}

/** Client sends keystrokes (utf-8 bytes, base64-encoded). */
export interface TerminalInput {
  type: "terminal_input";
  terminalId: string;
  /** base64-encoded raw bytes to write to the PTY */
  data: string;
}

/** Client signals a viewport resize. */
export interface TerminalResize {
  type: "terminal_resize";
  terminalId: string;
  cols: number;
  rows: number;
}

/**
 * Client closes the terminal. By default this only detaches (PTY keeps
 * running so the client can reattach). Set `kill: true` to terminate the
 * underlying shell process.
 */
export interface TerminalClose {
  type: "terminal_close";
  terminalId: string;
  kill?: boolean;
}

/** Union of all client→server terminal messages. */
export type TerminalClientMessage =
  | TerminalOpen
  | TerminalInput
  | TerminalResize
  | TerminalClose;

// ============================================================================
// Server → Client
// ============================================================================

/** Server confirms a terminal was opened or attached. */
export interface TerminalOpened {
  type: "terminal_opened";
  terminalId: string;
  /** OS pid of the shell process (useful for diagnostics). */
  pid: number;
  /** Working directory the shell launched in. */
  cwd: string;
  /** Whether the client attached to an existing PTY (vs spawning new). */
  attached: boolean;
}

/** Server pushes PTY output to client (base64-encoded). */
export interface TerminalOutput {
  type: "terminal_output";
  terminalId: string;
  /** base64-encoded raw bytes from the PTY */
  data: string;
}

/** Server reports the shell process exited. */
export interface TerminalExit {
  type: "terminal_exit";
  terminalId: string;
  exitCode: number;
  signal?: number;
}

/** Server reports an error opening/attaching/operating a terminal. */
export interface TerminalError {
  type: "terminal_error";
  terminalId: string;
  /** Short error message safe to surface in UI. */
  message: string;
}

/** Union of all server→client terminal messages. */
export type TerminalServerMessage =
  | TerminalOpened
  | TerminalOutput
  | TerminalExit
  | TerminalError;
