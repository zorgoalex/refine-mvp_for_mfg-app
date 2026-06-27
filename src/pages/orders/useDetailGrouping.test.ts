// src/pages/orders/useDetailGrouping.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detailGroupingKey, loadDetailGrouping, saveDetailGrouping, nextStateForField } from './useDetailGrouping';

// Minimal localStorage mock for node env.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

describe('detailGroupingKey', () => {
  it('namespaces by user and order', () => {
    expect(detailGroupingKey('u7', 42)).toBe('order-details:grouping:u7:42');
    expect(detailGroupingKey('anon', 'new')).toBe('order-details:grouping:anon:new');
  });
});

describe('load/save round-trip', () => {
  it('defaults to no field, separation on', () => {
    expect(loadDetailGrouping('u7', 42)).toEqual({ field: null, showSeparation: true });
  });
  it('persists and reloads chosen field + toggle', () => {
    saveDetailGrouping('u7', 42, { field: 'material', showSeparation: false });
    expect(loadDetailGrouping('u7', 42)).toEqual({ field: 'material', showSeparation: false });
  });
  it('ignores corrupt stored JSON and returns default', () => {
    localStorage.setItem(detailGroupingKey('u7', 42), '{not json');
    expect(loadDetailGrouping('u7', 42)).toEqual({ field: null, showSeparation: true });
  });
  it('rejects unknown field value as null', () => {
    localStorage.setItem(detailGroupingKey('u7', 42), JSON.stringify({ field: 'bogus', showSeparation: true }));
    expect(loadDetailGrouping('u7', 42).field).toBeNull();
  });
});

describe('nextStateForField', () => {
  it('re-activates separation when a field is picked, even after a prior uncheck', () => {
    const next = nextStateForField({ field: 'milling', showSeparation: false }, 'material');
    expect(next).toEqual({ field: 'material', showSeparation: true });
  });
  it('keeps prior showSeparation when clearing the field', () => {
    expect(nextStateForField({ field: 'milling', showSeparation: false }, null))
      .toEqual({ field: null, showSeparation: false });
  });
});
