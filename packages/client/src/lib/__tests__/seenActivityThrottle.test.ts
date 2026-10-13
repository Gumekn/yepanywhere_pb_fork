import { afterEach, describe, expect, it, vi } from "vitest";
import { SeenActivityThrottle } from "../seenActivityThrottle";

describe("SeenActivityThrottle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the first event immediately and the rest of the burst within one second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
    const seen: string[] = [];
    const clock = new SeenActivityThrottle((iso) => {
      seen.push(iso);
    });

    clock.note("2026-10-12T08:00:00.000Z");
    vi.advanceTimersByTime(50);
    clock.note("2026-10-12T08:00:00.050Z");
    vi.advanceTimersByTime(400);
    clock.note("2026-10-12T08:00:00.450Z");
    expect(seen).toEqual(["2026-10-12T08:00:00.000Z"]);

    vi.advanceTimersByTime(550);
    expect(seen).toEqual([
      "2026-10-12T08:00:00.000Z",
      "2026-10-12T08:00:01.000Z",
    ]);

    clock.note("2026-10-12T08:00:01.100Z");
    vi.advanceTimersByTime(900);
    expect(seen).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(seen[2]).toBe("2026-10-12T08:00:02.000Z");
  });

  it("publishes the next session's first event immediately after reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
    const seen: string[] = [];
    const clock = new SeenActivityThrottle((iso) => {
      seen.push(iso);
    });
    clock.note("2026-10-12T08:00:00.000Z");
    vi.advanceTimersByTime(20);
    clock.note("2026-10-12T08:00:00.020Z");
    clock.reset();
    clock.note("2026-10-12T08:00:00.020Z");
    expect(seen).toEqual([
      "2026-10-12T08:00:00.000Z",
      "2026-10-12T08:00:00.020Z",
    ]);
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(2);
  });
});
