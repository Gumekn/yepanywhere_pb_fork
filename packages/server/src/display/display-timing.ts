/**
 * Phase timing for session display reads.
 *
 * A cold display entry is shared: the first HTTP or WS request starts the
 * initialization and later callers wait on it. Only the request that starts
 * the initialization receives the phase breakdown; waiters record `wait`.
 * Names are fixed tokens and values are durations only, so diagnostics never
 * carry paths, session IDs, or transcript content.
 */
export const SESSION_DISPLAY_TIMING_NAMES = [
  /** Waiting for an initialization started by another request. */
  "wait",
  /** Runtime process lookup and live subscription before the history read. */
  "attach",
  /** Project/provider/session resolution and runtime state. */
  "resolve",
  /** Within `resolve`: project snapshot lookup. */
  "project",
  /** Within `resolve`: runtime process, bridge and pending-input state. */
  "runtimeState",
  /** Within `resolve`: session summary lookup across provider sources. */
  "summary",
  /** Source revision stamp (file stats or summary). */
  "stamp",
  /** Provider history read and normalization. */
  "read",
  /** Display reducer restore, overlay and snapshot construction. */
  "reduce",
  /** Runtime journal replay used to recover provider-specific history. */
  "replay",
  "total",
] as const;

export type SessionDisplayTimingName =
  (typeof SESSION_DISPLAY_TIMING_NAMES)[number];

export interface SessionDisplayTimingSink {
  add(name: SessionDisplayTimingName, durationMs: number): void;
}

/** How the request was served from the display entry cache. */
export type SessionDisplayCacheState = "hit" | "miss" | "wait";

export async function timed<T>(
  timing: SessionDisplayTimingSink | undefined,
  name: SessionDisplayTimingName,
  operation: () => Promise<T>,
): Promise<T> {
  if (!timing) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timing.add(name, performance.now() - startedAt);
  }
}

/** Accumulates phases for one cold initialization, for the slow-read log. */
export class SessionDisplayPhaseTotals implements SessionDisplayTimingSink {
  readonly durations: Partial<Record<SessionDisplayTimingName, number>> = {};

  constructor(private readonly forward?: SessionDisplayTimingSink) {}

  add(name: SessionDisplayTimingName, durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const value = Math.max(0, durationMs);
    this.durations[name] = (this.durations[name] ?? 0) + value;
    this.forward?.add(name, value);
  }

  rounded(): Partial<Record<SessionDisplayTimingName, number>> {
    return Object.fromEntries(
      Object.entries(this.durations).map(([name, value]) => [
        name,
        Math.round(value * 10) / 10,
      ]),
    );
  }
}
