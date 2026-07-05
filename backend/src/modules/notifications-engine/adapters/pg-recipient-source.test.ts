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
    groupIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    orderStatusId: null,
    isOrderCompleted: false,
    payload: {},
    ...overrides,
  };
}

describe('PgRecipientSourceAdapter.group_participants fanout', () => {
  const adapter = new PgRecipientSourceAdapter();

  it('fans out only over effective context groupIds', async () => {
    const { client, calls } = fakeClient([{ user_id: 7 }, { user_id: 9 }]);
    const ctx = buildContext({
      orderId: 42,
      deadlineInstanceId: 'dl-uuid-1',
      groupIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    });

    const result = await adapter.resolveDynamic(client, 'group_participants', ctx);

    expect(result).toEqual([7, 9]);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain('group_participants');
    expect(sql).toContain('pp.group_id = ANY($1::uuid[])');
    expect(sql).not.toContain('group_order_groups');
    expect(sql).not.toContain('group_entity_links');
    expect(params).toEqual([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]);
  });

  it('returns [] when effective group attribution is empty', async () => {
    const { client, calls } = fakeClient([{ user_id: 5 }]);
    const ctx = buildContext({ orderId: 42, deadlineInstanceId: null, groupIds: [] });

    const result = await adapter.resolveDynamic(client, 'group_participants', ctx);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns [] when there is no order anchor (visibility anchor required, matches legacy P8)', async () => {
    const { client, calls } = fakeClient([{ user_id: 1 }]);
    const ctx = buildContext({ orderId: null, deadlineInstanceId: 'dl-uuid-1' });

    const result = await adapter.resolveDynamic(client, 'group_participants', ctx);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('PgRecipientSourceAdapter.workshop_head', () => {
  const adapter = new PgRecipientSourceAdapter();

  it('resolves heads of the order workshops to active users', async () => {
    const { client, calls } = fakeClient([{ user_id: 11 }, { user_id: 12 }]);
    const ctx = buildContext({ orderId: 42 });

    const result = await adapter.resolveDynamic(client, 'workshop_head', ctx);

    expect(result).toEqual([11, 12]);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain('order_workshops');
    expect(sql).toContain('workshop_heads');
    expect(sql).toContain('wh.is_active = true');
    expect(sql).toContain('u.is_active = true');
    expect(params).toEqual([42]);
  });

  it('returns [] when there is no order anchor', async () => {
    const { client, calls } = fakeClient([{ user_id: 1 }]);
    const ctx = buildContext({ orderId: null });

    const result = await adapter.resolveDynamic(client, 'workshop_head', ctx);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('PgRecipientSourceAdapter.direction_head', () => {
  const adapter = new PgRecipientSourceAdapter();

  it('resolves direction heads via both whole-workshop and work-center membership', async () => {
    const { client, calls } = fakeClient([{ user_id: 21 }]);
    const ctx = buildContext({ orderId: 42 });

    const result = await adapter.resolveDynamic(client, 'direction_head', ctx);

    expect(result).toEqual([21]);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain('order_workshops');
    expect(sql).toContain('direction_heads');
    expect(sql).toContain('direction_workshops');
    expect(sql).toContain('direction_work_centers');
    expect(sql).toContain('work_centers');
    expect(sql).toContain('d.is_active = true');
    expect(sql).toContain('dh.is_active = true');
    expect(params).toEqual([42]);
  });

  it('returns [] when there is no order anchor', async () => {
    const { client, calls } = fakeClient([{ user_id: 1 }]);
    const ctx = buildContext({ orderId: null });

    const result = await adapter.resolveDynamic(client, 'direction_head', ctx);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
