import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MdfPublishedSnapshot, MdfSessionSnapshot, MdfSourceKind } from '../../api/types/mdfPublishedApi.types';
import type { CncOrderSearchPeriod } from './model';

const api = vi.hoisted(() => ({
  getEngineMode: vi.fn(),
  publishedGet: vi.fn(),
  searchMdfBoardHistoryOrders: vi.fn(),
}));
vi.mock('../../api/mdfCorrectionApi', () => ({ mdfCorrectionApi: { getEngineMode: api.getEngineMode } }));
vi.mock('../../api/mdfPublishedApi', () => ({ mdfPublishedApi: { get: api.publishedGet } }));
vi.mock('../../api/cncTelegramApi', () => ({
  cncTelegramApi: { searchMdfBoardHistoryOrders: api.searchMdfBoardHistoryOrders },
}));

import { useMdfPublishedBoard, type UseMdfPublishedBoardResult } from './useMdfPublishedBoard';

function snapshot(overrides: Partial<MdfPublishedSnapshot> = {}): MdfPublishedSnapshot {
  return {
    schemaVersion: 1,
    mode: 'active',
    revision: 'rev-1',
    generatedAt: '2026-09-27T00:00:00.000Z',
    dateFrom: '2026-07-27',
    dateTo: '2026-09-27',
    cards: [],
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

let current: UseMdfPublishedBoardResult | null = null;
function Harness(props: {
  workday: string;
  period?: CncOrderSearchPeriod;
  focusKind: MdfSourceKind | null;
  focusId: string | null;
}) {
  current = useMdfPublishedBoard({
    enabled: true,
    workday: props.workday,
    period: props.period,
    focusKind: props.focusKind,
    focusId: props.focusId,
  });
  return null;
}

describe('useMdfPublishedBoard: §5.6 finding 6 — known order name still triggers searchOrderIds', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    current = null;
    api.getEngineMode.mockReset().mockResolvedValue({ mode: 'active', publishedReads: true });
    api.publishedGet.mockReset();
    api.searchMdfBoardHistoryOrders.mockReset();
    // The hook's polling/visibility effects touch window/document; no-op stand-ins are enough
    // since these tests never advance past the initial fetch.
    vi.stubGlobal('window', { setInterval: vi.fn(() => 0), clearInterval: vi.fn() });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it('requests searchOrderIds for an order name already known from the loaded snapshot (one recent card does not mean all its cards are loaded)', async () => {
    const knownSnapshot = snapshot({ orders: [{ orderId: 10, orderName: 'Заказ 10' }] });
    api.publishedGet.mockResolvedValue({ sessionGeneration: 1, snapshot: knownSnapshot } satisfies MdfSessionSnapshot);

    act(() => {
      renderer = create(<Harness workday="2026-09-27" focusKind={null} focusId={null} />);
    });
    await vi.waitFor(() => expect(current?.mode).toBe('published'));
    expect(current?.session?.snapshot.orders).toEqual([{ orderId: 10, orderName: 'Заказ 10' }]);

    api.publishedGet.mockClear();
    act(() => {
      current!.requestSearchOrderNames(['Заказ 10']);
    });

    // The order is already visible (known), yet its id must still be requested via
    // searchOrderIds: the default window fetch is time-scoped, not per-order, so a known order
    // can still have older cards outside the loaded window.
    await vi.waitFor(() => expect(api.publishedGet).toHaveBeenCalledWith(
      expect.objectContaining({ searchOrderIds: [10] }),
    ));
    // No name→id lookup needed for an already-known order.
    expect(api.searchMdfBoardHistoryOrders).not.toHaveBeenCalled();
  });
});

describe('useMdfPublishedBoard: §5.6 R2 — replace (not union) semantics + combined known/unknown resolution', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    current = null;
    api.getEngineMode.mockReset().mockResolvedValue({ mode: 'active', publishedReads: true });
    api.publishedGet.mockReset();
    api.searchMdfBoardHistoryOrders.mockReset();
    vi.stubGlobal('window', { setInterval: vi.fn(() => 0), clearInterval: vi.fn() });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  async function mountPublished(): Promise<void> {
    const knownSnapshot = snapshot({
      orders: [
        { orderId: 10, orderName: 'Заказ 10' },
        { orderId: 20, orderName: 'Заказ 20' },
      ],
    });
    api.publishedGet.mockResolvedValue({ sessionGeneration: 1, snapshot: knownSnapshot } satisfies MdfSessionSnapshot);
    act(() => {
      renderer = create(<Harness workday="2026-09-27" focusKind={null} focusId={null} />);
    });
    await vi.waitFor(() => expect(current?.mode).toBe('published'));
  }

  it('removing one of several selected tags drops exactly that order id — never keeps it via union with the past selection', async () => {
    await mountPublished();

    api.publishedGet.mockClear();
    act(() => { current!.requestSearchOrderNames(['Заказ 10', 'Заказ 20']); });
    await vi.waitFor(() => expect([...current!.searchOrderIds].sort()).toEqual([10, 20]));

    api.publishedGet.mockClear();
    // Remove 'Заказ 20' — the Select control always reports the CURRENT full selection.
    act(() => { current!.requestSearchOrderNames(['Заказ 10']); });

    await vi.waitFor(() => expect(current!.searchOrderIds).toEqual([10]));
    await vi.waitFor(() => expect(api.publishedGet).toHaveBeenCalledWith(
      expect.objectContaining({ searchOrderIds: [10] }),
    ));
    // No call ever re-requests 20 alongside 10 after the removal.
    expect(api.publishedGet.mock.calls.some((call) => {
      const ids = (call[0] as { searchOrderIds?: number[] }).searchOrderIds ?? [];
      return ids.includes(20);
    })).toBe(false);
  });

  it('clearing the selection entirely clears searchOrderIds (and stops requesting it)', async () => {
    await mountPublished();

    act(() => { current!.requestSearchOrderNames(['Заказ 10']); });
    await vi.waitFor(() => expect(current!.searchOrderIds).toEqual([10]));

    api.publishedGet.mockClear();
    act(() => { current!.requestSearchOrderNames([]); });

    await vi.waitFor(() => expect(current!.searchOrderIds).toEqual([]));
    await vi.waitFor(() => expect(api.publishedGet).toHaveBeenCalled());
    const lastQuery = api.publishedGet.mock.calls.at(-1)![0] as { searchOrderIds?: number[] };
    expect(lastQuery.searchOrderIds ?? []).toEqual([]);
  });

  it('resolves an unknown name even when a known id in the SAME selection also changes (combined known+unknown)', async () => {
    await mountPublished();
    api.searchMdfBoardHistoryOrders.mockResolvedValue({
      data: [{ orderId: 30, orderName: 'Неизвестный' }],
    });

    api.publishedGet.mockClear();
    act(() => { current!.requestSearchOrderNames(['Заказ 10', 'Неизвестный']); });

    // The known id (10) must not be the ONLY one ever applied — the unknown name (30, once
    // resolved) must be folded in too, in one final state.
    await vi.waitFor(() => expect(api.searchMdfBoardHistoryOrders).toHaveBeenCalledWith(
      'Неизвестный', 5, expect.objectContaining({ cache: 'no-store' }),
    ));
    await vi.waitFor(() => expect([...current!.searchOrderIds].sort((a, b) => a - b)).toEqual([10, 30]));
    await vi.waitFor(() => expect(api.publishedGet).toHaveBeenCalledWith(
      expect.objectContaining({ searchOrderIds: [10, 30] }),
    ));
  });
});

describe('useMdfPublishedBoard: displayFrom — legacy-parity display cut sent to the backend', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    current = null;
    api.getEngineMode.mockReset().mockResolvedValue({ mode: 'active', publishedReads: true });
    api.publishedGet.mockReset().mockResolvedValue({
      sessionGeneration: 1,
      snapshot: snapshot(),
    } satisfies MdfSessionSnapshot);
    api.searchMdfBoardHistoryOrders.mockReset();
    vi.stubGlobal('window', { setInterval: vi.fn(() => 0), clearInterval: vi.fn() });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it('default request (no period, i.e. legacy default 1w) carries displayFrom = workday - 6', async () => {
    act(() => {
      renderer = create(<Harness workday="2026-09-27" focusKind={null} focusId={null} />);
    });
    await vi.waitFor(() => expect(current?.mode).toBe('published'));
    expect(api.publishedGet).toHaveBeenCalledWith(
      expect.objectContaining({ dateTo: '2026-09-27', displayFrom: '2026-09-21' }),
    );
  });

  it.each<[CncOrderSearchPeriod, string]>([
    ['1d', '2026-09-27'],
    ['1w', '2026-09-21'],
    ['2w', '2026-09-14'],
    ['1m', '2026-08-28'],
  ])('period %s maps to the same dateFrom the legacy board would use', async (period, expectedDisplayFrom) => {
    act(() => {
      renderer = create(<Harness workday="2026-09-27" period={period} focusKind={null} focusId={null} />);
    });
    await vi.waitFor(() => expect(current?.mode).toBe('published'));
    expect(api.publishedGet).toHaveBeenCalledWith(
      expect.objectContaining({ dateTo: '2026-09-27', displayFrom: expectedDisplayFrom }),
    );
  });

  it('changing the period changes the query key and refetches (new displayFrom requested)', async () => {
    act(() => {
      renderer = create(<Harness workday="2026-09-27" period="1w" focusKind={null} focusId={null} />);
    });
    await vi.waitFor(() => expect(current?.mode).toBe('published'));
    expect(api.publishedGet).toHaveBeenCalledWith(expect.objectContaining({ displayFrom: '2026-09-21' }));

    api.publishedGet.mockClear();
    act(() => {
      renderer.update(<Harness workday="2026-09-27" period="1m" focusKind={null} focusId={null} />);
    });
    await vi.waitFor(() => expect(api.publishedGet).toHaveBeenCalledWith(
      expect.objectContaining({ displayFrom: '2026-08-28' }),
    ));
  });

  it('search/focus params are unaffected by displayFrom — both travel alongside it unchanged', async () => {
    act(() => {
      renderer = create(<Harness workday="2026-09-27" period="1w" focusKind="packet" focusId="pkt-1" />);
    });
    await vi.waitFor(() => expect(current?.mode).toBe('published'));
    expect(api.publishedGet).toHaveBeenCalledWith(
      expect.objectContaining({
        dateTo: '2026-09-27',
        displayFrom: '2026-09-21',
        focus: { kind: 'packet', id: 'pkt-1' },
      }),
    );
  });
});
