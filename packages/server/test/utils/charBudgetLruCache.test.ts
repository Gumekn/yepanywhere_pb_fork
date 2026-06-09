import { describe, expect, it, vi } from "vitest";
import {
  CharBudgetLruCache,
  memoizeAsyncByString,
} from "../../src/utils/charBudgetLruCache.js";

describe("CharBudgetLruCache", () => {
  it("stores and retrieves values", () => {
    const cache = new CharBudgetLruCache<number>(100);
    cache.set("a", 1);
    cache.set("bb", 2);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("bb")).toBe(2);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.charCount).toBe(3); // "a" + "bb"
  });

  it("distinguishes a stored undefined from a miss", () => {
    const cache = new CharBudgetLruCache<number | undefined>(100);
    cache.set("k", undefined);

    expect(cache.has("k")).toBe(true);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.has("absent")).toBe(false);
  });

  it("evicts least-recently-used entries when over the char budget", () => {
    // Budget of 3 chars; each single-char key costs 1.
    const cache = new CharBudgetLruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.charCount).toBe(3);

    // Adding a 4th single-char key evicts the oldest ("a").
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.charCount).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("d")).toBe(true);
  });

  it("treats a get as a use, protecting the entry from eviction", () => {
    const cache = new CharBudgetLruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    // Touch "a" so it becomes most-recently used.
    expect(cache.get("a")).toBe(1);

    // Next insert should now evict "b" (the new oldest), not "a".
    cache.set("d", 4);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("replaces an existing key in place without double-counting chars", () => {
    const cache = new CharBudgetLruCache<number>(10);
    cache.set("ab", 1);
    cache.set("ab", 2);

    expect(cache.get("ab")).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.charCount).toBe(2);
  });

  it("skips entries whose key alone exceeds the budget", () => {
    const cache = new CharBudgetLruCache<number>(3);
    cache.set("toolong", 1); // 7 chars > budget 3

    expect(cache.has("toolong")).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.charCount).toBe(0);
  });

  it("clear() empties the cache and resets the char count", () => {
    const cache = new CharBudgetLruCache<number>(100);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.charCount).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("memoizeAsyncByString", () => {
  it("calls the underlying function only once per distinct input", async () => {
    const fn = vi.fn(async (input: string) => `<${input}>`);
    const memoized = memoizeAsyncByString(fn, { maxChars: 1000 });

    expect(await memoized("x")).toBe("<x>");
    expect(await memoized("x")).toBe("<x>");
    expect(await memoized("y")).toBe("<y>");

    expect(fn).toHaveBeenCalledTimes(2); // "x" once, "y" once
  });

  it("re-computes after the cached entry is evicted", async () => {
    const fn = vi.fn(async (input: string) => input.toUpperCase());
    // Budget of 1 char: only one single-char key fits at a time.
    const memoized = memoizeAsyncByString(fn, { maxChars: 1 });

    await memoized("a"); // cache: {a}
    await memoized("b"); // evicts "a", cache: {b}
    await memoized("a"); // miss again → recompute

    expect(fn).toHaveBeenCalledTimes(3);
  });
});
