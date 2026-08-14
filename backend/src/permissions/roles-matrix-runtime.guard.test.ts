import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');

describe('roles matrix runtime guards', () => {
  it.each([
    'backend/src/modules/orders/http/orders.controller.ts',
    'backend/src/modules/orders/adapters/pg-order-status-board-repository.ts',
    'backend/src/modules/production-actions/adapters/pg-production-action-repository.ts',
    'backend/src/permissions/policies/order-access.policy.ts',
    'backend/src/permissions/policies/payment-access.policy.ts',
  ])('keeps runtime scope checks off static ROLE_POLICIES: %s', (relativePath) => {
    const source = readSource(relativePath);

    expect(source).not.toContain('ROLE_POLICIES');
    expect(source).toContain('rolePolicyForUser');
  });

  it('checks payment permissions and payment scope for order-save payment mutations', () => {
    const source = readSource('backend/src/modules/orders/application/order-transaction.service.ts');

    expect(source).toContain('PaymentAccessPolicy');
    expect(source).toContain('requirePaymentScope');
    expect(source).toContain("'payments.create'");
    expect(source).toContain("'payments.update'");
    expect(source).toContain("'payments.delete'");
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}
