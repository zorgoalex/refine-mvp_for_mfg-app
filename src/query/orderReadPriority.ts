export type OrderReadPriority = 'critical' | 'after-first-frame' | 'on-surface-open';

interface ScheduleOrderReadOptions {
  surfaceOpen?: boolean;
}

export function scheduleOrderRead(
  priority: OrderReadPriority,
  start: () => void,
  options: ScheduleOrderReadOptions = {},
): () => void {
  let cancelled = false;
  let frameId: number | null = null;
  let timeoutId: number | null = null;
  const invoke = () => {
    if (!cancelled) start();
  };

  if (priority === 'on-surface-open' && options.surfaceOpen !== true) {
    return () => {
      cancelled = true;
    };
  }

  if (priority !== 'after-first-frame') {
    invoke();
    return () => {
      cancelled = true;
    };
  }

  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    queueMicrotask(invoke);
    return () => {
      cancelled = true;
    };
  }

  frameId = window.requestAnimationFrame(() => {
    frameId = null;
    if (cancelled) return;
    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      invoke();
    }, 0);
  });

  return () => {
    cancelled = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    frameId = null;
    timeoutId = null;
  };
}
