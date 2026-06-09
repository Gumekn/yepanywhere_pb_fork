/**
 * Char-budget LRU cache — a tiny, zero-dependency cache bounded by the total
 * number of characters across all keys (a stable proxy for input size).
 *
 * Used to memoize deterministic, CPU-heavy string transforms (shiki syntax
 * highlighting, markdown rendering) so reopening the same session, loading
 * older chunks, or switching branches doesn't re-render identical content.
 *
 * LRU ordering relies on JS `Map` preserving insertion order: a `get` hit
 * re-inserts the key (moving it to the most-recent position), and eviction
 * removes from the front (least-recently used) until back under budget.
 */
export class CharBudgetLruCache<V> {
  private readonly map = new Map<string, V>();
  private readonly maxChars: number;
  private currentChars = 0;

  /**
   * @param maxChars - Maximum sum of key lengths to retain. Entries whose key
   *   alone exceeds this budget are never stored (would evict everything else).
   */
  constructor(maxChars: number) {
    this.maxChars = maxChars;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      // Distinguish "missing" from "stored undefined": Map.has check.
      if (!this.map.has(key)) return undefined;
    }
    // Move to most-recent position.
    this.map.delete(key);
    this.map.set(key, value as V);
    return value as V;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      // Replace in place at the most-recent position; key length unchanged.
      this.map.delete(key);
      this.map.set(key, value);
      return;
    }

    // An entry larger than the whole budget can't be cached without evicting
    // everything; skip it rather than thrash.
    if (key.length > this.maxChars) {
      return;
    }

    this.map.set(key, value);
    this.currentChars += key.length;
    this.evictToBudget();
  }

  private evictToBudget(): void {
    while (this.currentChars > this.maxChars) {
      // First key is the least-recently used.
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
      this.currentChars -= oldestKey.length;
    }
  }

  /** Number of cached entries (for tests/diagnostics). */
  get size(): number {
    return this.map.size;
  }

  /** Sum of cached key lengths (for tests/diagnostics). */
  get charCount(): number {
    return this.currentChars;
  }

  clear(): void {
    this.map.clear();
    this.currentChars = 0;
  }
}

/**
 * Wrap a deterministic `(input: string) => Promise<R>` function with a
 * char-budget LRU keyed by its single string argument.
 *
 * Returns a function with the same signature. Concurrent calls for the same
 * key may both run the first time (no in-flight dedupe) — acceptable here
 * because the underlying transforms are idempotent and cheap to repeat once.
 */
export function memoizeAsyncByString<R>(
  fn: (input: string) => Promise<R>,
  options: { maxChars: number },
): (input: string) => Promise<R> {
  const cache = new CharBudgetLruCache<R>(options.maxChars);
  const memoized = async (input: string): Promise<R> => {
    if (cache.has(input)) {
      return cache.get(input) as R;
    }
    const result = await fn(input);
    cache.set(input, result);
    return result;
  };
  // Expose the cache for tests/diagnostics without widening the call signature.
  (memoized as { cache?: CharBudgetLruCache<R> }).cache = cache;
  return memoized;
}
