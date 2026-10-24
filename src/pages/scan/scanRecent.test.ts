import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScanCandidate } from '../../api/types/labelsApi.types';
import { SCAN_RECENT_LIMIT, loadScanRecent, rememberScan } from './scanRecent';

const candidate = (detailId: number): ScanCandidate => ({
  detailId,
  orderId: 100 + detailId,
  orderName: `Тест-${detailId}`,
  detailNumber: detailId,
  width: 600,
  height: 400,
  quantity: 1,
  materialName: null,
  productionStatusName: null,
  matchedFields: [],
  matchedBy: 'qr-template:x',
  score: 1,
});

describe('scan recent list (NewLine)', () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;

  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
  });

  it('puts the latest detail first, without duplicates, up to the limit', () => {
    for (let id = 1; id <= SCAN_RECENT_LIMIT + 2; id += 1) rememberScan(7, candidate(id));
    rememberScan(7, candidate(4));
    const ids = loadScanRecent(7).map((item) => item.detailId);
    expect(ids).toEqual([4, 7, 6, 5, 3]);
  });

  it('keeps users apart and survives broken storage', () => {
    rememberScan(1, candidate(1));
    expect(loadScanRecent(2)).toEqual([]);
    store.set('scanRecent:3', '{not json');
    expect(loadScanRecent(3)).toEqual([]);
    store.set('scanRecent:4', JSON.stringify([{ detailId: 'x' }, candidate(9)]));
    expect(loadScanRecent(4).map((item) => item.detailId)).toEqual([9]);
  });
});
