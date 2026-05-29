import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { writeAudit } from './pg-order-snapshot';

function fakeTx(captured: Array<{ text: string; params: readonly unknown[] }>): TransactionClient {
  return {
    raw: undefined as never,
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      captured.push({ text, params: [...params] });
      return { rows: [{ audit_id: 'aud-s' } as unknown as T], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
    },
  };
}
const actor: CurrentUser = { id: '9', username: 'manager1', role: 'manager', roleId: 10, permissions: [] };

describe('order snapshot writeAudit', () => {
  it('writes a query-ready snapshot audit row via AuditService', async () => {
    const captured: Array<{ text: string; params: readonly unknown[] }> = [];
    await writeAudit(fakeTx(captured), 'orders.snapshot_export', actor, 77, { requestId: 'req_s', formatVersion: '1.0.0' });
    const [{ text, params }] = captured;
    expect(text).toMatch(/INSERT INTO audit_log/i);
    expect(text).toMatch(/related_order_id/i);
    expect(params).toContain('orders.snapshot_export');
    expect(params).toContain('manager1');
    expect(params).toContain('backend-orders-command');
    expect(params).toContain(77);
  });
});
