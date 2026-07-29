import { describe, expect, it } from 'vitest';
import {
  getStoredUiVariant,
  setStoredUiVariant,
  uiVariantStorageKey,
} from './uiVariantStorage';

describe('per-user UI variant cache', () => {
  it('isolates keys by user and validates stored values', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    setStoredUiVariant('7', 'evolution', storage);
    setStoredUiVariant('8', 'line', storage);
    setStoredUiVariant('9', 'air', storage);

    expect(uiVariantStorageKey('7')).not.toBe(uiVariantStorageKey('8'));
    expect(getStoredUiVariant('7', storage)).toBe('evolution');
    expect(getStoredUiVariant('8', storage)).toBe('line');
    expect(getStoredUiVariant('9', storage)).toBe('air');

    values.set(uiVariantStorageKey('7'), 'future');
    expect(getStoredUiVariant('7', storage)).toBeNull();
  });

  it('fails closed when browser storage throws', () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };

    expect(getStoredUiVariant('7', throwingStorage)).toBeNull();
    expect(() => setStoredUiVariant('7', 'evolution', throwingStorage)).not.toThrow();
  });
});
