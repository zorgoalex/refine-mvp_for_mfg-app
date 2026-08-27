import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = fileURLToPath(new URL('../../..', import.meta.url));
const source = (path: string) => readFileSync(resolve(backendRoot, path), 'utf8');

describe('production order consumer boundary', () => {
  it.each([
    'src/modules/orders/adapters/pg-order-read-repository.ts',
    'src/modules/orders/adapters/pg-order-transaction-manager.ts',
    'src/modules/orders/adapters/pg-order-status-board-repository.ts',
    'src/modules/orders/adapters/pg-order-exporter.ts',
    'src/modules/orders/adapters/pg-order-snapshot.ts',
    'src/modules/production-actions/adapters/pg-production-action-repository.ts',
    'src/modules/projects/adapters/pg-projects-repository.ts',
    'src/modules/deadlines/adapters/pg-deadline-target-resolver.ts',
    'src/modules/deadlines/adapters/pg-order-deadline-sync.ts',
    'src/modules/crm-sync/adapters/pg-crm-source-repository.ts',
    'src/modules/groups/reporting/group-report-predicates.ts',
    'src/modules/groups/entity-links/group-entity-registry.ts',
    'src/modules/notifications-engine/adapters/pg-notification-context.ts',
    'src/modules/notifications-engine/adapters/pg-recipient-source.ts',
    'src/modules/cut/adapters/pg-cut-repository.ts',
    'src/modules/labels/adapters/pg-labels-repository.ts',
    'src/modules/orders/adapters/pg-order-resource-demand-repository.ts',
    'src/modules/cnc-telegram/adapters/pg-cnc-telegram-repository.ts',
    'src/modules/orders/adapters/pg-order-group-link-repository.ts',
    'src/modules/bazis-cut/adapters/pg-bazis-cut-repository.ts',
  ])('%s has an explicit production discriminator', (path) => {
    expect(source(path)).toContain("order_kind = 'production_order'");
  });

  it('rejects payment mutations for non-production orders before writing', () => {
    const paymentRepository = source(
      'src/modules/payments/adapters/pg-payment-repository.ts',
    );
    expect(paymentRepository).toContain("order.orderKind !== 'production_order'");
    expect(paymentRepository).toContain('assertPaymentReadyProductionOrder(order)');
  });

  it('keeps Hasura ordinary reads on a production-only view', () => {
    const migration = source('db/migrations/145_order_kinds_bitrix_crm_requests.sql');
    expect(migration).toMatch(
      /CREATE OR REPLACE VIEW orders_view[\s\S]*WHERE ord\.delete_flag = false[\s\S]*ord\.order_kind = 'production_order'/,
    );
  });
});
