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
