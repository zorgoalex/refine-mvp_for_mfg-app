import { describe, expect, it } from 'vitest';
import {
  getDeviceUiVariantHint,
  getStoredUiVariant,
  setDeviceUiVariantHint,
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
    setStoredUiVariant('10', 'neutral', storage);

    expect(uiVariantStorageKey('7')).not.toBe(uiVariantStorageKey('8'));
    expect(getStoredUiVariant('7', storage)).toBe('evolution');
    expect(getStoredUiVariant('8', storage)).toBe('line');
    expect(getStoredUiVariant('9', storage)).toBe('air');
    expect(getStoredUiVariant('10', storage)).toBe('neutral');

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

  it('keeps only the NewLine choice as the signed-out device hint', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    expect(getDeviceUiVariantHint(storage)).toBeNull();
    setDeviceUiVariantHint('workbench', storage);
    expect(getDeviceUiVariantHint(storage)).toBe('workbench');
    setDeviceUiVariantHint('line', storage);
    expect(getDeviceUiVariantHint(storage)).toBeNull();
    expect(values.size).toBe(0);

    const throwingStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(getDeviceUiVariantHint(throwingStorage)).toBeNull();
    expect(() => setDeviceUiVariantHint('workbench', throwingStorage)).not.toThrow();
  });

  it('survives a browser that throws on the global localStorage getter', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new DOMException('blocked', 'SecurityError'); },
    });
    try {
      expect(getDeviceUiVariantHint()).toBeNull();
      expect(() => setDeviceUiVariantHint('workbench')).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
