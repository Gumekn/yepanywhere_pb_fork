/**
 * useRemoteTerminal — connect to a server-side PTY over the existing WS
 * connection. Mirrors the shape of useEmulatorStream:
 * - Resolves a WS-capable Connection (the plain WebSocketConnection).
 * - Sends `terminal_open` on mount and `terminal_close` on unmount (close
 *   only detaches; the server keeps the PTY alive for reattach).
 * - Subscribes to terminal_* server messages, decodes base64 output, and
 *   surfaces them via onOutput callback.
 */

import type { TerminalServerMessage } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getWebSocketConnection } from "../lib/connection/WebSocketConnection";
import type { Connection } from "../lib/connection/types";

export type TerminalConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "exited"
  | "error";

export interface UseRemoteTerminalOptions {
  terminalId: string;
  cwd?: string;
  cols: number;
  rows: number;
  shell?: string;
  /** Auto-open on mount. Default true. */
  autoOpen?: boolean;
  /** Whether to detach (false) or kill the shell (true) on unmount. */
  killOnUnmount?: boolean;
  /** Called when output bytes arrive from the server. */
  onOutput: (bytes: Uint8Array) => void;
  /** Called once when the terminal is opened or attached. */
  onOpened?: (info: { pid: number; cwd: string; attached: boolean }) => void;
  /** Called when the shell process exits. */
  onExit?: (info: { exitCode: number; signal?: number }) => void;
}

export interface UseRemoteTerminalResult {
  state: TerminalConnectionState;
  error: string | null;
  /** Send keystrokes (already decoded UTF-8) to the server. */
  sendInput: (text: string) => void;
  /** Inform server of viewport size change. */
  sendResize: (cols: number, rows: number) => void;
  /** Re-open / re-attach if currently disconnected. */
  reopen: () => void;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  // Chunk to avoid `apply` arg-length limits on large payloads.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(bin);
}

/** Resolve a connection capable of sending RemoteClientMessage over WS. */
function getWsConnection(): Connection | null {
  // The concrete WebSocketConnection always provides sendMessage and
  // onTerminalMessage; we still return it through the Connection interface.
  return getWebSocketConnection();
}

const encoder = new TextEncoder();

export function useRemoteTerminal(
  opts: UseRemoteTerminalOptions,
): UseRemoteTerminalResult {
  const {
    terminalId,
    cwd,
    cols,
    rows,
    shell,
    autoOpen = true,
    killOnUnmount = false,
    onOutput,
    onOpened,
    onExit,
  } = opts;

  const [state, setState] = useState<TerminalConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Latest callbacks (avoid re-subscribing when consumers pass new fns).
  const cbRef = useRef({ onOutput, onOpened, onExit });
  useEffect(() => {
    cbRef.current = { onOutput, onOpened, onExit };
  }, [onOutput, onOpened, onExit]);

  const sendOpen = useCallback(() => {
    const conn = getWsConnection();
    if (!conn?.sendMessage) {
      setError("No WebSocket connection available");
      setState("error");
      return;
    }
    setState("connecting");
    setError(null);
    conn.sendMessage({
      type: "terminal_open",
      terminalId,
      cwd,
      cols,
      rows,
      shell,
    });
  }, [terminalId, cwd, cols, rows, shell]);

  // Subscribe to terminal_* messages for this terminalId. Consumer-provided
  // callbacks are stashed in cbRef so the subscription survives identity
  // changes in onOutput / onOpened / onExit between renders.
  useEffect(() => {
    const conn = getWsConnection();
    if (!conn?.onTerminalMessage) {
      setError("No WebSocket connection available");
      setState("error");
      return;
    }
    const unsub = conn.onTerminalMessage((msg: TerminalServerMessage) => {
      if (msg.terminalId !== terminalId) return;
      switch (msg.type) {
        case "terminal_opened":
          setState("connected");
          cbRef.current.onOpened?.({
            pid: msg.pid,
            cwd: msg.cwd,
            attached: msg.attached,
          });
          return;
        case "terminal_output": {
          let bytes: Uint8Array;
          try {
            bytes = base64ToBytes(msg.data);
          } catch {
            return;
          }
          cbRef.current.onOutput(bytes);
          return;
        }
        case "terminal_exit":
          setState("exited");
          cbRef.current.onExit?.({
            exitCode: msg.exitCode,
            signal: msg.signal,
          });
          return;
        case "terminal_error":
          setState("error");
          setError(msg.message);
          return;
      }
    });
    return unsub;
  }, [terminalId]);

  // Auto-open on mount; close on unmount. We deliberately mount-once with
  // the initial config — later resizes are handled via sendResize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only lifecycle
  useEffect(() => {
    if (autoOpen) sendOpen();
    return () => {
      const conn = getWsConnection();
      conn?.sendMessage?.({
        type: "terminal_close",
        terminalId,
        kill: killOnUnmount,
      });
    };
  }, []);

  const sendInput = useCallback(
    (text: string) => {
      const conn = getWsConnection();
      if (!conn?.sendMessage) return;
      conn.sendMessage({
        type: "terminal_input",
        terminalId,
        data: bytesToBase64(encoder.encode(text)),
      });
    },
    [terminalId],
  );

  const sendResize = useCallback(
    (newCols: number, newRows: number) => {
      const conn = getWsConnection();
      if (!conn?.sendMessage) return;
      conn.sendMessage({
        type: "terminal_resize",
        terminalId,
        cols: newCols,
        rows: newRows,
      });
    },
    [terminalId],
  );

  return { state, error, sendInput, sendResize, reopen: sendOpen };
}
