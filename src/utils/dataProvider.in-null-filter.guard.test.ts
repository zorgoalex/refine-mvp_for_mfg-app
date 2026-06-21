import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Hasura rejects `_in: [null]` for non-null typed columns with
// "unexpected null value for type 'smallint'". Callers (e.g. resolving a sheet-shadow
// material's null default_supplier_id/vendor_id via useMany) may pass a null id, so the
// data provider must strip null/undefined before building the `_in` clause.
const src = readFileSync(new URL('./dataProvider.ts', import.meta.url), 'utf8');

describe('dataProvider strips null/undefined from _in queries', () => {
  it('getMany filters null/undefined ids and short-circuits an empty set', () => {
    expect(src).toMatch(/const cleanIds = [\s\S]{0,80}\.filter\(\s*\(v\) => v !== null && v !== undefined/);
    expect(src).toMatch(/if \(cleanIds\.length === 0\)[\s\S]{0,40}return \{ data: \[\] \}/);
    // the _in clause is built from cleanIds, not the raw ids
    expect(src).toMatch(/_in: \[\$\{cleanIds\.map\(escapeValue\)/);
  });

  it('buildWhere strips null/undefined from _in arrays', () => {
    expect(src).toMatch(/op === "_in" && Array\.isArray\(val\)/);
    expect(src).toMatch(/val = val\.filter\(\(v\) => v !== null && v !== undefined\)/);
  });
});
