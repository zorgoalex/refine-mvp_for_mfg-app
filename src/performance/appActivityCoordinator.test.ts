import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_ACTIVITY_COALESCE_MS,
  getAppActivityDiagnostics,
  getAppActivitySnapshot,
  resetAppActivityCoordinatorForTests,
  startAppActivityCoordinator,
} from './appActivityCoordinator';

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  focused = true;

  hasFocus = () => this.focused;
}

describe('appActivityCoordinator', () => {
  let fakeWindow: EventTarget;
  let fakeDocument: FakeDocument;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeWindow = new EventTarget();
    fakeDocument = new FakeDocument();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
    resetAppActivityCoordinatorForTests();
  });

  afterEach(() => {
    resetAppActivityCoordinatorForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('attaches one shared listener set across StrictMode-style duplicate owners', () => {
    const addWindow = vi.spyOn(fakeWindow, 'addEventListener');
    const removeWindow = vi.spyOn(fakeWindow, 'removeEventListener');
    const addDocument = vi.spyOn(fakeDocument, 'addEventListener');
    const removeDocument = vi.spyOn(fakeDocument, 'removeEventListener');

    const stopFirst = startAppActivityCoordinator();
    const stopSecond = startAppActivityCoordinator();

    expect(addWindow.mock.calls.map(([event]) => event)).toEqual(['focus', 'blur']);
    expect(addDocument).toHaveBeenCalledTimes(1);
    expect(getAppActivityDiagnostics()).toMatchObject({
      coordinatorOwnerCount: 2,
      domListenerCount: 3,
    });

    stopFirst();
    expect(removeWindow).not.toHaveBeenCalled();
    stopSecond();
    expect(removeWindow.mock.calls.map(([event]) => event)).toEqual(['focus', 'blur']);
    expect(removeDocument).toHaveBeenCalledTimes(1);
  });

  it('coalesces a focus storm into one activation revision', () => {
    const stop = startAppActivityCoordinator();
    fakeWindow.dispatchEvent(new Event('focus'));
    fakeWindow.dispatchEvent(new Event('focus'));
    fakeWindow.dispatchEvent(new Event('focus'));

    vi.advanceTimersByTime(APP_ACTIVITY_COALESCE_MS - 1);
    expect(getAppActivitySnapshot().activationRevision).toBe(0);
    vi.advanceTimersByTime(1);
    expect(getAppActivitySnapshot().activationRevision).toBe(1);
    stop();
  });

  it('publishes hidden immediately and coalesces visibility-return plus focus', () => {
    const stop = startAppActivityCoordinator();
    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(getAppActivitySnapshot().documentVisible).toBe(false);

    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    fakeWindow.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(APP_ACTIVITY_COALESCE_MS);

    expect(getAppActivitySnapshot()).toMatchObject({
      activationRevision: 1,
      documentVisible: true,
      windowFocused: true,
    });
    stop();
  });
});
