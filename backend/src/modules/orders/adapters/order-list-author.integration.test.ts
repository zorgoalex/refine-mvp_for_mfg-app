import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgOrderReadRepository } from './pg-order-read-repository';

const url = process.env.ERP_ORDER_LIST_AUTHOR_TEST_DATABASE_URL;

describe.skipIf(!url)('order list audit label / real PostgreSQL, session-local fixtures', () => {
  it('masks service authors, keeps human labels and handles missing users without changing pagination', async () => {
    expect(process.env.ERP_ORDER_LIST_AUTHOR_TARGET_ENV).toBe('backend-test');
    const pool = new Pool({ connectionString: url, max: 1, statement_timeout: 10000, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Shadow only this connection's users relation. No shared account/order changes.
      await client.query('CREATE TEMP TABLE users ON COMMIT DROP AS SELECT * FROM public.users');
      const fixture = (await client.query("SELECT o.order_id, o.order_name, o.created_by FROM orders o JOIN users u ON u.user_id=o.created_by WHERE o.delete_flag=false AND o.order_kind='production_order' ORDER BY o.order_id DESC LIMIT 1")).rows[0];
      expect(fixture).toBeTruthy();
      const repository = new PgOrderReadRepository({ query: (sql: string, params: unknown[]) => client.query(sql, params) } as unknown as DatabaseService);
      const read = () => repository.listOrders({ currentUser: { id: String(fixture.created_by), username: 'E2E-order-list-author', role: 'admin', roleId: 1, permissions: ['orders.view'] }, query: { page: 1, pageSize: 100, search: fixture.order_name, sortBy: 'updatedAt', sortOrder: 'desc' } });
      const label = (result: Awaited<ReturnType<typeof read>>) => result.data.find(row => row.orderId === Number(fixture.order_id))?.createdByLabel;
      await client.query("UPDATE pg_temp.users SET is_service_account=false,full_name='E2E Автор',username='E2E-author' WHERE user_id=$1", [fixture.created_by]);
      const human = await read();
      expect(label(human)).toBe('E2E Автор');
      await client.query("UPDATE pg_temp.users SET full_name='' WHERE user_id=$1", [fixture.created_by]);
      expect(label(await read())).toBe('E2E-author');
      await client.query('UPDATE pg_temp.users SET is_service_account=true WHERE user_id=$1', [fixture.created_by]);
      const service = await read();
      expect(label(service)).toBe('Сервис интеграции ERP');
      expect(service.data.map(row => row.orderId)).toEqual(human.data.map(row => row.orderId));
      expect(service.total).toBe(human.total);
      await client.query('DELETE FROM pg_temp.users WHERE user_id=$1', [fixture.created_by]);
      expect(label(await read())).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});
