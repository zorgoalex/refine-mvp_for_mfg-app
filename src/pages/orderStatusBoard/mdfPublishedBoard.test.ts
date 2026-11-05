import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  MdfPublishedCard,
  MdfPublishedSnapshot,
} from '../../api/types/mdfPublishedApi.types';
import * as mdfPublishedBoardExports from './mdfPublishedBoard';
import {
  buildMdfPublishedBoardCard,
  buildMdfPublishedBoardCards,
  buildMdfUnregisteredLane,
  filterMdfPublishedCardsByOrderNames,
  filterMdfPublishedCardsByText,
  groupMdfPublishedBoardCardsByColumn,
  indexMdfPublishedPositions,
  mdfBoardIssueText,
  mdfPublishedCardCommandDisabledReason,
  planMdfPublishedSearchOrderIds,
} from './mdfPublishedBoard';

const READY_TOKEN = 'a'.repeat(64);

function card(overrides: Partial<MdfPublishedCard> = {}): MdfPublishedCard {
  const id = overrides.id ?? 'card-1';
  return {
    kind: 'packet',
    id,
    displayName: `Карточка ${id}`,
    column: 'completed',
    sourceCreatedAt: '2026-09-15T00:00:00.000Z',
    acceptedRevision: 'rev-1',
    receivedRevision: 'rev-1',
    commandToken: READY_TOKEN,
    issues: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<MdfPublishedSnapshot> = {}): MdfPublishedSnapshot {
  return {
    schemaVersion: 1,
    mode: 'active',
    revision: 'rev-1',
    generatedAt: '2026-09-27T00:00:00.000Z',
    dateFrom: '2026-07-27',
    dateTo: '2026-09-27',
    cards: [card()],
    members: [],
    positions: [],
    pendingJobs: [],
    trackedJobs: [],
    presentation: [],
    progress: [],
    orders: [],
    unregistered: [],
    issues: [],
    ...overrides,
  };
}

describe('buildMdfPublishedBoardCard: stale vs fresh presentation', () => {
  it('renders a full card when the composition binding is present (not stale)', () => {
    const snap = snapshot({
      members: [{ kind: 'packet', id: 'card-1', orderId: 10, detailId: 100, quantity: 6 }],
      orders: [{ orderId: 10, orderName: 'E2E-Тест 100' }],
      presentation: [{
        kind: 'packet', id: 'card-1', stale: false,
        composition: {
          items: [{ orderId: 10, detailId: 100, detailNumber: 1, widthMm: 500, heightMm: 300, quantity: 6 }],
          programName: 'Program_1.dxf', externalKey: 'EXT-1', materialName: 'МДФ 16', hasSheetImage: true,
        },
        live: { comments: ['готово'], rework: false, thumbsUp: true, completionStatus: 'done' },
      }],
    });
    const view = buildMdfPublishedBoardCard(snap, snap.cards[0]!, true);
    expect(view.stale).toBe(false);
    expect(view.staleNote).toBeNull();
    expect(view.title).toBe('Program_1.dxf');
    expect(view.items).toEqual([{
      orderId: 10, orderName: 'E2E-Тест 100', detailId: 100, detailNumber: 1,
      widthMm: 500, heightMm: 300, quantity: 6, cut: 0, laminated: 0,
    }]);
    expect(view.materialName).toBe('МДФ 16');
    expect(view.hasSheetImage).toBe(true);
    expect(view.comments).toEqual(['готово']);
    expect(view.orderNames).toEqual(['E2E-Тест 100']);
    // §5.6 finding 8: membership + this card's own progress is always available too.
    expect(view.memberQuantities).toEqual([
      { orderId: 10, orderName: 'E2E-Тест 100', detailId: 100, quantity: 6, cut: 0, laminated: 0 },
    ]);
  });

  it('renders a minimal card when presentation.stale is true', () => {
    const snap = snapshot({
      members: [{ kind: 'packet', id: 'card-1', orderId: 10, detailId: 100, quantity: 6 }],
      orders: [{ orderId: 10, orderName: 'E2E-Тест 100' }],
      progress: [{ kind: 'packet', id: 'card-1', orderId: 10, detailId: 100, member: 6, cut: 3, laminated: 1 }],
      presentation: [{
        kind: 'packet', id: 'card-1', stale: true, composition: null,
        live: { comments: ['x'] },
      }],
    });
    const view = buildMdfPublishedBoardCard(snap, snap.cards[0]!, true);
    expect(view.stale).toBe(true);
    expect(view.staleNote).toBe('данные файла изменились — ожидает пересчёта');
    expect(view.items).toEqual([]);
    // Minimal card still shows visible order names and member quantities WITH progress
    // (§5.6 finding 8 — memberQuantities/progress must render for a stale card, not just the
    // warning note).
    expect(view.orderNames).toEqual(['E2E-Тест 100']);
    expect(view.memberQuantities).toEqual([
      { orderId: 10, orderName: 'E2E-Тест 100', detailId: 100, quantity: 6, cut: 3, laminated: 1 },
    ]);
    // Live annotations are current-row values, independent of the composition binding.
    expect(view.comments).toEqual(['x']);
  });

  it('renders a minimal card when there is no presentation entry at all', () => {
    const snap = snapshot({
      members: [{ kind: 'packet', id: 'card-1', orderId: 10, detailId: 100, quantity: 6 }],
      orders: [{ orderId: 10, orderName: 'E2E-Тест 100' }],
      presentation: [],
    });
    const view = buildMdfPublishedBoardCard(snap, snap.cards[0]!, true);
    expect(view.stale).toBe(true);
    expect(view.title).toBe('Карточка card-1');
    expect(view.memberQuantities).toEqual([
      { orderId: 10, orderName: 'E2E-Тест 100', detailId: 100, quantity: 6, cut: 0, laminated: 0 },
    ]);
  });
});

describe('buildMdfPublishedBoardCard: progress per card vs position totals', () => {
  it('split packets A/B (6/4 of a 10-unit position, only A cut): A shows 6/6, B shows 0/4, position stays 6/10', () => {
    const cardA = card({ kind: 'packet', id: 'packet-a' });
    const cardB = card({ kind: 'packet', id: 'packet-b' });
    const snap = snapshot({
      cards: [cardA, cardB],
      orders: [{ orderId: 10, orderName: 'Заказ 10' }],
      members: [
        { kind: 'packet', id: 'packet-a', orderId: 10, detailId: 100, quantity: 6 },
        { kind: 'packet', id: 'packet-b', orderId: 10, detailId: 100, quantity: 4 },
      ],
      positions: [{ orderId: 10, detailId: 100, required: 10, cut: 6, rolled: 0, creditedCut: 6, creditedRolled: 0, remaining: 4, issues: [] }],
      progress: [
        { kind: 'packet', id: 'packet-a', orderId: 10, detailId: 100, member: 6, cut: 6, laminated: 0 },
        { kind: 'packet', id: 'packet-b', orderId: 10, detailId: 100, member: 4, cut: 0, laminated: 0 },
      ],
      presentation: [
        { kind: 'packet', id: 'packet-a', stale: false, composition: { items: [{ orderId: 10, detailId: 100, detailNumber: 1, widthMm: 500, heightMm: 300, quantity: 6 }] }, live: null },
        { kind: 'packet', id: 'packet-b', stale: false, composition: { items: [{ orderId: 10, detailId: 100, detailNumber: 1, widthMm: 500, heightMm: 300, quantity: 4 }] }, live: null },
      ],
    });
    const viewA = buildMdfPublishedBoardCard(snap, cardA, true);
    const viewB = buildMdfPublishedBoardCard(snap, cardB, true);
    expect(viewA.items[0]).toMatchObject({ quantity: 6, cut: 6, laminated: 0 });
    expect(viewB.items[0]).toMatchObject({ quantity: 4, cut: 0, laminated: 0 });

    const positions = indexMdfPublishedPositions(snap);
    expect(positions.get('10:100')).toMatchObject({ required: 10, cut: 6, remaining: 4 });

    // §5.6 finding 8: whole-position totals are the SAME snapshot truth on both cards — never
    // summed/doubled because two cards reference the same position.
    expect(viewA.positions).toEqual([
      { orderId: 10, orderName: 'Заказ 10', detailId: 100, required: 10, creditedCut: 6, creditedRolled: 0, remaining: 4 },
    ]);
    expect(viewB.positions).toEqual(viewA.positions);
  });
});

describe('buildMdfPublishedBoardCard: finding 7 — per-position progress, not per raw item', () => {
  it('aggregates two raw packet rows (qty 3 each) of one 6-unit detail into a single row, quantity 6, progress once', () => {
    const packet = card({ kind: 'packet', id: 'packet-1' });
    const snap = snapshot({
      cards: [packet],
      orders: [{ orderId: 10, orderName: 'Заказ 10' }],
      members: [{ kind: 'packet', id: 'packet-1', orderId: 10, detailId: 100, quantity: 6 }],
      progress: [{ kind: 'packet', id: 'packet-1', orderId: 10, detailId: 100, member: 6, cut: 6, laminated: 0 }],
      presentation: [{
        kind: 'packet', id: 'packet-1', stale: false,
        composition: {
          items: [
            { orderId: 10, detailId: 100, detailNumber: 1, widthMm: 500, heightMm: 300, quantity: 3 },
            { orderId: 10, detailId: 100, detailNumber: 1, widthMm: 500, heightMm: 300, quantity: 3 },
          ],
        },
        live: null,
      }],
    });
    const view = buildMdfPublishedBoardCard(snap, packet, true);
    // One row, not two; summed quantity; progress shown once (not repeated per raw row).
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ orderId: 10, detailId: 100, quantity: 6, cut: 6, laminated: 0 });
  });

  it('keeps rows with a null detailId distinct (cannot be attributed to an accounting position)', () => {
    const packet = card({ kind: 'packet', id: 'packet-1' });
    const snap = snapshot({
      cards: [packet],
      presentation: [{
        kind: 'packet', id: 'packet-1', stale: false,
        composition: {
          items: [
            { orderId: 10, detailId: null, detailNumber: null, widthMm: 100, heightMm: 100, quantity: 1 },
            { orderId: 10, detailId: null, detailNumber: null, widthMm: 200, heightMm: 200, quantity: 2 },
          ],
        },
        live: null,
      }],
    });
    const view = buildMdfPublishedBoardCard(snap, packet, true);
    expect(view.items).toHaveLength(2);
  });
});

describe('buildMdfPublishedBoardCard: finding 8 — bath cards without composition items', () => {
  it('shows members + laminated progress for a bath card even with an empty composition items list', () => {
    const bath = card({ kind: 'bath', id: 'bath-1', column: 'baths' });
    const snap = snapshot({
      cards: [bath],
      orders: [{ orderId: 20, orderName: 'Заказ 20' }],
      members: [{ kind: 'bath', id: 'bath-1', orderId: 20, detailId: 200, quantity: 5 }],
      progress: [{ kind: 'bath', id: 'bath-1', orderId: 20, detailId: 200, member: 5, cut: 5, laminated: 2 }],
      presentation: [{
        kind: 'bath', id: 'bath-1', stale: false,
        composition: { items: [], cutJobName: 'Job-1', resultNo: 3 },
        live: null,
      }],
    });
    const view = buildMdfPublishedBoardCard(snap, bath, true);
    expect(view.stale).toBe(false);
    expect(view.items).toEqual([]);
    expect(view.memberQuantities).toEqual([
      { orderId: 20, orderName: 'Заказ 20', detailId: 200, quantity: 5, cut: 5, laminated: 2 },
    ]);
  });
});

describe('buildMdfPublishedBoardCard: retained facts on an empty/emptied card (§5.2/D3)', () => {
  it('an empty BASIS card with retained progress shows position totals and its orderIds, without adding to memberQuantities', () => {
    const setCard = card({ kind: 'bazisCutSet', id: 'basis-empty' });
    const snap = snapshot({
      cards: [setCard],
      orders: [{ orderId: 10, orderName: 'Заказ 10' }],
      members: [], // intentionally empty: the authorized assignment was emptied, no current membership
      progress: [{ kind: 'bazisCutSet', id: 'basis-empty', orderId: 10, detailId: 100, member: 0, cut: 8, laminated: 0 }],
      positions: [{ orderId: 10, detailId: 100, required: 10, cut: 8, rolled: 0, creditedCut: 8, creditedRolled: 0, remaining: 2, issues: [] }],
      presentation: [{ kind: 'bazisCutSet', id: 'basis-empty', stale: false, composition: { items: [] }, live: null }],
    });
    const view = buildMdfPublishedBoardCard(snap, setCard, true);
    // Never fed into commands/membership.
    expect(view.memberQuantities).toEqual([]);
    // But the retained authorized production counters and owner association still show.
    expect(view.positions).toEqual([
      { orderId: 10, orderName: 'Заказ 10', detailId: 100, required: 10, creditedCut: 8, creditedRolled: 0, remaining: 2 },
    ]);
    expect(view.orderIds).toEqual([10]);
    expect(view.orderNames).toEqual(['Заказ 10']);
  });

  it('does not retain a zero-progress position (never authorized, nothing to show)', () => {
    const setCard = card({ kind: 'bazisCutSet', id: 'basis-empty-2' });
    const snap = snapshot({
      cards: [setCard],
      orders: [{ orderId: 11, orderName: 'Заказ 11' }],
      members: [],
      progress: [{ kind: 'bazisCutSet', id: 'basis-empty-2', orderId: 11, detailId: 110, member: 0, cut: 0, laminated: 0 }],
      presentation: [{ kind: 'bazisCutSet', id: 'basis-empty-2', stale: false, composition: { items: [] }, live: null }],
    });
    const view = buildMdfPublishedBoardCard(snap, setCard, true);
    expect(view.positions).toEqual([]);
    expect(view.orderIds).toEqual([]);
  });
});

describe('mdfBoardIssueText', () => {
  it('maps known codes to Russian text', () => {
    expect(mdfBoardIssueText('MDF_PARTIAL_ACCESS')).toBe('Есть заказы, к которым у вас нет доступа');
    expect(mdfBoardIssueText('MEMBER_OUTSIDE_LIVE_MDF_DEMAND')).toContain('потребностью');
    expect(mdfBoardIssueText('LINEAGE_INVALID')).toContain('происхождения');
    expect(mdfBoardIssueText('ALLOCATION_BASELINE_UNKNOWN')).toContain('распределения');
    expect(mdfBoardIssueText('MDF_ALLOCATION_UNVERIFIED')).toContain('не подтверждено');
    expect(mdfBoardIssueText('PLACEMENT_UNKNOWN')).toContain('колонку');
    expect(mdfBoardIssueText('MDF_DEMAND_CHANGED')).toContain('изменилась');
    expect(mdfBoardIssueText('MDF_MOVE_PERMISSION_DENIED')).toBe('Нет права менять производственные этапы');
  });
  it('shows an unknown code verbatim', () => {
    expect(mdfBoardIssueText('SOME_NEW_CODE')).toBe('SOME_NEW_CODE');
  });
});

describe('card issues / requires-attention badge', () => {
  it('flags requiresAttention from card.issues with Russian reasons', () => {
    const snap = snapshot({ cards: [card({ issues: ['MDF_PARTIAL_ACCESS'] })] });
    const view = buildMdfPublishedBoardCard(snap, snap.cards[0]!, true);
    expect(view.requiresAttention).toBe(true);
    expect(view.issueTexts).toEqual(['Есть заказы, к которым у вас нет доступа']);
  });

  it('flags requiresAttention from a tracked/pending job with status needs_attention', () => {
    const snap = snapshot({
      pendingJobs: [{ jobId: 'j1', kind: 'packet', id: 'card-1', status: 'needs_attention', code: 'LINEAGE_INVALID', attempts: 1, orderIds: [] }],
    });
    const view = buildMdfPublishedBoardCard(snap, snap.cards[0]!, true);
    expect(view.requiresAttention).toBe(true);
    expect(view.issueTexts).toContain('Нарушена цепочка происхождения физического подтверждения');
  });

  it('shows "Обрабатывается" for a plain pending job without requiring the attention badge', () => {
    const snap = snapshot({
      cards: [card({ issues: [] })],
      pendingJobs: [{ jobId: 'j1', kind: 'packet', id: 'card-1', status: 'pending', code: null, attempts: 1, orderIds: [] }],
    });
    const view = buildMdfPublishedBoardCard(snap, snap.cards[0]!, true);
    expect(view.pendingNote).toBe('Обрабатывается');
    expect(view.requiresAttention).toBe(false);
  });
});

describe('mdfPublishedCardCommandDisabledReason', () => {
  it('is null (enabled) for a fully ready active card with the move permission', () => {
    const snap = snapshot();
    expect(mdfPublishedCardCommandDisabledReason(snap, snap.cards[0]!, true)).toBeNull();
  });

  it('disables commands in read_only mode with a reason', () => {
    const snap = snapshot({ mode: 'read_only', issues: ['MDF_READ_ONLY'] });
    expect(mdfPublishedCardCommandDisabledReason(snap, snap.cards[0]!, true))
      .toBe('Производственный учёт в режиме только чтения — перемещение недоступно');
  });

  it('disables commands when commandToken is null', () => {
    const snap = snapshot({ cards: [card({ commandToken: null })] });
    expect(mdfPublishedCardCommandDisabledReason(snap, snap.cards[0]!, true))
      .toBe('Не удалось получить подтверждение карточки — обновите доску');
  });

  it('disables commands when the card has issues', () => {
    const snap = snapshot({ cards: [card({ issues: ['MDF_PARTIAL_ACCESS'] })] });
    expect(mdfPublishedCardCommandDisabledReason(snap, snap.cards[0]!, true))
      .toBe('Есть заказы, к которым у вас нет доступа');
  });

  // §5.6 finding 9: literal permission check, separate from (and checked before) readiness.
  it('disables commands with a permission-specific reason when the user lacks production.tasks.update, even on an otherwise fully ready card', () => {
    const snap = snapshot();
    expect(mdfPublishedCardCommandDisabledReason(snap, snap.cards[0]!, false))
      .toBe('Нет права менять производственные этапы');
  });

  it('shows the permission reason even when other readiness reasons would also apply', () => {
    const snap = snapshot({ mode: 'read_only', issues: ['MDF_READ_ONLY'] });
    expect(mdfPublishedCardCommandDisabledReason(snap, snap.cards[0]!, false))
      .toBe('Нет права менять производственные этапы');
  });
});

describe('buildMdfUnregisteredLane', () => {
  it('maps unregistered sources with resolved order names', () => {
    const snap = snapshot({
      orders: [{ orderId: 5, orderName: 'Заказ 5' }],
      unregistered: [{ kind: 'packet', id: 'u1', displayName: 'raw_file.dxf', sourceCreatedAt: '2026-09-20T00:00:00.000Z', orderIds: [5] }],
    });
    expect(buildMdfUnregisteredLane(snap)).toEqual([
      { kind: 'packet', id: 'u1', displayName: 'raw_file.dxf', sourceCreatedAt: '2026-09-20T00:00:00.000Z', orderNames: ['Заказ 5'] },
    ]);
  });
});

describe('groupMdfPublishedBoardCardsByColumn', () => {
  it('groups by column, falling back to "unknown" for a null column', () => {
    const cards = buildMdfPublishedBoardCards(snapshot({
      cards: [card({ id: 'a', column: 'completed' }), card({ id: 'b', column: null })],
    }), true);
    const grouped = groupMdfPublishedBoardCardsByColumn(cards);
    expect(grouped.get('completed')?.map((c) => c.id)).toEqual(['a']);
    expect(grouped.get('unknown')?.map((c) => c.id)).toEqual(['b']);
  });
});


describe('visibility filters', () => {
  const cards = buildMdfPublishedBoardCards(snapshot({
    cards: [
      card({ id: 'a', sourceCreatedAt: '2026-09-27T00:00:00.000Z' }),
      card({ id: 'b', sourceCreatedAt: '2026-08-01T00:00:00.000Z' }),
    ],
    orders: [{ orderId: 10, orderName: 'Заказ 10' }],
    members: [
      { kind: 'packet', id: 'a', orderId: 10, detailId: 100, quantity: 1 },
    ],
  }), true);

  it('filterMdfPublishedCardsByOrderNames keeps only cards with a matching order', () => {
    expect(filterMdfPublishedCardsByOrderNames(cards, ['Заказ 10']).map((c) => c.id)).toEqual(['a']);
    expect(filterMdfPublishedCardsByOrderNames(cards, []).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('filterMdfPublishedCardsByText matches title/id/order name', () => {
    expect(filterMdfPublishedCardsByText(cards, 'card-1').length).toBe(0);
    expect(filterMdfPublishedCardsByText(cards, 'a').map((c) => c.id)).toContain('a');
    expect(filterMdfPublishedCardsByText(cards, '').length).toBe(2);
  });
});

describe('§5.8/D2: no client-side period re-filter — the backend display cut is the only filter', () => {
  // Source-text guards (this module has no jsdom/React harness; see repo convention): a client-side
  // `filterMdfPublishedCardsByPeriod` re-filtering the already-loaded window previously hid cards the
  // backend's own display cut had legitimately admitted (workday vs. sourceCreatedAt mismatch).
  const boardModule = readFileSync(new URL('./mdfPublishedBoard.ts', import.meta.url), 'utf8');
  const viewModule = readFileSync(new URL('./MdfPublishedBoardView.tsx', import.meta.url), 'utf8');

  it('mdfPublishedBoard.ts no longer defines or exports a period filter function', () => {
    expect(boardModule).not.toContain('filterMdfPublishedCardsByPeriod');
    expect((mdfPublishedBoardExports as Record<string, unknown>).filterMdfPublishedCardsByPeriod).toBeUndefined();
  });

  it('MdfPublishedBoardView no longer applies a period filter to the visible cards', () => {
    expect(viewModule).not.toContain('filterMdfPublishedCardsByPeriod');
    expect(viewModule).not.toContain('periodExemptions');
  });
});

describe('planMdfPublishedSearchOrderIds (§5.6 finding 6)', () => {
  it('still plans a searchOrderIds request for an order name already known (has one recent card) — a known order can still have older cards outside the window', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: ['Заказ 10'],
      knownOrders: [{ orderId: 10, orderName: 'Заказ 10' }],
      currentSearchOrderIds: [],
      resolvedOrderIds: new Map(),
    });
    expect(plan.namesNeedingResolution).toEqual([]);
    expect(plan.nextSearchOrderIds).toEqual([10]);
  });

  it('does not re-request a known order id already in currentSearchOrderIds (no-op)', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: ['Заказ 10'],
      knownOrders: [{ orderId: 10, orderName: 'Заказ 10' }],
      currentSearchOrderIds: [10],
      resolvedOrderIds: new Map(),
    });
    expect(plan).toEqual({ namesNeedingResolution: [], nextSearchOrderIds: null });
  });

  it('flags a name needing resolution when absent and not yet looked up', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: ['Заказ 999'],
      knownOrders: [],
      currentSearchOrderIds: [],
      resolvedOrderIds: new Map(),
    });
    expect(plan.namesNeedingResolution).toEqual(['Заказ 999']);
    expect(plan.nextSearchOrderIds).toBeNull();
  });

  it('produces a searchOrderIds request plan once the name resolves to an order id', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: ['Заказ 999'],
      knownOrders: [],
      currentSearchOrderIds: [],
      resolvedOrderIds: new Map([['заказ 999', 999]]),
    });
    expect(plan.nextSearchOrderIds).toEqual([999]);
  });

  it('does not re-plan an id already in currentSearchOrderIds (no-op)', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: ['Заказ 999'],
      knownOrders: [],
      currentSearchOrderIds: [999],
      resolvedOrderIds: new Map([['заказ 999', 999]]),
    });
    expect(plan.nextSearchOrderIds).toBeNull();
  });

  // §5.6 R2#2: replace, never union with the past selection.
  it('clears searchOrderIds to [] when the selection is emptied entirely', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: [],
      knownOrders: [{ orderId: 10, orderName: 'Заказ 10' }],
      currentSearchOrderIds: [10],
      resolvedOrderIds: new Map(),
    });
    expect(plan.nextSearchOrderIds).toEqual([]);
  });

  it('drops a removed order id — result reflects ONLY the current selection, not the union with the past one', () => {
    const plan = planMdfPublishedSearchOrderIds({
      // Only 'Заказ 10' remains selected; 'Заказ 20' (previously searched) was removed.
      requestedOrderNames: ['Заказ 10'],
      knownOrders: [
        { orderId: 10, orderName: 'Заказ 10' },
        { orderId: 20, orderName: 'Заказ 20' },
      ],
      currentSearchOrderIds: [10, 20],
      resolvedOrderIds: new Map(),
    });
    expect(plan.nextSearchOrderIds).toEqual([10]);
  });

  it('is a no-op when the emptied selection already matches an already-empty currentSearchOrderIds', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: [],
      knownOrders: [],
      currentSearchOrderIds: [],
      resolvedOrderIds: new Map(),
    });
    expect(plan.nextSearchOrderIds).toBeNull();
  });

  // §5.6 R2#3: a combined known+unknown selection must resolve the unknown name too, not just
  // apply the known id and stop.
  it('flags the unknown name for resolution even when a known id in the same selection also changes', () => {
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: ['Заказ 10', 'Заказ 999'],
      knownOrders: [{ orderId: 10, orderName: 'Заказ 10' }],
      currentSearchOrderIds: [],
      resolvedOrderIds: new Map(),
    });
    expect(plan.nextSearchOrderIds).toEqual([10]);
    expect(plan.namesNeedingResolution).toEqual(['Заказ 999']);
  });
});
