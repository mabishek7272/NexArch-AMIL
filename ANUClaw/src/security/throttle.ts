/**
 * In-process fixed-window limiter and concurrency gate (plan F16).
 *
 * LIMITATION: counters live in this process. With several API processes the
 * effective limit is multiplied by the process count; use a shared store
 * (e.g. PostgreSQL/Redis) before horizontal scaling. Monthly quotas are
 * enforced from the database (tenant usage), not from these counters.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Record one hit; returns whether it is within `limit` and seconds until reset. */
  hit(key: string, limit: number): { allowed: boolean; retryAfterSec: number; count: number } {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) { w = { start: t, count: 0 }; this.windows.set(key, w); }
    w.count++;
    const retryAfterSec = Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    if (this.windows.size > 50_000) this.sweep(t);
    return { allowed: w.count <= limit, retryAfterSec, count: w.count };
  }

  /** Current count without recording a hit. */
  peek(key: string): number {
    const w = this.windows.get(key);
    return w && this.now() - w.start < this.windowMs ? w.count : 0;
  }

  reset(key: string): void { this.windows.delete(key); }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

export class ConcurrencyGate {
  private readonly inFlight = new Map<string, number>();
  tryAcquire(key: string, max: number): boolean {
    const n = this.inFlight.get(key) ?? 0;
    if (n >= max) return false;
    this.inFlight.set(key, n + 1);
    return true;
  }
  release(key: string): void {
    const n = (this.inFlight.get(key) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(key); else this.inFlight.set(key, n);
  }
  current(key: string): number { return this.inFlight.get(key) ?? 0; }
}
