import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./146_order_delete_role_scopes.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('146 order delete role scopes migration', () => {
  it('enables top manager/all and manager/own order deletion', () => {
    expect(sql).toContain("('top_manager', 'all')");
    expect(sql).toContain("('manager', 'own')");
    expect(sql).toContain("'orders.delete'");
    expect(sql).toContain('ON CONFLICT (role_id, permission_name) DO UPDATE');
    expect(sql).toContain('ON CONFLICT (role_id, scope_key) DO UPDATE');
    expect(sql).toContain('UPDATE permissions_state');
  });

  it('has a complete-effect migration runner probe', () => {
    expect(runner).toContain('146_order_delete_role_scopes*) probe_all');
    expect(runner).toContain("rp.permission_name = 'orders.delete'");
    expect(runner).toContain("rps.scope_key = 'orders.delete'");
    expect(runner).toContain('|146_*)');
  });
});
