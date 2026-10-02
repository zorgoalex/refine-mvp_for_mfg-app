import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/apiError';
import { authSession } from '../../api/authSession';

const mocks = vi.hoisted(() => ({ list: vi.fn(), orderList: vi.fn(), run: vi.fn(), shown: [] as string[], destroyed: 0 }));
vi.mock('../../api/myWhatsAppSendsApi', () => ({ myWhatsAppSendsApi: { list: mocks.list } }));
vi.mock('../../api/orderSendApi', () => ({ orderSendApi: { list: mocks.orderList } }));
vi.mock('../../api/broadcastsApi', () => ({ broadcastsApi: { run: mocks.run } }));
vi.mock('antd', () => {
  const api = { success: (args: { key: string }) => mocks.shown.push(args.key), warning: (args: { key: string }) => mocks.shown.push(args.key), error: () => undefined,
    destroy: () => { mocks.destroyed += 1; } };
  return { notification: { useNotification: () => [api, null] } };
});

import { useMyWhatsAppSends } from './useMyWhatsAppSends';
import { WHATSAPP_SEND_QUEUED_EVENT, announceWhatsAppSendQueued, currentOwner, emptyFollowState, trackSend } from './myWhatsAppSendsModel';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const send = (id: string, state: string) => ({ kind: 'order_send', id, title: id, state, active: state === 'queued', estimatedAt: null,
  createdAt: '2026-10-02T10:00:00Z', finishedAt: null, errorCode: null, cancelReason: null, orderId: 1, targetDate: null });
let last: ReturnType<typeof useMyWhatsAppSends> | null = null;
function Probe() {
  last = useMyWhatsAppSends();
  return null;
}
const user = (id: string) => ({ id, username: id, role: 'manager', permissions: ['orders.export'] }) as never;
const notFound = () => new ApiError({ status: 404, code: 'NOT_FOUND', message: 'Not Found' } as never);
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe('useMyWhatsAppSends with the real auth session', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    mocks.shown.length = 0;
    mocks.destroyed = 0;
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); } },
    }));
    vi.stubGlobal('navigator', {});
  });
  afterEach(() => { vi.unstubAllGlobals(); mocks.list.mockReset(); mocks.orderList.mockReset(); mocks.run.mockReset(); authSession.clear(); });

  it('a session change (no React update) drops the previous user\'s late response and closes the balloons', async () => {
    const first = deferred<{ serverTime: string; items: unknown[] }>();
    mocks.list.mockImplementationOnce(() => first.promise).mockResolvedValue({ serverTime: '', items: [send('b-1', 'queued')] });
    authSession.setUser(user('A'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe />); });
    const destroyedBefore = mocks.destroyed;
    await act(async () => { authSession.setUser(user('B')); });
    await act(async () => { first.resolve({ serverTime: '', items: [send('a-1', 'queued')] }); await first.promise; });
    await flush();
    expect(mocks.destroyed).toBeGreaterThan(destroyedBefore);
    expect(store.get('whatsapp.my-sends.v3.A')).toBeUndefined();
    expect(JSON.parse(store.get('whatsapp.my-sends.v3.B') ?? '{}').tracked).toEqual(['b-1']);
    await act(async () => { renderer.unmount(); });
  });

  it('an older backend (404): followed sends are asked through its old endpoints, both orders of events give one balloon', async () => {
    mocks.list.mockRejectedValue(notFound());
    let state = 'queued';
    mocks.orderList.mockImplementation(async () => ({ sends: [{ sendId: 'c-1', orderId: 7, targetKind: 'client', chatKey: null, recipientLabel: 'Клиент',
      recipientMasked: '', form: 'order_pdf', state, errorCode: null, cancelReason: null, createdAt: '2026-10-02T10:00:00Z', sentAt: null, actor: { id: 'A', username: null } }] }));
    authSession.setUser(user('A'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe />); });
    await act(async () => { await announceWhatsAppSendQueued('c-1', { kind: 'order_send', orderId: 7 }, currentOwner()); });
    await flush();
    expect(last?.supported).toBe(false);
    expect(mocks.orderList).toHaveBeenCalledWith(7);
    expect(mocks.shown).toEqual([]);
    state = 'sent';
    await act(async () => { last?.refresh(); });
    await flush();
    await act(async () => { last?.refresh(); });
    await flush();
    expect(mocks.shown).toEqual(['whatsapp-send-c-1']);
    await act(async () => { renderer.unmount(); });
  });

  it('a send accepted after a re-login belongs to the user captured before the command, and does not wake the new session', async () => {
    authSession.setUser(user('A'));
    const owner = currentOwner(); // captured before the POST
    const events: Event[] = [];
    window.addEventListener(WHATSAPP_SEND_QUEUED_EVENT, (event) => events.push(event));
    authSession.setUser(user('B')); // another user signs in while the POST runs
    await announceWhatsAppSendQueued('a-send', { kind: 'order_send', orderId: 3 }, owner);
    expect(JSON.parse(store.get('whatsapp.my-sends.v3.A') ?? '{}').tracked).toEqual(['a-send']);
    expect(store.get('whatsapp.my-sends.v3.B')).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('a queued event of A waiting for the lock is not registered for B (storage unavailable, older backend)', async () => {
    // Storage unavailable: every page runs on its memory.
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: {
      getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => undefined } }));
    const gate = deferred<void>();
    let waiting = false;
    vi.stubGlobal('navigator', { locks: { request: async <T,>(_name: string, callback: () => T) => {
      if (!waiting) { waiting = true; await gate.promise; } // the first lock request (A's queued event) waits
      return callback();
    } } });
    mocks.list.mockRejectedValue(notFound());
    mocks.orderList.mockResolvedValue({ sends: [{ sendId: 'a-send', orderId: 5, targetKind: 'client', chatKey: null, recipientLabel: 'Клиент',
      recipientMasked: '', form: 'order_pdf', state: 'sent', errorCode: null, cancelReason: null, createdAt: '', sentAt: '', actor: { id: 'A', username: null } }] });
    authSession.setUser(user('A'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe />); });
    await flush();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WHATSAPP_SEND_QUEUED_EVENT, { detail: { id: 'a-send', meta: { kind: 'order_send', orderId: 5 }, userId: 'A' } }));
    });
    await act(async () => { authSession.setUser(user('B')); });
    await act(async () => { gate.resolve(); });
    await flush();
    await act(async () => { last?.refresh(); });
    await flush();
    expect(mocks.shown).toEqual([]);
    expect(mocks.orderList).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });

  it.each([
    ['403 on the order history', () => Promise.reject(new ApiError({ status: 403, code: 'PERMISSION_DENIED', message: 'Forbidden' } as never))],
    ['the send is no longer in the history', () => Promise.resolve({ sends: [] })],
  ])('older backend, %s: after 15 minutes one «не удалось подтвердить» balloon, then no more requests (also after a reload)', async (_name, answer) => {
    mocks.list.mockRejectedValue(notFound());
    mocks.orderList.mockImplementation(answer);
    authSession.setUser(user('A'));
    // Registered 16 minutes ago in an earlier page (a reload): the deadline has passed.
    trackSend('A', 'lost', { kind: 'order_send', orderId: 9, since: Date.now() - 16 * 60_000 },
      { storage: window.localStorage as never, memory: emptyFollowState() });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe />); });
    await flush();
    expect(mocks.shown).toEqual(['whatsapp-send-lost']);
    expect(JSON.parse(store.get('whatsapp.my-sends.v3.A') ?? '{}').tracked).toEqual([]);
    const calls = mocks.orderList.mock.calls.length;
    await act(async () => { last?.refresh(); });
    await flush();
    expect(mocks.orderList.mock.calls.length).toBe(calls);
    expect(mocks.shown).toEqual(['whatsapp-send-lost']);
    await act(async () => { renderer.unmount(); });
  });

  it('a late 404 of the previous session does not switch the new session to the older-backend mode', async () => {
    let rejectA!: (error: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise((_, reject) => { rejectA = reject; }))
      .mockResolvedValue({ serverTime: '', items: [] });
    authSession.setUser(user('A'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe />); });
    await act(async () => { authSession.setUser(user('B')); });
    await act(async () => { rejectA(notFound()); }); // A's request ran against an older backend
    await flush();
    await act(async () => { last?.refresh(); });
    await flush();
    expect(last?.supported).toBe(true);
    expect(mocks.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.orderList).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });
});
