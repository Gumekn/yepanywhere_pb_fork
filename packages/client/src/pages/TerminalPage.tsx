import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useRemoteTerminal } from "../hooks/useRemoteTerminal";
import { useNavigationLayout } from "../layouts";
import { generateUUID } from "../lib/uuid";

/**
 * TerminalPage — full-page xterm.js attached to a server-side PTY via the
 * useRemoteTerminal hook.
 *
 * URL shapes:
 *   /terminal                     — opens a fresh terminal (random id)
 *   /terminal/:terminalId         — attaches to a specific terminal id
 *
 * Optional query params:
 *   ?cwd=/abs/path                — initial working directory for fresh terminals
 */
export function TerminalPage() {
  const params = useParams<{ terminalId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  // Stable terminal id for the lifetime of this page mount. Either taken
  // from the URL (attach to existing) or freshly generated (new shell).
  const terminalId = useMemo(
    () => params.terminalId ?? generateUUID(),
    [params.terminalId],
  );
  const cwd = searchParams.get("cwd") ?? undefined;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [connectionInfo, setConnectionInfo] = useState<{
    pid?: number;
    cwd?: string;
    exitCode?: number;
  }>({});

  // Forward declare hook handles so xterm imperative listeners always see
  // the latest closure (sendInput identity changes when terminalId settles).
  const sendInputRef = useRef<(s: string) => void>(() => {});
  const sendResizeRef = useRef<(c: number, r: number) => void>(() => {});

  const result = useRemoteTerminal({
    terminalId,
    cwd,
    cols: 80,
    rows: 24,
    onOpened: (info) =>
      setConnectionInfo((prev) => ({
        ...prev,
        pid: info.pid,
        cwd: info.cwd,
      })),
    onExit: ({ exitCode }) =>
      setConnectionInfo((prev) => ({ ...prev, exitCode })),
    onOutput: (bytes) => {
      termRef.current?.write(bytes);
    },
  });

  useEffect(() => {
    sendInputRef.current = result.sendInput;
    sendResizeRef.current = result.sendResize;
  }, [result.sendInput, result.sendResize]);

  // Mount xterm + addons exactly once
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#0b0b0b",
        foreground: "#e6e6e6",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    requestAnimationFrame(() => {
      try {
        fit.fit();
        sendResizeRef.current(term.cols, term.rows);
      } catch {
        // container may be unmounted
      }
      term.focus();
    });

    const dataDisposable = term.onData((data) => sendInputRef.current(data));

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResizeRef.current(term.cols, term.rows);
      } catch {
        // ignore intermittent layout glitches
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const stateColor =
    result.state === "connected"
      ? "#34c759"
      : result.state === "connecting"
        ? "#ffcc00"
        : result.state === "error" || result.state === "exited"
          ? "#ff453a"
          : "#888";

  const subtitle =
    connectionInfo.pid !== undefined
      ? `pid ${connectionInfo.pid}${connectionInfo.cwd ? ` · ${connectionInfo.cwd}` : ""}`
      : null;

  return (
    <div className="main-content-wrapper">
      <div
        className="main-content-constrained"
        style={{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        <PageHeader
          title="Terminal"
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 12px",
            fontSize: 12,
            color: "#aaa",
            borderBottom: "1px solid var(--border-color, #2a2a2a)",
          }}
        >
          <span
            aria-label="connection state"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: stateColor,
              display: "inline-block",
            }}
          />
          <span>{result.state}</span>
          {subtitle ? <span style={{ opacity: 0.7 }}>· {subtitle}</span> : null}
          {result.error ? (
            <span style={{ color: "#ff8a80" }}>· {result.error}</span>
          ) : null}
          <span style={{ flex: 1 }} />
          {result.state === "exited" ? (
            <button
              type="button"
              onClick={() => {
                // Navigating to /terminal forces a fresh id (no :terminalId).
                navigate("/terminal");
              }}
              style={{
                padding: "4px 10px",
                background: "#2a2a2a",
                color: "#eee",
                border: "1px solid #444",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              New terminal
            </button>
          ) : null}
        </div>
        <div
          ref={containerRef}
          style={{
            flex: 1,
            minHeight: 0,
            padding: 6,
            background: "#0b0b0b",
          }}
        />
      </div>
    </div>
  );
}
