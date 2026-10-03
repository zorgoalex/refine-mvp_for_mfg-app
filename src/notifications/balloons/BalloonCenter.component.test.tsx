import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { current: null as null | { id: string } },
  generation: { value: 0 },
  listeners: new Set<() => void>(),
  opened: [] as Array<{ kind: string; key: string; description: React.ReactElement; duration: number; onClick?: () => void; onClose?: () => void }>,
  destroyed: [] as string[],
  claim: vi.fn(),
  ack: vi.fn(async () => ({ acknowledged: 1 })),
  markRead: vi.fn(async () => ({})),
  navigate: vi.fn(),
}));

vi.mock('../../api/authSession', () => ({
  authSession: {
    getUser: () => mocks.user.current,
    subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
    getSessionGeneration: () => mocks.generation.value,
  },
}));
vi.mock('../../api/notificationsApi', () => ({
  notificationsApi: { claimBalloons: mocks.claim, ackBalloons: mocks.ack, markRead: mocks.markRead },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('antd', () => {
  const record = (kind: string) => (config: { key: string; description: React.ReactElement; duration: number; onClick?: () => void; onClose?: () => void }) => {
    mocks.opened.push({ kind, ...config });
  };
  const api = { info: record('info'), success: record('success'), warning: record('warning'), error: record('error'),
    destroy: (key?: string) => { mocks.destroyed.push(key ?? '*'); } };
  return { notification: { useNotification: () => [api, null] } };
});

import { BalloonCenterProvider, useBalloonCenter } from './BalloonCenter';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  notificationId: id, userId: '7', level: 'info', title: `T ${id}`, message: `M ${id}`, entityType: null, entityId: null,
  sourceType: 'e2e', sourceId: null, readAt: null, createdAt: '2026-10-03T00:00:00Z', balloonMode: 'persistent', ...extra,
});
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
/** «Отрисовать» тело балуна — как это сделает antd: монтируется компонент, срабатывает его эффект. */
const render = async (description: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(description); });
  return renderer;
};
const switchUser = async (id: string | null) => {
  await act(async () => {
    mocks.user.current = id ? { id } : null;
    mocks.generation.value += 1;
    for (const listener of mocks.listeners) listener();
  });
};

let center: ReturnType<typeof useBalloonCenter> = null;
function Probe() {
  center = useBalloonCenter();
  return null;
}

describe('BalloonCenterProvider (code review R1)', () => {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  let failStorage = false;
  let failLeaseWrite = false;
  let tree: ReactTestRenderer | null = null;

  beforeEach(() => {
    local.clear();
    session.clear();
    failStorage = false;
    failLeaseWrite = false;
    mocks.opened.length = 0;
    mocks.destroyed.length = 0;
    mocks.claim.mockReset();
    mocks.ack.mockClear();
    mocks.markRead.mockClear();
    mocks.navigate.mockClear();
    mocks.user.current = { id: '7' };
    const store = (map: Map<string, string>) => ({
      getItem: (key: string) => { if (failStorage) throw new Error('quota'); return map.get(key) ?? null; },
      setItem: (key: string, value: string) => {
        if (failStorage || (failLeaseWrite && value.includes('leasedBy'))) throw new Error('quota');
        map.set(key, value);
      },
      removeItem: (key: string) => { map.delete(key); },
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: store(local), sessionStorage: store(session) }));
    vi.stubGlobal('navigator', {});
  });
  afterEach(async () => {
    if (tree) await act(async () => { tree!.unmount(); });
    tree = null;
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    await act(async () => { tree = create(<BalloonCenterProvider><Probe /></BalloonCenterProvider>); });
    await flush();
  };

  it('acks a server balloon only after its body actually rendered; never rendered → no ack (lease returns later)', async () => {
    mocks.claim.mockResolvedValueOnce({ items: [item(ID(1)), item(ID(2))] }).mockResolvedValue({ items: [] });
    await mount();
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    expect(mocks.opened.map((o) => o.key)).toEqual([`notification-${ID(1)}`, `notification-${ID(2)}`]);
    expect(mocks.opened[0].duration).toBe(0); // persistent — только крестик
    expect(mocks.ack).not.toHaveBeenCalled();
    await render(mocks.opened[0].description);
    await flush();
    expect(mocks.ack).toHaveBeenCalledTimes(1);
    expect(mocks.ack).toHaveBeenCalledWith(expect.objectContaining({ notificationIds: [ID(1)] }));
  });

  it('a delayed claim of the previous session does not touch the new session (reserve, display)', async () => {
    const first = deferred<{ items: unknown[] }>();
    mocks.claim.mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ items: [item(ID(3))] })
      .mockResolvedValue({ items: [] });
    await mount();
    await switchUser('8');
    await flush();
    expect(mocks.opened.map((o) => o.key)).toEqual([`notification-${ID(3)}`]);
    await act(async () => { first.resolve({ items: [item(ID(4))] }); await first.promise; });
    await flush();
    expect(mocks.opened.map((o) => o.key)).toEqual([`notification-${ID(3)}`]); // ответ прежней сессии не показан
    // Резерв новой сессии цел: следующий claim — на 4 свободных места (5 − 1 открытый).
    await act(async () => { await center!.enqueueLocal('8', []); });
    await act(async () => { await center!.enqueueLocal('8', [{ key: 'w-1', kind: 'success', title: 'W', text: 'ok', mode: 'auto' }]); });
    await flush();
    const lastClaim = mocks.claim.mock.calls[mocks.claim.mock.calls.length - 1][0];
    expect(lastClaim.limit).toBe(3); // 5 − уведомление − WhatsApp
  });

  it('click: marks read, opens the order, closes the balloon', async () => {
    mocks.claim.mockResolvedValueOnce({ items: [item(ID(5), { entityType: 'order', entityId: '42' })] }).mockResolvedValue({ items: [] });
    await mount();
    await act(async () => { mocks.opened[0].onClick!(); });
    await flush();
    expect(mocks.markRead).toHaveBeenCalledWith(ID(5));
    expect(mocks.navigate).toHaveBeenCalledWith('/orders/show/42');
    expect(mocks.destroyed).toContain(`notification-${ID(5)}`);
  });

  it('local balloons: accepted keys returned; storage failure falls back to memory and still shows', async () => {
    mocks.claim.mockResolvedValue({ items: [] });
    await mount();
    let accepted: string[] = [];
    await act(async () => { accepted = await center!.enqueueLocal('7', [{ key: 'w-1', kind: 'success', title: 'W', text: 'ok', mode: 'auto' }]); });
    await flush();
    expect(accepted).toEqual(['w-1']);
    expect(mocks.opened.map((o) => o.key)).toContain('w-1');
    expect(mocks.opened.find((o) => o.key === 'w-1')!.duration).toBe(15);
    failStorage = true;
    await act(async () => { accepted = await center!.enqueueLocal('7', [{ key: 'w-2', kind: 'error', title: 'W2', text: 'fail', mode: 'auto' }]); });
    await flush();
    expect(accepted).toEqual(['w-2']);
    expect(mocks.opened.map((o) => o.key)).toContain('w-2');
  });

  it('R2-1: the same lease claimed twice before the body mounted → no ack until it mounts', async () => {
    mocks.claim.mockResolvedValueOnce({ items: [item(ID(6))] }).mockResolvedValueOnce({ items: [item(ID(6))] }).mockResolvedValue({ items: [] });
    await mount();
    await act(async () => { await center!.enqueueLocal('7', [{ key: 'w-x', kind: 'info', title: 'x', text: 'x', mode: 'auto' }]); });
    await flush();
    expect(mocks.claim.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.ack).not.toHaveBeenCalled();
    await render(mocks.opened.find((o) => o.key === `notification-${ID(6)}`)!.description);
    await flush();
    expect(mocks.ack).toHaveBeenCalledTimes(1);
  });

  it('R2-3: enqueue succeeded but writing the lease fails (quota) → shown from the memory snapshot', async () => {
    mocks.claim.mockResolvedValue({ items: [] });
    await mount();
    failLeaseWrite = true;
    let accepted: string[] = [];
    await act(async () => { accepted = await center!.enqueueLocal('7', [{ key: 'w-q', kind: 'success', title: 'Q', text: 'q', mode: 'auto' }]); });
    await flush();
    expect(accepted).toEqual(['w-q']);
    expect(mocks.opened.filter((o) => o.key === 'w-q')).toHaveLength(1);
    await act(async () => { await center!.enqueueLocal('7', []); });
    await flush();
    expect(mocks.opened.filter((o) => o.key === 'w-q')).toHaveLength(1); // без дублей во вкладке
  });

  it('R3-1: six balloons, lease write fails → five shown from memory → writes recover → closes: every key shown exactly once', async () => {
    mocks.claim.mockResolvedValue({ items: [] });
    await mount();
    failLeaseWrite = true;
    const six = Array.from({ length: 6 }, (_, i) => ({ key: `w-${i}`, kind: 'success' as const, title: `W${i}`, text: 'ok', mode: 'persistent' as const }));
    await act(async () => { await center!.enqueueLocal('7', six); });
    await flush();
    expect(mocks.opened.map((o) => o.key)).toEqual(['w-0', 'w-1', 'w-2', 'w-3', 'w-4']);
    for (const opened of [...mocks.opened]) { (opened as { rendered?: boolean }).rendered = true; await render(opened.description); }
    await flush();
    failLeaseWrite = false; // запись восстановилась
    // Закрыть балуны по одному (реальный триггер насоса — onClose) и отрисовать вновь открытые.
    for (let round = 0; round < 6; round += 1) {
      const openNow = mocks.opened.filter((o) => !(o as { closed?: boolean }).closed);
      const target = openNow[0];
      if (!target) break;
      (target as { closed?: boolean }).closed = true;
      await act(async () => { target.onClose!(); });
      await flush();
      for (const opened of mocks.opened.filter((o) => !(o as { rendered?: boolean }).rendered)) {
        (opened as { rendered?: boolean }).rendered = true;
        await render(opened.description);
      }
      await flush();
    }
    const counts = new Map<string, number>();
    for (const opened of mocks.opened) counts.set(opened.key, (counts.get(opened.key) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(['w-0', 'w-1', 'w-2', 'w-3', 'w-4', 'w-5']);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
  });
});
