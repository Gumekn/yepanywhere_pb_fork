import type { SessionDisplaySnapshot } from "@yep-anywhere/shared";
import { estimateStructuralBytes } from "./sessionSnapshotCache";

/** Snapshots are immutable. Account only for the replaced entry on each patch. */
export class DisplaySnapshotCache {
  private readonly entries = new Map<
    string,
    { snapshot: SessionDisplaySnapshot; bytes: number }
  >();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntries = 5,
  ) {}

  get(key: string): SessionDisplaySnapshot | undefined {
    return this.entries.get(key)?.snapshot;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, snapshot: SessionDisplaySnapshot): void {
    // Eviction accounting only. The stored snapshot is the same object the
    // caller passed in. Stop once the estimate already exceeds the budget.
    const bytes = estimateStructuralBytes([snapshot], this.maxBytes);
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
    this.entries.set(key, { snapshot, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.entries.entries().next().value;
      if (!first) break;
      this.bytes -= first[1].bytes;
      this.entries.delete(first[0]);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
