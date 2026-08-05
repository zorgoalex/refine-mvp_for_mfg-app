import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LABEL_TEMPLATE_CHANGED_EVENT,
  notifyLabelTemplateChanged,
  subscribeLabelTemplateChanged,
} from './labelTemplateEvents';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('label template change events', () => {
  it('notifies the current window and persists a cross-tab payload', () => {
    const dispatchEvent = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('CustomEvent', class {
      constructor(public type: string, public init: CustomEventInit) {}
    });
    vi.stubGlobal('window', {
      dispatchEvent,
      localStorage: { setItem },
    });

    notifyLabelTemplateChanged({ labelTemplateId: 17, version: 4 });

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: LABEL_TEMPLATE_CHANGED_EVENT,
      init: expect.objectContaining({
        detail: expect.objectContaining({ templateId: 17, version: 4 }),
      }),
    }));
    expect(setItem).toHaveBeenCalledWith(
      'erp.labelTemplate.changed',
      expect.stringContaining('"templateId":17'),
    );
  });

  it('delivers a cross-tab event once and removes listeners on unsubscribe', () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    });
    const received = vi.fn();
    const unsubscribe = subscribeLabelTemplateChanged(received);
    const payload = {
      eventId: 'template-17-v4',
      templateId: 17,
      version: 4,
      changedAt: 123,
    };

    listeners.get('storage')?.({
      key: 'erp.labelTemplate.changed',
      newValue: JSON.stringify(payload),
    } as StorageEvent);
    listeners.get(LABEL_TEMPLATE_CHANGED_EVENT)?.({ detail: payload } as CustomEvent);

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(payload);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });

  it('ignores malformed storage payloads', () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    });
    const received = vi.fn();
    subscribeLabelTemplateChanged(received);

    listeners.get('storage')?.({
      key: 'erp.labelTemplate.changed',
      newValue: '{broken',
    } as StorageEvent);
    listeners.get('storage')?.({
      key: 'erp.labelTemplate.changed',
      newValue: JSON.stringify({ eventId: 'bad', templateId: 0, version: 0, changedAt: 123 }),
    } as StorageEvent);

    expect(received).not.toHaveBeenCalled();
  });
});
