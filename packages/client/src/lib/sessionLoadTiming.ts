/**
 * Client-side timing for opening one session view.
 *
 * One trace starts when the projected session hook begins loading a
 * session/branch and ends once a fresh snapshot (HTTP or WS) is visible and
 * the HTTP display read has settled, or after a cap. It emits a single
 * `[SessionLoad]` console line, which Developer Mode remote logging collects.
 * The line only carries durations, cache/transport states and fixed
 * Server-Timing tokens — no transcript content.
 */

export type SessionLoadSource = "http" | "ws" | "ws-current";

export interface SessionLoadReport {
  /** Time since page navigation when the trace began (cold app start signal). */
  appUptimeMs: number;
  /** A cached snapshot was shown immediately. */
  cached: boolean;
  /** Connection manager state at trace start. */
  transport: string;
  /** Until the first fresh snapshot was installed. */
  freshMs?: number;
  freshSource?: SessionLoadSource;
  /** HTTP display/view round trip as seen by the client. */
  viewMs?: number;
  viewStatus?: number;
  viewServerTiming?: string;
  /** The HTTP read was not needed: WS delivered the projection first. */
  viewSkipped?: boolean;
  metadataMs?: number;
  /** Trace ended by the cap rather than by both signals arriving. */
  timedOut?: boolean;
}

interface Trace {
  key: string;
  startedAt: number;
  report: SessionLoadReport;
  viewSettled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface SessionLoadTracerOptions {
  now?: () => number;
  log?: (line: string, report: SessionLoadReport) => void;
  capMs?: number;
}

const DEFAULT_CAP_MS = 30_000;
/** Only fixed metric tokens and numeric values survive into the report. */
const SERVER_TIMING_ENTRY =
  /^\s*([A-Za-z][A-Za-z0-9_-]*)(?:;dur=([0-9.]+))?(?:;desc=([A-Za-z-]+))?\s*$/;

export function compactServerTiming(
  header: string | null | undefined,
): string | undefined {
  if (!header) return undefined;
  const parts = header.split(",").flatMap((entry) => {
    const match = SERVER_TIMING_ENTRY.exec(entry);
    if (!match) return [];
    const [, name, dur, desc] = match;
    if (desc) return [`${name}=${desc}`];
    if (dur === undefined) return [];
    const value = Number(dur);
    // Zero phases are noise in a one-line report.
    return value > 0 ? [`${name}=${Math.round(value)}`] : [];
  });
  return parts.length ? parts.join(" ") : undefined;
}

export class SessionLoadTracer {
  private trace: Trace | null = null;
  private readonly now: () => number;
  private readonly log: (line: string, report: SessionLoadReport) => void;
  private readonly capMs: number;

  constructor(options: SessionLoadTracerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.log =
      options.log ??
      ((line, report) => console.log(line, JSON.stringify(report)));
    this.capMs = options.capMs ?? DEFAULT_CAP_MS;
  }

  begin(key: string, state: { cached: boolean; transport: string }): void {
    this.abandon();
    const startedAt = this.now();
    const trace: Trace = {
      key,
      startedAt,
      viewSettled: false,
      report: {
        appUptimeMs: Math.round(startedAt),
        cached: state.cached,
        transport: state.transport,
      },
    };
    trace.timer = setTimeout(() => {
      if (this.trace !== trace) return;
      trace.report.timedOut = true;
      this.finish(trace);
    }, this.capMs);
    this.trace = trace;
  }

  /** The view was left before the trace completed; nothing is reported. */
  abandon(key?: string): void {
    const trace = this.trace;
    if (!trace || (key !== undefined && trace.key !== key)) return;
    clearTimeout(trace.timer);
    this.trace = null;
  }

  fresh(key: string, source: SessionLoadSource): void {
    const trace = this.current(key);
    if (!trace || trace.report.freshMs !== undefined) return;
    trace.report.freshMs = this.elapsed(trace);
    trace.report.freshSource = source;
    this.maybeFinish(trace);
  }

  view(
    key: string,
    result: {
      status?: number;
      serverTiming?: string | null;
      skipped?: boolean;
    },
  ): void {
    const trace = this.current(key);
    if (!trace || trace.viewSettled) return;
    trace.viewSettled = true;
    if (result.skipped) {
      trace.report.viewSkipped = true;
      this.maybeFinish(trace);
      return;
    }
    trace.report.viewMs = this.elapsed(trace);
    if (result.status !== undefined) trace.report.viewStatus = result.status;
    const timing = compactServerTiming(result.serverTiming);
    if (timing) trace.report.viewServerTiming = timing;
    this.maybeFinish(trace);
  }

  metadata(key: string): void {
    const trace = this.current(key);
    if (!trace || trace.report.metadataMs !== undefined) return;
    trace.report.metadataMs = this.elapsed(trace);
  }

  private current(key: string): Trace | null {
    return this.trace?.key === key ? this.trace : null;
  }

  private elapsed(trace: Trace): number {
    return Math.round(this.now() - trace.startedAt);
  }

  private maybeFinish(trace: Trace): void {
    if (trace.report.freshMs !== undefined && trace.viewSettled)
      this.finish(trace);
  }

  private finish(trace: Trace): void {
    clearTimeout(trace.timer);
    if (this.trace === trace) this.trace = null;
    this.log("[SessionLoad]", trace.report);
  }
}

export const sessionLoadTracer = new SessionLoadTracer();
