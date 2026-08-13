import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  resolve(process.cwd(), 'ops/hasura/doweling-orders-view-active-flag-select.sh'),
  'utf8',
);

describe('doweling-orders-view-active-flag-select.sh', () => {
  it('patches only doweling_orders_view.delete_flag select permissions', () => {
    expect(script).toContain('target_table = "doweling_orders_view"');
    expect(script).toContain('column_to_add = "delete_flag"');
    expect(script).toContain('"type": "pg_drop_select_permission"');
    expect(script).toContain('"type": "pg_create_select_permission"');
  });

  it('preserves safe rollout behavior for Hasura metadata', () => {
    expect(script).toContain('"type":"reload_metadata"');
    expect(script).toContain('"type":"export_metadata"');
    expect(script).toContain('raw_cols == "*"');
    expect(script).toContain('HASURA_GRAPHQL_ADMIN_SECRET');
  });
});
