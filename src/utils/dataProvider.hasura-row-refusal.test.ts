import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertHasuraRowChanged } from './dataProvider';

const source = readFileSync(new URL('./dataProvider.ts', import.meta.url), 'utf8');

describe('dataProvider: a Hasura by-pk write that changed no row is a refusal (access groups 0Б)', () => {
  it('throws a 403 when Hasura answers null (the permission filter excluded the row, or it is gone)', () => {
    expect(() => assertHasuraRowChanged(null, 'doweling_orders')).toThrow(
      expect.objectContaining({ statusCode: 403, message: expect.stringContaining('Запись недоступна') }),
    );
    expect(() => assertHasuraRowChanged(undefined, 'edge_types')).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => assertHasuraRowChanged({ doweling_order_id: 1 }, 'doweling_orders')).not.toThrow();
  });

  it('checks the result of update_*_by_pk and delete_*_by_pk before reporting success', () => {
    const update = source.slice(source.indexOf('const updated = data[`update_${resource}_by_pk`];'));
    expect(update.indexOf('assertHasuraRowChanged(updated, resource);')).toBeGreaterThan(0);
    expect(update.indexOf('assertHasuraRowChanged(updated, resource);')).toBeLessThan(update.indexOf('return { data: updated };'));
    const remove = source.slice(source.indexOf('const deleted = data[`delete_${resource}_by_pk`];'));
    expect(remove.indexOf('assertHasuraRowChanged(deleted, resource);')).toBeGreaterThan(0);
    expect(remove.indexOf('assertHasuraRowChanged(deleted, resource);')).toBeLessThan(remove.indexOf('return { data: deleted };'));
  });
});
