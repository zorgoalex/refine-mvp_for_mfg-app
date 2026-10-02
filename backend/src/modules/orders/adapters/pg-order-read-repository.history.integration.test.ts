import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  ORDER_HISTORY_COMMON_EVENTS,
  ORDER_HISTORY_FINANCIAL_EVENTS,
  type OrderHistoryVisibility,
} from '../application/order-history-events';
import { PgOrderReadRepository } from './pg-order-read-repository';

const url = process.env.ERP_ORDER_HISTORY_TEST_DATABASE_URL;

const COMMON: OrderHistoryVisibility = { events: [...ORDER_HISTORY_COMMON_EVENTS], includeFinancial: false };
const FINANCIAL: OrderHistoryVisibility = {
  events: [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS],
  includeFinancial: true,
};
const user: CurrentUser = { id: '1', username: 'E2E-order-history', role: 'viewer', roleId: 100, permissions: ['orders.view'] };

// Real PostgreSQL executes the repository SQL. The audit tables are shadowed by session-local
// TEMP tables (same columns and defaults, no triggers), so no shared row is read or written.
describe.skipIf(!url)('order history / real PostgreSQL, rolled-back fixtures', () => {
  it('filters allow-listed events, refusals and financial facts in rows AND in total', async () => {
    expect(process.env.ERP_ORDER_HISTORY_TARGET_ENV).toBe('backend-test');
    const pool = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE audit_log (LIKE public.audit_log INCLUDING DEFAULTS) ON COMMIT DROP');
      await client.query('CREATE TEMP TABLE audit_log_related_entity (LIKE public.audit_log_related_entity INCLUDING DEFAULTS) ON COMMIT DROP');
      const orderId = 900000001;
      const otherId = 900000002;
      let minute = 0;
      const insert = async (row: {
        event: string;
        orderRelated?: boolean;
        entityOrder?: boolean;
        relatedOrderId?: number | null;
        statusField?: string;
        statusName?: string;
        paymentId?: number;
        payload?: boolean;
      }): Promise<string> => {
        minute += 1;
        const result = await client.query<{ audit_id: string }>(
          `INSERT INTO audit_log (
             event, entity_type, entity_id, username, request_id, ip_address, user_agent,
             before_json, after_json, diff_json, metadata_json, source, related_order_id,
             related_payment_id, status_field, status_name, created_at
           ) VALUES ($1, $2, $3, 'E2E-history-actor', $4, '10.9.8.7', 'E2E-agent',
             $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, 'e2e', $9, $10, $11, $12,
             TIMESTAMPTZ '2026-10-01T00:00:00Z' + make_interval(mins => $13))
           RETURNING audit_id`,
          [
            row.event,
            row.entityOrder ? 'order' : 'e2e_entity',
            row.entityOrder ? String(orderId) : 'e2e-1',
            `e2e-secret-request-${minute}`,
            row.payload ? JSON.stringify({ total_amount: 111111 }) : null,
            row.payload ? JSON.stringify({ total_amount: 222222 }) : null,
            row.payload ? JSON.stringify({ total_amount: { before: 111111, after: 222222 } }) : null,
            row.payload ? JSON.stringify({ requestId: 'e2e-secret-meta', bitrixId: 'e2e-bitrix-777' }) : null,
            row.relatedOrderId === undefined ? (row.orderRelated === false ? null : orderId) : row.relatedOrderId,
            row.paymentId ?? null,
            row.statusField ?? null,
            row.statusName ?? null,
            minute,
          ],
        );
        return result.rows[0].audit_id;
      };

      await insert({ event: 'orders.create', entityOrder: true, orderRelated: false });
      await insert({ event: 'orders.update', payload: true });
      await insert({ event: 'orders.status_change', statusField: 'orderStatus', statusName: 'E2E В производстве' });
      const linkedOnly = await insert({ event: 'cut_job.created', orderRelated: false });
      await client.query(
        "INSERT INTO audit_log_related_entity (audit_id, entity_type, entity_id) VALUES ($1, 'order', $2)",
        [linkedOnly, orderId],
      );
      // never visible
      await insert({ event: 'orders.restore', statusField: 'denied' });
      await insert({ event: 'crm_sync.upsert', payload: true });
      await insert({ event: 'orders.export' });
      await insert({ event: 'production.action_denied', statusField: 'denied' });
      await insert({ event: 'orders.update', relatedOrderId: otherId });
      // visible only with finance rights
      await insert({ event: 'orders.payment_status_change', statusField: 'paymentStatus', statusName: 'E2E Оплачен' });
      await insert({ event: 'payments.create', paymentId: 987654321 });
      await insert({ event: 'orders.update', paymentId: 987654321 });
      const paymentLinked = await insert({ event: 'orders.update' });
      await client.query(
        "INSERT INTO audit_log_related_entity (audit_id, entity_type, entity_id) VALUES ($1, 'payment', 987654321)",
        [paymentLinked],
      );

      const repository = new PgOrderReadRepository({
        query: (sql: string, params: unknown[]) => client.query(sql, params),
      } as unknown as DatabaseService);
      const read = (visibility: OrderHistoryVisibility, page = 1, pageSize = 50) =>
        repository.getOrderHistory({ currentUser: user, orderId, page, pageSize }, visibility);

      const common = await read(COMMON);
      expect(common.pagination.total).toBe(4);
      expect(common.data.map((event) => event.event)).toEqual([
        'cut_job.created', 'orders.status_change', 'orders.update', 'orders.create',
      ]);
      expect(common.data.find((event) => event.event === 'orders.status_change')).toMatchObject({
        statusField: 'orderStatus',
        statusName: 'E2E В производстве',
        actorName: 'E2E-history-actor',
      });
      for (const event of common.data) {
        expect(Object.keys(event).sort()).toEqual([
          'actorName', 'auditId', 'createdAt', 'entityType', 'event', 'stageCode', 'statusField', 'statusName',
        ]);
      }
      expect(JSON.stringify(common)).not.toMatch(/e2e-secret|e2e-bitrix|10\.9\.8\.7|E2E-agent|111111|222222|987654321|Оплачен|denied/);

      const financial = await read(FINANCIAL);
      expect(financial.pagination.total).toBe(8);
      expect(financial.data.map((event) => event.event)).toEqual([
        'orders.update', 'orders.update', 'payments.create', 'orders.payment_status_change',
        'cut_job.created', 'orders.status_change', 'orders.update', 'orders.create',
      ]);
      expect(JSON.stringify(financial)).not.toMatch(/e2e-secret|e2e-bitrix|10\.9\.8\.7|E2E-agent|111111|222222|denied|crm_sync|orders\.export/);

      // pagination walks the same filtered set
      const firstPage = await read(COMMON, 1, 3);
      const secondPage = await read(COMMON, 2, 3);
      expect(firstPage.pagination).toEqual({ page: 1, pageSize: 3, total: 4, totalPages: 2 });
      expect(firstPage.data).toHaveLength(3);
      expect(secondPage.data.map((event) => event.event)).toEqual(['orders.create']);

      // another order sees none of these events
      expect((await repository.getOrderHistory({ currentUser: user, orderId: orderId + 5, page: 1, pageSize: 50 }, FINANCIAL)).pagination.total).toBe(0);
    } finally {
      await rollback(client);
      client.release();
      await pool.end();
    }
  });
});

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}
