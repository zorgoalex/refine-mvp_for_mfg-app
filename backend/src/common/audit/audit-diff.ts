type Obj = Record<string, unknown> | null | undefined;

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * Top-level field diff as {field:{from,to}}. Deep-equal values are omitted.
 * NOTE: a missing key and a key whose value is `undefined` are both normalized to
 * `null` (audit JSON round-trips through JSON.stringify, which has no `undefined`),
 * so {from:null,to:null} pairs collapse to "unchanged" and are excluded.
 */
export function computeDiff(before: Obj, after: Obj): Record<string, { from: unknown; to: unknown }> {
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = (b as Record<string, unknown>)[key] ?? null;
    const to = (a as Record<string, unknown>)[key] ?? null;
    if (!deepEqual(from, to)) diff[key] = { from, to };
  }
  return diff;
}

export function computeListDiff<T>(
  before: T[],
  after: T[],
  key: (item: T) => string,
): { added: T[]; removed: T[] } {
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((item) => !beforeKeys.has(key(item))),
    removed: before.filter((item) => !afterKeys.has(key(item))),
  };
}
