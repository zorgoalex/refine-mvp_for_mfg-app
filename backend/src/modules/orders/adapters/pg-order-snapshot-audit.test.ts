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
    await writeAudit(fakeTx(captured), 'orders.snapshot_export', actor, 77, 55, { requestId: 'req_s', formatVersion: '1.0.0' });
    const [{ text, params }] = captured;
    expect(text).toMatch(/INSERT INTO audit_log/i);
    expect(text).toMatch(/related_order_id/i);
    // Param indices per AUDIT_INSERT: [0]=event [1]=entity_type [2]=entity_id [3]=user_id
    // [4]=username [5]=role_code [6]=request_id [7]=source [8]=related_order_id
    // [9]=related_client_id ... [21]=metadata_json
    expect(params[0]).toBe('orders.snapshot_export');
    expect(params[4]).toBe('manager1');               // actorUsername
    expect(params[7]).toBe('backend-orders-command'); // source
    expect(params[8]).toBe(77);                       // related_order_id
    expect(params[9]).toBe(55);                       // related_client_id
  });

  it('passes null related_client_id when clientId is null', async () => {
    const captured: Array<{ text: string; params: readonly unknown[] }> = [];
    await writeAudit(fakeTx(captured), 'orders.snapshot_import.noop', actor, 88, null, { requestId: 'req_n' });
    const [{ params }] = captured;
    expect(params[9]).toBeNull(); // related_client_id
  });
});
