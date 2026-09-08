// In-process de-duplication of concurrent work that must happen exactly once
// per key. The motivating case is OAuth refresh: a rotating refresh token is
// single-use, so N parallel callers firing N refreshes spend the token N times
// and all but the winner get invalid_grant.
//
// Scope is deliberately one process — it is a coalescer, not a cache and not a
// cross-process lock: nothing is retained after the promise settles.

export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  /**
   * Run `fn` for `key`, or join the run already in flight for that key.
   * Every joiner sees the same resolution or the same rejection.
   */
  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    // The async wrapper turns a synchronous throw in `fn` into a rejection, so
    // the map entry is always installed and always cleared.
    const started = (async () => fn())();
    const shared: Promise<T> = started.finally(() => {
      // Only drop our own entry: a later run may already own the key.
      if (this.inflight.get(key) === shared) this.inflight.delete(key);
    });
    this.inflight.set(key, shared);
    return shared;
  }

  /** Number of runs currently in flight (tests, diagnostics). */
  get size(): number {
    return this.inflight.size;
  }
}
