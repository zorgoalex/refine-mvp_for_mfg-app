import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import { PgRecipientSourceAdapter } from './pg-recipient-source';

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function fakeClient(rows: Array<Record<string, unknown>>): { client: DatabaseClient; calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length } as never;
    },
  } as unknown as DatabaseClient;
  return { client, calls };
}

function buildContext(overrides: Partial<NotificationEventContext>): NotificationEventContext {
  return {
    eventType: 'DEADLINE_EXPIRED',
    outboxEventId: 'outbox-1',
    aggregateType: 'deadline',
    aggregateId: 'dl-uuid-1',
    orderId: 42,
    clientId: null,
    paymentId: null,
    deadlineId: null,
    deadlineInstanceId: 'dl-uuid-1',
    orderStatusId: null,
    isOrderCompleted: false,
    payload: {},
    ...overrides,
  };
}

describe('PgRecipientSourceAdapter.project_participants fanout', () => {
  const adapter = new PgRecipientSourceAdapter();

  it('fans out over BOTH order links and deadline_instance generic links (P8 parity)', async () => {
    const { client, calls } = fakeClient([{ user_id: 7 }, { user_id: 9 }]);
    const ctx = buildContext({ orderId: 42, deadlineInstanceId: 'dl-uuid-1' });

    const result = await adapter.resolveDynamic(client, 'project_participants', ctx);

    expect(result).toEqual([7, 9]);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    // Both project sources must be queried (the deadline_instance generic-link
    // half is the convergence parity fix for the legacy P8 port).
    expect(sql).toContain('project_order_projects');
    expect(sql).toContain('project_entity_links');
    expect(sql).toContain("entity_type_code = 'deadline_instance'");
    expect(sql.toUpperCase()).toContain('UNION');
    // The deadline_instance anchor (ctx.deadlineInstanceId) must be passed so
    // projects linked ONLY via a generic deadline link are reachable.
    expect(params).toEqual([42, 'dl-uuid-1']);
  });

  it('still resolves when there is no deadline link (deadlineInstanceId null degrades to order-only fanout)', async () => {
    const { client, calls } = fakeClient([{ user_id: 5 }]);
    const ctx = buildContext({ orderId: 42, deadlineInstanceId: null });

    const result = await adapter.resolveDynamic(client, 'project_participants', ctx);

    expect(result).toEqual([5]);
    // deadlineInstanceId is passed as null; the deadline_links branch yields no
    // rows (entity_id_text = NULL is never true) so the UNION degrades safely.
    expect(calls[0].params).toEqual([42, null]);
  });

  it('returns [] when there is no order anchor (visibility anchor required, matches legacy P8)', async () => {
    const { client, calls } = fakeClient([{ user_id: 1 }]);
    const ctx = buildContext({ orderId: null, deadlineInstanceId: 'dl-uuid-1' });

    const result = await adapter.resolveDynamic(client, 'project_participants', ctx);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
