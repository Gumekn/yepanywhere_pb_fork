import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../../src/utils/async-queue.js";

describe("AsyncQueue", () => {
  it("returns a buffered item without waiting", async () => {
    const queue = new AsyncQueue<string>();
    queue.push("a");
    queue.push("b");
    await expect(queue.shift()).resolves.toBe("a");
    expect(queue.drain()).toEqual(["b"]);
    expect(queue.drain()).toEqual([]);
  });

  it("resolves a waiting shift when an item arrives", async () => {
    const queue = new AsyncQueue<number>();
    const pending = queue.shift();
    queue.push(7);
    await expect(pending).resolves.toBe(7);
  });

  it("rejects waiters on close, drops buffered items, and ignores later pushes", async () => {
    const waiting = new AsyncQueue<string>();
    const pending = waiting.shift();
    const error = new Error("transport closed");
    waiting.close(error);
    waiting.close(new Error("second close"));
    waiting.push("after");
    await expect(pending).rejects.toBe(error);
    await expect(waiting.shift()).rejects.toBe(error);

    const buffered = new AsyncQueue<string>();
    buffered.push("stale");
    buffered.close(error);
    buffered.push("after");
    expect(buffered.drain()).toEqual([]);
  });

  it("rejects only the aborted shift and leaves the queue usable", async () => {
    const queue = new AsyncQueue<string>();
    const controller = new AbortController();
    const pending = queue.shift(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Operation aborted");

    queue.push("next");
    await expect(queue.shift()).resolves.toBe("next");
  });
});
