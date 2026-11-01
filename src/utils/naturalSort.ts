// Natural order of record numbers and names: digit runs compare as numbers («2» before «12», «1289» before «1368»,
// «1347» before «1347-5»), letters case-insensitively in Russian. Empty values go last in either direction.
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

const isEmpty = (value: unknown) => value === null || value === undefined || value === '';
const isNumeric = (value: unknown) =>
  typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));

/** Compares two cell values: numbers and booleans by value, everything else as text in the natural order. */
export function compareNatural(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  // numeric columns may arrive as strings (Hasura numeric): «10.5» is more than «10.25»
  if (isNumeric(left) && isNumeric(right)) return Number(left) - Number(right);
  return collator.compare(String(left), String(right));
}

/**
 * An antd column sorter over `field` in the natural order, with empty values last for both directions (antd reverses
 * the comparator for «descend», so the empty-last rule needs the current direction).
 */
export function naturalSorter<T extends Record<string, unknown>>(field: keyof T & string) {
  return (left: T, right: T, sortOrder?: 'ascend' | 'descend' | null): number => {
    const a = left[field];
    const b = right[field];
    if (isEmpty(a) || isEmpty(b)) {
      if (isEmpty(a) && isEmpty(b)) return 0;
      const emptyLast = isEmpty(a) ? 1 : -1;
      return sortOrder === 'descend' ? -emptyLast : emptyLast;
    }
    return compareNatural(a, b);
  };
}
