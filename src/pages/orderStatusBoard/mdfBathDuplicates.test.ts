import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CncTelegramBathCard, CncTelegramBathDuplicate } from '../../api/types/cncTelegramApi.types';
import {
  applyBathDuplicates,
  createEngineBathDuplicatesRefresher,
  BATH_DUPLICATE_BLOCKED_TEXT,
  bathArchiveHint,
  bathDuplicateBadgeCount,
  bathDuplicateRows,
  bathHasDuplicates,
  bathReworkBadgeCount,
  newBathDuplicateIdempotencyKey,
  otherBathTitle,
  reverseBathDuplicate,
  withLegacyBathDuplicates,
} from './mdfBathDuplicates';

const DIGEST = 'd'.repeat(64);

function entry(patch: Partial<CncTelegramBathDuplicate> = {}): CncTelegramBathDuplicate {
  return {
    otherBathCardId: 'cut-result:868', otherJobLabel: 'Раскрой №11 · Новая',
    shared: [{ orderId: 2979, detailId: 1, detailNumber: 1, here: 2, there: 2 },
      { orderId: 2979, detailId: 2, detailNumber: 2, here: 1, there: 1 }],
    sharedCount: 2, coveredBy: true, archivable: true, blockedReason: null, digest: DIGEST, resolvedAction: null,
    ...patch,
  };
}

function bath(id: number, patch: Partial<CncTelegramBathCard> = {}): CncTelegramBathCard {
  return {
    bathCardId: `cut-result:${id}`, cutJobId: id === 854 ? 10 : 11, cutResultId: id, resultNo: 1, revisionNo: 1,
    cutNumber: `${id}`, cutJobName: `Ванна ${id}`, createdAt: '2026-10-20T00:00:00Z', ready: false, orderCount: 1,
    positionCount: 2, itemQuantityTotal: 3, sheets: [],
    items: [{ bathItemId: 'i1', orderId: 2979, orderName: 'Заказ 2979', detailId: 1, detailNumber: 1, widthMm: 1,
      heightMm: 1, quantity: 2, completedQuantity: 0, ready: false, laminatedOrLater: false, packedOrLater: false }],
    ...patch,
  };
}

describe('MDF bath duplicates: badges', () => {
  it('counts the shared details of open pairs and the rework marks', () => {
    expect(bathDuplicateBadgeCount(bath(854, { duplicates: [entry()] }))).toBe(2);
    expect(bathDuplicateBadgeCount(bath(854, { duplicates: [entry({ shared: [], sharedCount: 5 })] }))).toBe(5);
    expect(bathDuplicateBadgeCount(bath(854, { duplicates: [entry({ resolvedAction: 'rework_mark' })] }))).toBe(0);
    expect(bathDuplicateBadgeCount(bath(854))).toBe(0);
    expect(bathReworkBadgeCount(bath(854, { reworkMarks: [{ otherBathCardId: 'cut-result:868', detailCount: 3 }] })))
      .toBe(3);
    expect(bathReworkBadgeCount(bath(854))).toBe(0);
    // The server union of distinct marked details wins over the per-pair counts (A–B {1,2} + A–C {3,4} = 4).
    expect(bathReworkBadgeCount(bath(854, { reworkDetailCount: 4, reworkMarks: [
      { otherBathCardId: 'cut-result:868', detailCount: 2 }, { otherBathCardId: 'cut-result:900', detailCount: 2 }] })))
      .toBe(4);
    expect(bathHasDuplicates(bath(854, { duplicates: [entry({ resolvedAction: 'rework_mark' })] }))).toBe(true);
    expect(bathHasDuplicates(bath(854, { duplicates: [] }))).toBe(false);
  });
});

describe('MDF bath duplicates: archive hint', () => {
  it('links an archivable old bath to its job in «Раскрой»', () => {
    expect(bathArchiveHint(bath(854), entry())).toEqual({ tone: 'success',
      text: 'Старая ванна полностью покрыта новой — её можно архивировать в «Раскрое».', href: '/cut?job=10' });
    expect(bathArchiveHint(bath(868), entry({ otherBathCardId: 'cut-result:854' })).text)
      .toBe('Эта ванна полностью покрыта другой — её можно архивировать в «Раскрое».');
  });

  it('explains every blocked reason in Russian and never links under the engine', () => {
    for (const reason of Object.keys(BATH_DUPLICATE_BLOCKED_TEXT) as Array<keyof typeof BATH_DUPLICATE_BLOCKED_TEXT>) {
      const hint = bathArchiveHint(bath(854), entry({ archivable: false, blockedReason: reason }));
      expect(hint.href).toBeNull();
      expect(hint.text).toMatch(/[А-Яа-яЁё]/);
    }
    expect(bathArchiveHint(bath(854), entry({ archivable: false, blockedReason: 'engine' })).text)
      .toContain('новый производственный учёт');
  });

  it('does not link a minimal engine card without its job', () => {
    expect(bathArchiveHint(bath(854, { cutJobId: 0 }), entry()).href).toBeNull();
  });
});

describe('MDF bath duplicates: engine-only re-reads', () => {
  const key = 'cut-result:900';
  const facts = (resolvedAction: 'rework_mark' | null, reworkDetailCount = 0) => [{ bathCardId: 'cut-result:900',
    duplicates: [entry({ resolvedAction })], reworkMarks: [], reworkDetailCount }];
  afterEach(() => { vi.useRealTimers(); });

  it('applies a 20 s read although the board refreshes every 15 s, never reading in parallel', async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const fetcher = (ids: string[]) => {
      expect(ids).toEqual([key]);
      calls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const answer = calls === 1 ? facts(null) : facts('rework_mark', 2);
      return new Promise<ReturnType<typeof facts>>(resolve => setTimeout(() => { running -= 1; resolve(answer); }, 20_000));
    };
    const applied: Array<{ at: number; facts: ReturnType<typeof facts> }> = [];
    const refresher = createEngineBathDuplicatesRefresher(fetcher, value => applied.push({ at: Date.now(), facts: value }));
    const start = Date.now();
    void refresher.setContext(key);
    // Same ids and revision, a new board timestamp every 15 s (each a refresh signal).
    const poll = setInterval(() => { void refresher.request(); }, 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ at: start + 20_000, facts: facts(null) });
    // The signal at 15 s became ONE follow-up read (20 → 40 s): another user's decision shows without a new revision.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(applied[1]).toMatchObject({ at: start + 40_000, facts: facts('rework_mark', 2) });
    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(poll);
    expect(maxRunning).toBe(1);
    expect(calls).toBeLessThanOrEqual(1 + 100_000 / 20_000);
    expect(bathDuplicateBadgeCount(bath(900, { duplicates: applied[1].facts[0].duplicates }))).toBe(0);
  });

  it('drops an answer for a previous id set and reads the new one', async () => {
    const pending: Array<(value: ReturnType<typeof facts>) => void> = [];
    const requested: string[][] = [];
    const applied: ReturnType<typeof facts>[] = [];
    const refresher = createEngineBathDuplicatesRefresher(ids => {
      requested.push(ids);
      return new Promise(resolve => { pending.push(resolve); });
    }, value => applied.push(value));
    const first = refresher.setContext(key);
    void refresher.setContext('cut-result:901');
    pending[0](facts(null));
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([]);
    expect(requested).toEqual([[key], ['cut-result:901']]);
    const next = [{ ...facts(null)[0], bathCardId: 'cut-result:901' }];
    pending[1](next);
    await first;
    expect(applied).toEqual([next]);
    await refresher.setContext('');
    expect(applied.at(-1)).toEqual([]);
  });

  it('keeps the shown facts after a failed read and recovers on the next signal; no read without ids', async () => {
    let fail = true;
    let calls = 0;
    const applied: ReturnType<typeof facts>[] = [];
    const refresher = createEngineBathDuplicatesRefresher(async () => {
      calls += 1;
      if (fail) throw new Error('503');
      return facts(null);
    }, value => applied.push(value));
    await refresher.request();
    expect(calls).toBe(0);
    await refresher.setContext(key);
    expect(applied).toEqual([]);
    fail = false;
    await refresher.request();
    expect(applied).toEqual([facts(null)]);
  });
});

describe('MDF bath duplicates: dialog data', () => {
  it('finds the other side of the pair on the board', () => {
    const old = bath(854, { duplicates: [entry()] });
    const next = bath(868, { duplicates: [entry({ otherBathCardId: 'cut-result:854', archivable: false,
      blockedReason: 'not_covered' })] });
    expect(reverseBathDuplicate([old, next], old, old.duplicates![0])).toMatchObject({ bath: next,
      entry: { otherBathCardId: 'cut-result:854' } });
    expect(reverseBathDuplicate([old], old, old.duplicates![0])).toBeNull();
  });

  it('builds table rows with order names and redacts the other bath title', () => {
    expect(bathDuplicateRows(bath(854), entry())).toEqual([
      { key: '2979:1', orderName: 'Заказ 2979', detailNumber: 1, here: 2, there: 2 },
      { key: '2979:2', orderName: 'Заказ 2979', detailNumber: 2, here: 1, there: 1 },
    ]);
    expect(otherBathTitle(entry({ otherJobLabel: null }))).toBe('другая ванна (нет доступа ко всем её заказам)');
    expect(otherBathTitle(entry())).toBe('Раскрой №11 · Новая');
  });

  it('makes a fresh safe idempotency key per decision', () => {
    const key = newBathDuplicateIdempotencyKey();
    expect(key).toMatch(/^[A-Za-z0-9._:-]{8,200}$/);
    expect(newBathDuplicateIdempotencyKey()).not.toBe(key);
  });

  it('applies the separately read facts only to engine baths without them (absent legacy card)', () => {
    const engineOnly = bath(900);
    const withLegacy = bath(854, { duplicates: [], reworkMarks: [] });
    const columns = [{ key: 'baths' as const, title: 'Ванны', total: 2, packets: [], bazisCutSets: [],
      baths: [engineOnly, withLegacy] }];
    const facts = { bathCardId: 'cut-result:900', duplicates: [entry()], reworkMarks: [], reworkDetailCount: 0 };
    const applied = applyBathDuplicates(columns, new Map([['cut-result:900', facts],
      ['cut-result:854', { ...facts, bathCardId: 'cut-result:854' }]]));
    expect(applied[0].baths[0]).toMatchObject({ duplicates: [entry()], reworkDetailCount: 0 });
    expect(applied[0].baths[1]).toBe(withLegacy);
    expect(applyBathDuplicates(columns, new Map())).toBe(columns);
  });

  it('copies the legacy pair facts onto the engine card of the same bath only', () => {
    const engine = bath(854);
    const legacy = bath(854, { duplicates: [entry()], reworkMarks: [] });
    expect(withLegacyBathDuplicates(engine, legacy)).toMatchObject({ duplicates: legacy.duplicates, reworkMarks: [] });
    expect(withLegacyBathDuplicates(engine, bath(868, { duplicates: [entry()] }))).toBe(engine);
    expect(withLegacyBathDuplicates(engine, bath(854))).toBe(engine);
  });
});
