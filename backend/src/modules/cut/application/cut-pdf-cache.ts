/**
 * In-process TTL cache for rendered cut PDFs (plan §7). The pre-warm is a
 * CACHE-warming optimization, NOT persistence: the DB `cut_group_sheet.placements`
 * stay the single source of truth and every PDF is re-derivable on a cold cache,
 * so "no persisted blobs" is preserved. Entries expire by TTL (superseded keys
 * are not proactively evicted — N3-b). An in-flight guard dedups concurrent
 * renders of the same key so a burst of requests triggers one render.
 */
export type PdfEnsureResult =
  | { status: 'ready'; buffer: Buffer }
  | { status: 'pending' }
  | { status: 'failed'; error: unknown };

export type PdfSettledState = 'ready' | 'failed';

/** Called when a kicked render settles (used to update cut_job.pdf_prewarm_state). */
export type OnSettled = (state: PdfSettledState, reason?: string) => void;

interface CacheEntry {
  buffer: Buffer;
  expiresAtMs: number;
}

interface FailureEntry {
  error: unknown;
  expiresAtMs: number;
}

export interface CutPdfCacheOptions {
  ttlMs?: number;
  /** Hard cap on cached buffers; oldest-inserted are evicted past this (FIFO). */
  maxEntries?: number;
  /** Short window a render failure is remembered, so a deterministic failure
   *  (e.g. empty group) surfaces the error on retry instead of looping 202. */
  failureTtlMs?: number;
  now?: () => number;
}

export class CutPdfCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, FailureEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;

  constructor(options: CutPdfCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 3_600_000; // default 1h (plan §7)
    this.maxEntries = options.maxEntries ?? 200; // bound memory (N3-b accepts TTL, but cap stale keys)
    this.failureTtlMs = options.failureTtlMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Serve from cache if warm; otherwise kick a single background render and
   * return `pending` (the caller answers HTTP 202 + Retry-After). Never blocks.
   */
  ensure(key: string, render: () => Promise<Buffer>, onSettled?: OnSettled): PdfEnsureResult {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAtMs > this.now()) {
      return { status: 'ready', buffer: entry.buffer };
    }
    // A recent failure surfaces the error (so the endpoint can return a real
    // 4xx/5xx) instead of re-rendering and returning 202 forever for a
    // deterministic failure. After failureTtlMs it is retried.
    const failure = this.failures.get(key);
    if (failure && failure.expiresAtMs > this.now()) {
      return { status: 'failed', error: failure.error };
    }
    if (!this.inflight.has(key)) {
      const promise = render()
        .then((buffer) => {
          this.entries.set(key, { buffer, expiresAtMs: this.now() + this.ttlMs });
          this.failures.delete(key);
          this.evictOverflow();
          settle(onSettled, 'ready');
        })
        .catch((error: unknown) => {
          // Remember the failure briefly so a retry returns the error rather than
          // re-entering the pending loop; it auto-expires for transient errors.
          this.failures.set(key, { error, expiresAtMs: this.now() + this.failureTtlMs });
          settle(onSettled, 'failed', error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          this.inflight.delete(key);
        });
      this.inflight.set(key, promise);
    }
    return { status: 'pending' };
  }

  /** Test/shutdown helper: await all in-flight renders. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  /** Evict oldest-inserted entries once the cap is exceeded (Map preserves
   *  insertion order), bounding total memory regardless of recalc churn. */
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Invoke the settle callback defensively — a throwing callback must not corrupt
 *  the cache's in-flight bookkeeping. */
function settle(onSettled: OnSettled | undefined, state: PdfSettledState, reason?: string): void {
  try {
    onSettled?.(state, reason);
  } catch {
    // ignore callback errors
  }
}
