import { describe, expect, it } from 'vitest';
import { convertThousandths, fulfillmentOf, openThousandths, supplierMatch } from './supplier-request-links';

describe('supplierMatch (§5.5)', () => {
  const doc = (overrides: Partial<Parameters<typeof supplierMatch>[1]> = {}) => ({ supplierId: null, counterpartyRefKey: null, keys: [], ...overrides });

  it('ключ заявки среди ключей документа — совпадение', () => {
    expect(supplierMatch('c:abc', doc({ counterpartyRefKey: 'abc', keys: ['c:abc'] }))).toBe('match');
    expect(supplierMatch('s:3', doc({ supplierId: 3, counterpartyRefKey: 'abc', keys: ['c:abc', 's:3'] }))).toBe('match');
  });

  it('одинаковая идентичность, разные значения — расхождение', () => {
    expect(supplierMatch('s:3', doc({ supplierId: 4, keys: ['s:4'] }))).toBe('mismatch');
    expect(supplierMatch('c:abc', doc({ counterpartyRefKey: 'xyz', keys: ['c:xyz'] }))).toBe('mismatch');
    expect(supplierMatch('n:aaa', doc({ keys: ['n:bbb'] }))).toBe('mismatch');
  });

  it('не сравнить или поставщик заявки не указан — неизвестно', () => {
    expect(supplierMatch('s:3', doc({ counterpartyRefKey: 'abc', keys: ['c:abc'] }))).toBe('unknown');
    expect(supplierMatch('none', doc({ supplierId: 3, keys: ['s:3'] }))).toBe('unknown');
    expect(supplierMatch('n:aaa', doc({ counterpartyRefKey: 'abc', keys: ['c:abc'] }))).toBe('unknown');
  });
});

describe('convertThousandths', () => {
  it('те же единицы — без пересчёта; лист ↔ м² по площади; несовместимые — null', () => {
    expect(convertThousandths(1500, 'sheet', 'sheet', 'm2', 5.796)).toBe(1500);
    expect(convertThousandths(1000, 'sheet', 'm2', 'm2', 5.796)).toBe(5796);
    expect(convertThousandths(5796, 'm2', 'sheet', 'm2', 5.796)).toBe(1000);
    expect(convertThousandths(1000, 'pcs', 'sheet', 'm2', 5.796)).toBeNull();
    expect(convertThousandths(1000, 'sheet', 'm2', 'm2', null)).toBeNull();
    expect(convertThousandths(1000, 'lm', 'lm', 'lm', null)).toBe(1000);
  });
});

describe('fulfillmentOf', () => {
  it('ждём / частично / получено', () => {
    expect(fulfillmentOf(2000, 0)).toBe('waiting');
    expect(fulfillmentOf(2000, 500)).toBe('partial');
    expect(fulfillmentOf(2000, 2000)).toBe('received');
    expect(fulfillmentOf(2000, 2500)).toBe('received');
  });

  it('хвост округления (0,001 единицы) — получено: заявка округляла вверх, подбор — вниз', () => {
    expect(fulfillmentOf(551, 550)).toBe('received');
    expect(fulfillmentOf(551, 549)).toBe('partial');
    expect(openThousandths(551, 550)).toBe(0);
    expect(openThousandths(551, 549)).toBe(2);
    // Заказ на 0,001 без прихода — открыт (CR5-1).
    expect(openThousandths(1, 0)).toBe(1);
    expect(fulfillmentOf(1, 0)).toBe('waiting');
    expect(openThousandths(1, 1)).toBe(0);
  });
});
