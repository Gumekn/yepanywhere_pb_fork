import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SessionLoadReport,
  SessionLoadTracer,
  compactServerTiming,
} from "../sessionLoadTiming";

function tracer() {
  let now = 1_000;
  const reports: SessionLoadReport[] = [];
  const instance = new SessionLoadTracer({
    now: () => now,
    log: (_line, report) => reports.push(report),
    capMs: 5_000,
  });
  return {
    instance,
    reports,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionLoadTracer", () => {
  it("reports once after a fresh snapshot and the HTTP view both settle", () => {
    const { instance, reports, advance } = tracer();
    instance.begin("a", { cached: false, transport: "connected" });
    advance(40);
    instance.metadata("a");
    advance(60);
    instance.fresh("a", "ws");
    expect(reports).toHaveLength(0);
    advance(20);
    instance.view("a", {
      status: 200,
      serverTiming:
        "read;dur=80.4, stamp;dur=0.0, total;dur=95.1, displayCache;desc=miss",
    });
    instance.fresh("a", "http");
    expect(reports).toEqual([
      {
        appUptimeMs: 1_000,
        cached: false,
        transport: "connected",
        metadataMs: 40,
        freshMs: 100,
        freshSource: "ws",
        viewMs: 120,
        viewStatus: 200,
        viewServerTiming: "read=80 total=95 displayCache=miss",
      },
    ]);
  });

  it("ignores signals for a different or abandoned session", () => {
    const { instance, reports } = tracer();
    instance.begin("a", { cached: true, transport: "connected" });
    instance.fresh("b", "http");
    instance.view("b", { status: 200 });
    instance.abandon("b");
    instance.begin("b", { cached: false, transport: "reconnecting" });
    instance.fresh("a", "http");
    instance.view("a", { status: 200 });
    expect(reports).toHaveLength(0);
    instance.abandon("b");
    instance.fresh("b", "http");
    instance.view("b", { status: 200 });
    expect(reports).toHaveLength(0);
  });

  it("reports a partial trace when the cap elapses", () => {
    vi.useFakeTimers();
    const { instance, reports } = tracer();
    instance.begin("a", { cached: true, transport: "connected" });
    instance.view("a", { status: 500 });
    vi.advanceTimersByTime(5_000);
    expect(reports).toEqual([
      expect.objectContaining({ timedOut: true, viewStatus: 500 }),
    ]);
    expect(reports[0]?.freshMs).toBeUndefined();
  });
});

describe("compactServerTiming", () => {
  it("keeps only well-formed tokens and drops zero phases", () => {
    expect(compactServerTiming(null)).toBeUndefined();
    expect(compactServerTiming("stamp;dur=0.0")).toBeUndefined();
    expect(
      compactServerTiming(
        'read;dur=12.6, bad entry, x;desc="/Users/secret", displayCache;desc=hit',
      ),
    ).toBe("read=13 displayCache=hit");
  });
});
