// src/pages/orders/groupSelection.ts
export type GroupCheckboxState = 'checked' | 'indeterminate' | 'unchecked' | 'empty';

export function groupCheckboxState(
  selected: ReadonlyArray<number | string>,
  groupKeys: ReadonlyArray<number | string>,
): GroupCheckboxState {
  if (groupKeys.length === 0) return 'empty';
  const set = new Set(selected);
  const inCount = groupKeys.reduce((n, k) => (set.has(k) ? n + 1 : n), 0);
  if (inCount === 0) return 'unchecked';
  if (inCount === groupKeys.length) return 'checked';
  return 'indeterminate';
}

export function toggleGroupSelection(
  selected: ReadonlyArray<number | string>,
  groupKeys: ReadonlyArray<number | string>,
): Array<number | string> {
  const set = new Set(selected);
  const allIn = groupKeys.length > 0 && groupKeys.every((k) => set.has(k));
  if (allIn) {
    const remove = new Set(groupKeys);
    return selected.filter((k) => !remove.has(k));
  }
  const result = [...selected];
  for (const k of groupKeys) if (!set.has(k)) result.push(k);
  return result;
}

export function selectedDetailIds(
  details: ReadonlyArray<any>,
  selectedKeys: ReadonlyArray<number | string>,
): number[] {
  const selected = new Set(selectedKeys);
  return details
    .filter((d) => selected.has(d.temp_id ?? d.detail_id) && d.detail_id != null)
    .map((d) => d.detail_id as number);
}

export function filterNumericKeys(keys: ReadonlyArray<number | string>): number[] {
  return keys
    .filter((k) => typeof k === 'number' || /^\d+$/.test(String(k)))
    .map((k) => Number(k));
}
