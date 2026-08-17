import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const metadata = JSON.parse(readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'));

function table(name: string) {
  return metadata.sources[0].tables.find((entry: { table?: { name?: string } }) => entry.table?.name === name);
}

function roles(entry: Record<string, Array<{ role: string }>> | undefined, key: string): string[] {
  return (entry?.[key] ?? []).map((permission) => permission.role);
}

describe('Hasura payments RBAC bypass guard', () => {
  it('does not grant operator direct payments access broader than backend RBAC', () => {
    const payments = table('payments');
    const paymentsView = table('payments_view');

    expect(roles(payments, 'insert_permissions')).not.toContain('operator');
    expect(roles(payments, 'select_permissions')).not.toContain('operator');
    expect(roles(payments, 'update_permissions')).not.toContain('operator');
    expect(roles(payments, 'delete_permissions')).not.toContain('operator');
    expect(roles(paymentsView, 'select_permissions')).not.toContain('operator');
  });
});
