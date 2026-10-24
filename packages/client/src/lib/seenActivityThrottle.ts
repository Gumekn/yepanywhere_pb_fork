/**
 * Publishes a seen-activity timestamp immediately, then at most once per
 * interval. A trailing timer records the latest burst within one interval, so
 * a visible session is marked seen no more than about that long after the
 * last stream event.
 */
export class SeenActivityThrottle {
  private markedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly publish: (iso: string) => void,
    private readonly intervalMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  note(iso: string): void {
    const current = this.now();
    const elapsed = current - this.markedAt;
    if (this.markedAt === 0 || elapsed >= this.intervalMs) {
      this.clearTimer();
      this.markedAt = current;
      this.publish(iso);
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.markedAt = this.now();
      this.publish(new Date(this.markedAt).toISOString());
    }, this.intervalMs - elapsed);
  }

  reset(): void {
    this.clearTimer();
    this.markedAt = 0;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
