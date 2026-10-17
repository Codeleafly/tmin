/** Fixed-window in-memory rate limiter (per key). Fail-closed on abuse. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private maxPerMin: number,
    private nowFn: () => number = Date.now,
  ) {}

  /** Returns seconds until retry when blocked, else 0. */
  check(key: string): number {
    const now = this.nowFn();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + 60_000 });
      return 0;
    }
    cur.count += 1;
    if (cur.count > this.maxPerMin) {
      return Math.ceil((cur.resetAt - now) / 1000);
    }
    return 0;
  }

  sweep(): void {
    const now = this.nowFn();
    for (const [k, v] of this.hits) {
      if (v.resetAt <= now) this.hits.delete(k);
    }
  }
}
