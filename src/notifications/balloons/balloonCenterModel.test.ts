import { describe, expect, it } from 'vitest';
import {
  BalloonSlots, LOCAL_LEASE_MS, MAX_QUEUE_ITEMS, confirmShown, durationFor, enqueue, leaseForDisplay, pendingCount, tabToken, withBalloonLock,
  type LocalBalloon, type LockManagerLike, type StorageLike,
} from './balloonCenterModel';

const memory = (): StorageLike & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };
};
const balloon = (key: string): LocalBalloon => ({ key, kind: 'success', title: key, text: 'готово', mode: 'auto' });

/** Фейковые Web Locks: запросы одного имени выполняются строго по очереди (как в браузере). */
function fakeLocks(): LockManagerLike {
  const chains = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
      const previous = chains.get(name) ?? Promise.resolve();
      const next = previous.then(() => callback());
      chains.set(name, next.catch(() => undefined));
      return next;
    },
  };
}

describe('balloon slots (R1-1, R3-2)', () => {
  it('six persistent balloons: five open, the sixth waits; closing one frees a place', () => {
    const slots = new BalloonSlots();
    const opened = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => slots.openBalloon(key));
    expect(opened).toEqual([true, true, true, true, true, false]);
    slots.close('a');
    expect(slots.openBalloon('f')).toBe(true);
    expect(slots.openCount).toBe(5);
  });

  it('places reserved for a claim in flight are not given to the local queue; unused reserve is released', () => {
    const slots = new BalloonSlots();
    for (const key of ['a', 'b', 'c', 'd']) slots.openBalloon(key);
    expect(slots.reserve(5)).toBe(1); // одно свободное место — в резерв до ответа сервера
    expect(slots.free()).toBe(0);
    expect(slots.openBalloon('whatsapp')).toBe(false); // WhatsApp пришёл во время запроса — ждёт
    expect(slots.openBalloon('server', true)).toBe(true); // ответ сервера занимает своё место
    slots.release(slots.reserved);
    expect(slots.openCount).toBe(5);
    expect(slots.reserve(1)).toBe(0);
  });

  it('durations: auto 15 s, persistent 0 (only the cross)', () => {
    expect(durationFor('auto')).toBe(15);
    expect(durationFor('persistent')).toBe(0);
  });
});

describe('durable local queue (R2-2, code review R1-1/R1-3)', () => {
  const take = (storage: StorageLike, count: number, token = 'tab-1', now = Date.now()) => {
    const leased = leaseForDisplay('7', count, token, storage, now);
    confirmShown('7', leased.map((b) => b.key), storage, now);
    return leased.map((b) => b.key);
  };

  it('enqueue is idempotent by key and returns accepted keys; a shown key is not queued again', () => {
    const storage = memory();
    expect(enqueue('7', [balloon('w-1'), balloon('w-2')], storage)).toEqual(['w-1', 'w-2']);
    expect(enqueue('7', [balloon('w-1')], storage)).toEqual(['w-1']);
    expect(pendingCount('7', storage)).toBe(2);
    expect(take(storage, 1)).toEqual(['w-1']);
    expect(enqueue('7', [balloon('w-1')], storage)).toEqual(['w-1']);
    expect(pendingCount('7', storage)).toBe(1);
  });

  it('a full queue never evicts waiting balloons: new ones are not accepted (the source keeps and retries them)', () => {
    const storage = memory();
    enqueue('7', Array.from({ length: MAX_QUEUE_ITEMS }, (_, i) => balloon(`w-${i}`)), storage);
    expect(enqueue('7', [balloon('late')], storage)).toEqual([]);
    expect(pendingCount('7', storage)).toBe(MAX_QUEUE_ITEMS);
    expect(take(storage, 1)).toEqual(['w-0']);
    expect(enqueue('7', [balloon('late')], storage)).toEqual(['late']);
  });

  it('leased but not confirmed (tab died before the balloon rendered) → stays queued; own token re-leases at once, others after expiry', () => {
    const storage = memory();
    enqueue('7', [balloon('a')], storage);
    const now = 1_000_000;
    expect(leaseForDisplay('7', 5, 'tab-1', storage, now).map((b) => b.key)).toEqual(['a']);
    expect(pendingCount('7', storage, now)).toBe(1);
    expect(leaseForDisplay('7', 5, 'tab-2', storage, now + 1000)).toEqual([]);
    expect(leaseForDisplay('7', 5, 'tab-1', storage, now + 1000).map((b) => b.key)).toEqual(['a']);
    expect(leaseForDisplay('7', 5, 'tab-2', storage, now + 1000 + LOCAL_LEASE_MS).map((b) => b.key)).toEqual(['a']);
    confirmShown('7', ['a'], storage, now + 1000 + LOCAL_LEASE_MS);
    expect(pendingCount('7', storage)).toBe(0);
  });

  it('five persistent open → WhatsApp finishes → reload before a place frees → shown exactly once later', () => {
    const storage = memory();
    let slots = new BalloonSlots();
    for (const key of ['p1', 'p2', 'p3', 'p4', 'p5']) slots.openBalloon(key);
    enqueue('7', [balloon('whatsapp-send-1')], storage);
    expect(leaseForDisplay('7', slots.free(), 'tab-1', storage)).toEqual([]);
    slots = new BalloonSlots(); // перезагрузка вкладки
    expect(take(storage, slots.free())).toEqual(['whatsapp-send-1']);
    expect(take(storage, 5)).toEqual([]);
  });

  it('two tabs leasing under the shared lock with interleaved requests get disjoint balloons', async () => {
    const storage = memory();
    const locks = fakeLocks();
    enqueue('7', [balloon('a'), balloon('b'), balloon('c')], storage);
    const tab = (token: string) => withBalloonLock('7', async () => {
      await Promise.resolve();
      return leaseForDisplay('7', 2, token, storage).map((b) => b.key);
    }, locks);
    const [one, two] = await Promise.all([tab('t1'), tab('t2')]);
    expect([...one, ...two].sort()).toEqual(['a', 'b', 'c']);
  });

  it('queues are per user', () => {
    const storage = memory();
    enqueue('7', [balloon('a')], storage);
    expect(leaseForDisplay('8', 5, 'tab-1', storage)).toEqual([]);
    expect(pendingCount('7', storage)).toBe(1);
  });
});

describe('tab token', () => {
  it('survives a reload of the tab (sessionStorage), per user; storage failure → fresh id', () => {
    const session = memory();
    let n = 0;
    const id = () => `00000000-0000-4000-8000-00000000000${++n}`;
    const first = tabToken('7', session, id);
    expect(tabToken('7', session, id)).toBe(first);
    expect(tabToken('8', session, id)).not.toBe(first);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined };
    expect(tabToken('7', broken, id)).toMatch(/^0{8}-/);
  });
});
