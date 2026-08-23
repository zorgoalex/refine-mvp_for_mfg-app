import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleOrderRead } from './orderReadPriority';

describe('order read priority lanes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts critical work synchronously', () => {
    const start = vi.fn();

    scheduleOrderRead('critical', start);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts on-surface-open work only for an open surface', () => {
    const closedStart = vi.fn();
    const openStart = vi.fn();

    scheduleOrderRead('on-surface-open', closedStart, { surfaceOpen: false });
    scheduleOrderRead('on-surface-open', openStart, { surfaceOpen: true });

    expect(closedStart).not.toHaveBeenCalled();
    expect(openStart).toHaveBeenCalledTimes(1);
  });

  it('defers secondary work until after the first frame and supports cancellation', () => {
    let frame: (() => void) | undefined;
    let timeout: (() => void) | undefined;
    const cancelFrame = vi.fn();
    const clearTimeout = vi.fn();
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((callback: () => void) => {
        frame = callback;
        return 7;
      }),
      cancelAnimationFrame: cancelFrame,
      setTimeout: vi.fn((callback: () => void) => {
        timeout = callback;
        return 9;
      }),
      clearTimeout,
    });
    const start = vi.fn();

    const cancel = scheduleOrderRead('after-first-frame', start);
    expect(start).not.toHaveBeenCalled();
    frame?.();
    expect(start).not.toHaveBeenCalled();
    timeout?.();
    expect(start).toHaveBeenCalledTimes(1);

    const cancelledStart = vi.fn();
    const cancelBeforeFrame = scheduleOrderRead('after-first-frame', cancelledStart);
    cancelBeforeFrame();
    frame?.();
    timeout?.();
    expect(cancelledStart).not.toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(7);

    const cancelledAfterFrameStart = vi.fn();
    const cancelAfterFrame = scheduleOrderRead('after-first-frame', cancelledAfterFrameStart);
    frame?.();
    cancelAfterFrame();
    timeout?.();
    expect(cancelledAfterFrameStart).not.toHaveBeenCalled();
    expect(clearTimeout).toHaveBeenCalledWith(9);

    cancel();
  });
});
