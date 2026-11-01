/**
 * Keeps the order card in step with the live snapshot: when the snapshot reports a newer `orders.version`
 * than the card shows (the order changed elsewhere, e.g. «Переделка» in another tab), the card is re-read.
 * One read at a time; while the card is still behind (the read failed, or returned an older version) the next
 * attempt waits `retryMs` after the previous one, so a failing read is retried without a request storm.
 * Paused while the card is not active (hidden document, inactive workspace tab, closed lifecycle gate): no read
 * starts and a pending retry is dropped; on activation the card catches up again.
 */
export interface OrderVersionCatchUp {
  update(liveVersion: number | null, shownVersion: number | null): void;
  setActive(active: boolean): void;
  dispose(): void;
}

export function createOrderVersionCatchUp(options: {
  refetch: () => Promise<unknown>;
  retryMs: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): OrderVersionCatchUp {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let live: number | null = null;
  let shown: number | null = null;
  let inFlight = false;
  let timer: unknown = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let active = true;

  const behind = () => live !== null && shown !== null && live > shown;

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    if (disposed || !active || inFlight || timer !== null || !behind()) return;
    timer = setTimer(run, Math.max(0, lastAttemptAt + options.retryMs - now()));
  };

  function run() {
    timer = null;
    if (disposed || !active || inFlight || !behind()) return;
    inFlight = true;
    lastAttemptAt = now();
    void options.refetch()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        // A successful read updates `shown` through `update`; until then (or after a failure) retry later.
        schedule();
      });
  }

  return {
    update(liveVersion, shownVersion) {
      live = liveVersion;
      shown = shownVersion;
      if (!behind()) cancelTimer();
      schedule();
    },
    setActive(next) {
      active = next;
      if (!active) cancelTimer();
      schedule();
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
