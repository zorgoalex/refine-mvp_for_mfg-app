import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), user: { current: null as null | { id: string; permissions: string[] } }, shown: [] as string[] }));
vi.mock('../../api/myWhatsAppSendsApi', () => ({ myWhatsAppSendsApi: { list: mocks.list } }));
vi.mock('../../api/broadcastsApi', () => ({ broadcastsApi: { run: vi.fn() } }));
vi.mock('../../api/orderSendApi', () => ({ orderSendApi: { list: vi.fn() } }));
vi.mock('../../api/authSession', () => ({ authSession: { getUser: () => mocks.user.current, subscribe: () => () => undefined,
  getSessionGeneration: () => mocks.user.current?.id ?? '' } }));
vi.mock('antd', () => {
  const api = { success: (args: { key: string }) => mocks.shown.push(args.key), warning: () => undefined, error: () => undefined, destroy: () => undefined };
  return { notification: { useNotification: () => [api, null] } };
});

import { useMyWhatsAppSends } from './useMyWhatsAppSends';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const send = (id: string, state: string) => ({ kind: 'order_send', id, title: id, state, active: state === 'queued', estimatedAt: null,
  createdAt: '2026-10-02T10:00:00Z', finishedAt: null, errorCode: null, cancelReason: null, orderId: 1, targetDate: null });

function Probe() {
  useMyWhatsAppSends();
  return null;
}

describe('useMyWhatsAppSends across a user change without remounting', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    mocks.shown.length = 0;
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); } },
    }));
    vi.stubGlobal('navigator', {});
  });
  afterEach(() => { vi.unstubAllGlobals(); mocks.list.mockReset(); });

  it('drops the previous user\'s late response and continues only as the new user', async () => {
    const first = deferred<{ serverTime: string; items: unknown[] }>();
    mocks.list.mockImplementationOnce(() => first.promise).mockResolvedValue({ serverTime: '', items: [send('b-1', 'queued')] });
    mocks.user.current = { id: 'A', permissions: ['orders.export'] };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe />); });
    // Same component, another user while A's request is still running.
    mocks.user.current = { id: 'B', permissions: ['orders.export'] };
    await act(async () => { renderer.update(<Probe />); });
    await act(async () => { first.resolve({ serverTime: '', items: [send('a-1', 'queued')] }); await first.promise; });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    // Only B's state was written; A's late «a-1» never entered anyone's follow state.
    expect(store.get('whatsapp.my-sends.v3.A')).toBeUndefined();
    expect(JSON.parse(store.get('whatsapp.my-sends.v3.B') ?? '{}').tracked).toEqual(['b-1']);
    await act(async () => { renderer.unmount(); });
  });

  it('a user change while the response waits for the cross-tab lock writes nothing for the previous user', async () => {
    const gate = deferred<void>();
    let held = 0;
    vi.stubGlobal('navigator', { locks: { request: async <T,>(_name: string, callback: () => T) => {
      held += 1;
      if (held === 1) await gate.promise; // the first collect waits for the lock (another tab holds it)
      return callback();
    } } });
    mocks.list.mockResolvedValueOnce({ serverTime: '', items: [send('a-1', 'queued')] })
      .mockResolvedValue({ serverTime: '', items: [send('b-1', 'queued')] });
    mocks.user.current = { id: 'A', permissions: ['orders.export'] };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe />); });
    mocks.user.current = { id: 'B', permissions: ['orders.export'] };
    await act(async () => { renderer.update(<Probe />); });
    await act(async () => { gate.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(store.get('whatsapp.my-sends.v3.A')).toBeUndefined();
    expect(JSON.parse(store.get('whatsapp.my-sends.v3.B') ?? '{}').tracked).toEqual(['b-1']);
    await act(async () => { renderer.unmount(); });
  });
});
