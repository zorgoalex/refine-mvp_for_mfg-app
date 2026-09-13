// src/pages/orders/groupSelection.test.ts
import { describe, it, expect } from 'vitest';
import { groupCheckboxState, toggleGroupSelection, selectedDetailIds, filterNumericKeys } from './groupSelection';

describe('groupCheckboxState', () => {
  it('empty when group has no keys', () => { expect(groupCheckboxState([1, 2], [])).toBe('empty'); });
  it('checked when all selected', () => { expect(groupCheckboxState([1, 2, 3], [2, 3])).toBe('checked'); });
  it('unchecked when none', () => { expect(groupCheckboxState([1], [2, 3])).toBe('unchecked'); });
  it('indeterminate when some', () => { expect(groupCheckboxState([2], [2, 3])).toBe('indeterminate'); });
});

describe('toggleGroupSelection', () => {
  it('adds missing keys preserving order', () => { expect(toggleGroupSelection([1, 5], [2, 3])).toEqual([1, 5, 2, 3]); });
  it('adds only missing when partial', () => { expect(toggleGroupSelection([1, 2], [2, 3])).toEqual([1, 2, 3]); });
  it('removes all when all present', () => { expect(toggleGroupSelection([1, 2, 3], [2, 3])).toEqual([1]); });
});

describe('selectedDetailIds (edit selection → cut detail_ids)', () => {
  const details = [
    { temp_id: 'a', detail_id: 11 },
    { temp_id: 'b', detail_id: 12 },
    { temp_id: 'c' },               // unsaved: no detail_id
    { detail_id: 13 },              // no temp_id: rowKey = detail_id
  ];
  it('maps selected rowKeys to persisted detail_ids only', () => {
    // selection keyed by temp_id ?? detail_id
    expect(selectedDetailIds(details, ['a', 'c', 13])).toEqual([11, 13]); // 'c' excluded (unsaved)
  });
  it('excludes everything when only unsaved rows selected', () => {
    expect(selectedDetailIds(details, ['c'])).toEqual([]);
  });
});

describe('filterNumericKeys', () => {
  it('drops separator/string keys, keeps numbers', () => {
    expect(filterNumericKeys([1, '2', '__sep__:milling:5:1', 'b', 3])).toEqual([1, 2, 3]);
  });
});

describe('React row keys preserve runtime selection semantics', () => {
  it('distinguishes numeric, string and bigint keys', () => {
    expect(groupCheckboxState([1], ['1', 1n])).toBe('unchecked');
    expect(groupCheckboxState([1, '1'], [1, '1', 1n])).toBe('indeterminate');
    expect(groupCheckboxState([1, '1', 1n], [1, '1', 1n])).toBe('checked');
  });

  it('adds only keys absent from the selection, preserving order and inputs', () => {
    const selected = Object.freeze([1, '1']);
    const group = Object.freeze(['1', 1n, '__sep__:milling:5:1']);
    expect(toggleGroupSelection(selected, group)).toEqual([1, '1', 1n, '__sep__:milling:5:1']);
    expect(selected).toEqual([1, '1']);
    expect(group).toEqual(['1', 1n, '__sep__:milling:5:1']);
  });

  it('removes a complete mixed group without conflating key types', () => {
    expect(toggleGroupSelection([1, '1', 1n, 2n], ['1', 1n])).toEqual([1, 2n]);
  });

  it('preserves existing duplicate and empty-group behavior', () => {
    // This type-only fix does not introduce new deduplication rules.
    expect(toggleGroupSelection([1, 1], [1, 2n, 2n])).toEqual([1, 1, 2n, 2n]);
    const selected = Object.freeze([1n, 'temp']);
    expect(toggleGroupSelection(selected, [])).toEqual(selected);
    expect(toggleGroupSelection(selected, [])).not.toBe(selected);
    expect(groupCheckboxState([], [])).toBe('empty');
  });

  it('maps bigint row keys to persisted numeric IDs, excluding unsaved rows', () => {
    const details = Object.freeze([
      { temp_id: 1n, detail_id: 11 },
      { temp_id: '1', detail_id: 12 },
      { temp_id: 2n },
      { detail_id: 13 },
    ]);
    expect(selectedDetailIds(details, [1n, 2n, 13])).toEqual([11, 13]);
    expect(selectedDetailIds(details, [1])).toEqual([]);
    expect(selectedDetailIds(details, [])).toEqual([]);
  });

  it('keeps numeric conversion and separator filtering unchanged', () => {
    const keys = Object.freeze([1, '2', 3n, '__sep__:milling:5:1', 'temp', -4n, '-5', -6]);
    expect(filterNumericKeys(keys)).toEqual([1, 2, 3, -6]);
    expect(filterNumericKeys([])).toEqual([]);
    expect(keys).toHaveLength(8);
  });
});
