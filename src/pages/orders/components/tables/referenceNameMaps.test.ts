import { describe, expect, it } from 'vitest';
import { buildNameByIdMap, resolveReferenceLabel } from './referenceNameMaps';

describe('buildNameByIdMap', () => {
  it('builds a numeric-keyed name map from antd select options', () => {
    const map = buildNameByIdMap([
      { value: 5, label: 'МДФ' },
      { value: '7', label: 'ЛДСП' },
    ]);
    expect(map.get(5)).toBe('МДФ');
    expect(map.get(7)).toBe('ЛДСП');
    expect(map.size).toBe(2);
  });

  it('skips options with null/undefined value and falls back to value when label is missing', () => {
    const map = buildNameByIdMap([
      { value: null, label: 'skip' },
      { value: undefined, label: 'skip' },
      { value: 9 },
    ]);
    expect(map.has(9)).toBe(true);
    expect(map.get(9)).toBe('9');
    expect(map.size).toBe(1);
  });

  it('returns an empty map for undefined options', () => {
    expect(buildNameByIdMap(undefined).size).toBe(0);
  });
});

describe('resolveReferenceLabel', () => {
  const map = new Map<number, string>([[3, 'Кромка ПВХ']]);

  it('returns undefined for null/undefined id', () => {
    expect(resolveReferenceLabel(null, map)).toBeUndefined();
    expect(resolveReferenceLabel(undefined, map)).toBeUndefined();
  });

  it('resolves a numeric or string id through the map', () => {
    expect(resolveReferenceLabel(3, map)).toBe('Кромка ПВХ');
    expect(resolveReferenceLabel('3' as unknown as number, map)).toBe('Кромка ПВХ');
  });

  it('returns undefined when the id is absent from the map', () => {
    expect(resolveReferenceLabel(99, map)).toBeUndefined();
  });
});
