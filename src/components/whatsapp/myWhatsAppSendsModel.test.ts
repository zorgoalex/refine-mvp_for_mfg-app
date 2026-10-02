import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MyWhatsAppSend } from '../../api/myWhatsAppSendsApi';
import {
  addedTrackedIds, balloonFor, collectFinished, emptyFollowState, estimateText, fromBroadcastRun, fromOrderSendView, loadState, nextPollDelay,
  trackSend, withFollowLock, type FollowAccess,
} from './myWhatsAppSendsModel';

const memory = () => {
  const data = new Map<string, string>();
  let writes = 0;
  return { data, writes: () => writes,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { writes += 1; data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
};
const access = (storage: ReturnType<typeof memory> | null = memory()): FollowAccess => ({ storage, memory: emptyFollowState() });
const item = (id: string, state: string, extra: Partial<MyWhatsAppSend> = {}): MyWhatsAppSend => ({
  kind: 'order_send', id, title: `Заказ ${id} → клиенту, PDF заказа`, state, active: state === 'queued' || state === 'sending' || state === 'preparing',
  estimatedAt: null, createdAt: '2026-10-02T10:00:00Z', finishedAt: null, errorCode: null, cancelReason: null, orderId: 1, targetDate: null, ...extra,
});
const META = { kind: 'order_send' as const, orderId: 1 };

describe('following the user\'s own sends', () => {
  it('a send registered at acceptance and finished before the first poll gets its balloon, also from a reloaded page', () => {
    const storage = memory();
    trackSend('11', 'a', META, access(storage));
    expect(collectFinished([item('a', 'sent')], '11', access(storage)).map((entry) => entry.id)).toEqual(['a']);
  });

  it('announces once; a stale «queued» response never brings it back; a second tab does not repeat it', () => {
    const storage = memory();
    const tabA = access(storage);
    const tabB = access(storage);
    collectFinished([item('a', 'queued')], '11', tabB);
    expect(collectFinished([item('a', 'sent')], '11', tabA).map((entry) => entry.id)).toEqual(['a']);
    expect(collectFinished([item('a', 'queued')], '11', tabB)).toEqual([]);
    expect(collectFinished([item('a', 'sent')], '11', tabB)).toEqual([]);
  });

  it('never announces sends that were final when first seen, nor across users', () => {
    const storage = memory();
    trackSend('12', 'a', META, access(storage));
    expect(collectFinished([item('a', 'sent'), item('b', 'failed')], '11', access(storage))).toEqual([]);
  });

  it('after 200 announced ids an unchanged response writes nothing (no storage event for other tabs)', () => {
    const storage = memory();
    storage.data.set('whatsapp.my-sends.v3.11', JSON.stringify({ tracked: ['new'], announced: Array.from({ length: 200 }, (_, index) => `old-${index}`),
      meta: { new: META } }));
    expect(collectFinished([item('new', 'sent')], '11', access(storage)).map((entry) => entry.id)).toEqual(['new']);
    const state = loadState('11', access(storage));
    expect(state.announced).toHaveLength(200);
    expect(state.announced.at(-1)).toBe('new');
    const before = storage.writes();
    for (let round = 0; round < 5; round += 1) collectFinished([item('new', 'sent'), item('old-0', 'sent')], '11', access(storage));
    expect(storage.writes()).toBe(before);
  });

  it('only an added tracked id wakes another tab', () => {
    const state = (tracked: string[], announced: string[] = []) => JSON.stringify({ tracked, announced, meta: {} });
    expect(addedTrackedIds(state(['a']), state(['a', 'b']))).toBe(true);
    expect(addedTrackedIds(null, state(['a']))).toBe(true);
    expect(addedTrackedIds(state(['a', 'b']), state(['b'], ['a']))).toBe(false);
  });
});

describe('storage failure', () => {
  it('setItem fails: the page memory takes over for good — one balloon, and a new fast send registered later still gets one', () => {
    const data = new Map<string, string>([['whatsapp.my-sends.v3.11', JSON.stringify({ tracked: ['s'], announced: [], meta: { s: META } })]]);
    let failing = true;
    const storage = { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { if (failing) throw new Error('QuotaExceededError'); data.set(key, value); }, removeItem: () => undefined };
    const page = access(storage as never);
    expect(collectFinished([item('s', 'sent')], '11', page).map((entry) => entry.id)).toEqual(['s']);
    expect(page.memory.degraded).toBe(true);
    expect(collectFinished([item('s', 'sent')], '11', page)).toEqual([]);
    failing = false; // storage works again, the page stays on memory
    trackSend('11', 'fast', META, page);
    expect(loadState('11', page).tracked).toContain('fast');
    expect(collectFinished([item('fast', 'sent')], '11', page).map((entry) => entry.id)).toEqual(['fast']);
    expect(collectFinished([item('fast', 'sent')], '11', page)).toEqual([]);
  });
});

describe('storage read failure', () => {
  it('registered → getItem starts failing → the send still finishes with one balloon (last good snapshot)', () => {
    const data = new Map<string, string>();
    let readFails = false;
    const storage = { getItem: (key: string) => { if (readFails) throw new Error('SecurityError'); return data.get(key) ?? null; },
      setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: () => undefined };
    const page = access(storage as never);
    trackSend('11', 'r', META, page);
    readFails = true;
    expect(loadState('11', page).meta.r).toMatchObject(META);
    expect(collectFinished([item('r', 'sent')], '11', page).map((entry) => entry.id)).toEqual(['r']);
    expect(collectFinished([item('r', 'sent')], '11', page)).toEqual([]);
  });
});

describe('cross-tab serialization', () => {
  it('two tabs finishing the same send at once: under the lock only one announces; concurrent tracking keeps both ids', async () => {
    const storage = memory();
    trackSend('11', 'x', META, access(storage));
    let chain = Promise.resolve();
    const names: string[] = [];
    const locks = { request: <T,>(name: string, callback: () => T | Promise<T>) => {
      names.push(name);
      const run = chain.then(() => callback());
      chain = run.then(() => undefined, () => undefined);
      return run as Promise<T>;
    } };
    const [first, second] = await Promise.all([
      withFollowLock('11', () => collectFinished([item('x', 'sent')], '11', access(storage)), locks),
      withFollowLock('11', () => collectFinished([item('x', 'sent')], '11', access(storage)), locks),
    ]);
    expect(first.length + second.length).toBe(1);
    await Promise.all([withFollowLock('11', () => trackSend('11', 'y', META, access(storage)), locks),
      withFollowLock('11', () => trackSend('11', 'z', META, access(storage)), locks)]);
    expect(loadState('11', access(storage)).tracked.sort()).toEqual(['y', 'z']);
    expect(new Set(names)).toEqual(new Set(['whatsapp-my-sends.11']));
  });
});

describe('older backend endpoints mapped to the same items', () => {
  it('card send history and calendar run', () => {
    const view = { sendId: 's', orderId: 9, targetKind: 'chat' as const, chatKey: 'k', recipientLabel: 'Цех', recipientMasked: '', form: 'production_pdf' as const,
      state: 'queued', errorCode: null, cancelReason: null, createdAt: '2026-10-02T10:00:00Z', sentAt: null, actor: { id: '11', username: null } };
    expect(fromOrderSendView(view, '11'))
      .toMatchObject({ kind: 'order_send', id: 's', active: true, estimatedAt: null, title: 'Заказ #9 → в чат «Цех», PDF для производства' });
    // The order history lists every sender: another user's send is never taken.
    expect(fromOrderSendView({ ...view, actor: { id: '12', username: null } }, '11')).toBeNull();
    expect(fromBroadcastRun({ run: { id: 'r', targetDate: '2026-10-02', state: 'queued' }, messages: [] } as never))
      .toMatchObject({ kind: 'calendar_send', id: 'r', active: true, estimatedAt: null, title: 'Календарь, 02.10.2026 → чат' });
  });
});

describe('balloon, estimate and polling', () => {
  it('words each outcome', () => {
    expect(balloonFor(item('a', 'sent'))).toEqual({ type: 'success', title: 'Отправлено в WhatsApp', text: 'Заказ a → клиенту, PDF заказа' });
    expect(balloonFor(item('a', 'failed', { errorCode: 'CLIENT_NOT_ON_WHATSAPP' })).text).toContain('номера клиента нет в WhatsApp');
    expect(balloonFor(item('a', 'unknown')).title).toBe('Результат отправки неизвестен');
    expect(balloonFor(item('a', 'cancelled')).type).toBe('warning');
    expect(balloonFor(item('a', 'empty', { kind: 'calendar_send' })).title).toBe('Нечего отправлять');
    expect(balloonFor(item('a', 'unconfirmed'))).toMatchObject({ type: 'warning', title: 'Не удалось подтвердить отправку' });
  });

  it('shows the estimate in Almaty time, «сейчас» within a minute', () => {
    const now = new Date('2026-10-02T07:00:00Z');
    expect(estimateText('2026-10-02T07:45:00Z', now)).toBe('≈ 12:45');
    expect(estimateText('2026-10-02T07:00:30Z', now)).toBe('сейчас');
    expect(estimateText(null, now)).toBe('');
  });

  it('polls every 15 s while pending, every minute after recent activity, otherwise not', () => {
    const now = Date.now();
    expect(nextPollDelay([item('a', 'queued')], 0, now)).toBe(15_000);
    expect(nextPollDelay([item('a', 'sent')], now - 60_000, now)).toBe(60_000);
    expect(nextPollDelay([item('a', 'sent')], now - 31 * 60_000, now)).toBeNull();
  });
});

describe('wiring', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
  it('one tracker in the authenticated shell; the bell reads it; card and calendar register sends with an owner captured before the command', () => {
    const bell = read('../NotificationBell.tsx');
    expect(bell).toContain('useWhatsAppSends()');
    expect(bell).toContain('<MyWhatsAppSendsBlock items={whatsappSends.items} />');
    const provider = read('./WhatsAppSendsProvider.tsx');
    expect(provider).toContain('useMyWhatsAppSends()');
    expect(provider).toContain('{contextHolder}');
    expect(read('../../App.tsx')).toMatch(/<Authenticated[\s\S]*?<WhatsAppSendsProvider>\s*<VariantWorkspaceLayout \/>\s*<\/WhatsAppSendsProvider>\s*<\/Authenticated>/);
    const show = read('../../pages/orders/show.tsx');
    expect(show).toContain("onQueued: (queued) => { void announceWhatsAppSendQueued(queued.sendId, { kind: 'order_send', orderId }, owner); },");
    expect(show.indexOf('const owner = currentOwner();')).toBeLessThan(show.indexOf("announceWhatsAppSendQueued(queued.sendId"));
    expect(show).not.toContain('followOrderSend(');
    const calendar = read('../../pages/calendar/components/CalendarBoard.tsx');
    expect(calendar).toContain("onQueued: (runId) => { void announceWhatsAppSendQueued(runId, { kind: 'calendar_send' }, owner); },");
    const hook = read('./useMyWhatsAppSends.ts');
    expect(hook).toContain("placement: 'bottomRight', duration: 15, style: { opacity: 0.88 }");
    expect(hook).toContain('notification.useNotification({ maxCount: BALLOON_MAX })');
    expect(hook).toContain('if (!current()) return;');
    expect(hook).toContain('useSyncExternalStore(authSession.subscribe, authSession.getSessionGeneration');
    expect(hook).toContain("window.addEventListener('storage', onStorage);");
    expect(hook).toContain('if (legacy.current) next = await legacyItems(followed.tracked, followed.meta, userId);');
  });
});
