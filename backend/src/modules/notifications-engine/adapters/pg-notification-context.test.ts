import { describe, expect, it } from 'vitest';
import type { DatabaseClient, QueryResult } from '../../../database/database.types';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import { PgNotificationContextBuilder } from './pg-notification-context';

interface FakeQueryResult {
  rows: Array<Record<string, unknown>>;
}

function makeFakeClient(responses: FakeQueryResult[]): DatabaseClient {
  let callIndex = 0;
  const client = {
    query: async (): Promise<QueryResult> => {
      const response = responses[callIndex] ?? { rows: [] };
      callIndex += 1;
      return response as unknown as QueryResult;
    },
  };
  return client as unknown as DatabaseClient;
}

const baseEnvelope: OutboxEventRecord = {
  outboxEventId: '00000000-0000-0000-0000-000000000001',
  eventType: 'deadline.event.created',
  aggregateType: 'deadline',
  aggregateId: '11111111-1111-4111-8111-111111111111',
  payload: {
    deadlineEventId: '22222222-2222-4222-8222-222222222222',
    eventType: 'DEADLINE_EXPIRED',
    entityType: 'order',
    entityId: '500',
    orderId: 500,
    requestId: 'req-1',
    source: 'deadline-engine',
  },
};

describe('PgNotificationContextBuilder', () => {
  it('resolves eventType to the inner type for the deadline envelope', async () => {
    const client = makeFakeClient([
      {
        rows: [
          { order_status_id: 11, client_id: 42, completion_date: null },
        ],
      },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.eventType).toBe('DEADLINE_EXPIRED');
    expect(ctx.aggregateType).toBe('deadline');
    expect(ctx.aggregateId).toBe('11111111-1111-4111-8111-111111111111');
    expect(ctx.outboxEventId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('extracts orderId from the deadline envelope payload and tops up order fields', async () => {
    const client = makeFakeClient([
      {
        rows: [
          { order_status_id: 11, client_id: 42, completion_date: null },
        ],
      },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.orderId).toBe(500);
    expect(ctx.clientId).toBe(42);
    expect(ctx.orderStatusId).toBe(11);
    expect(ctx.isOrderCompleted).toBe(false);
  });

  it('populates deadlineInstanceId from the deadline envelope aggregate', async () => {
    const client = makeFakeClient([
      {
        rows: [
          { order_status_id: 11, client_id: 42, completion_date: null },
        ],
      },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.deadlineInstanceId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('populates deadlineEntityType from deadline_instances.entity_type', async () => {
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] },
      { rows: [{ entity_type: 'order' }] },
      { rows: [{ project_id: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC' }] },
      { rows: [{ exists: true }] },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.deadlineEntityType).toBe('order');
  });

  it('uses deadline_instances.entity_type instead of a mismatched payload entityType', async () => {
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] },
      { rows: [{ entity_type: 'order_stage' }] },
      { rows: [] },
      { rows: [{ exists: true }] },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, {
      ...baseEnvelope,
      payload: {
        ...baseEnvelope.payload,
        entityType: 'order',
      },
    });

    expect(ctx.deadlineEntityType).toBe('order_stage');
  });

  it('fails closed to null when the deadline instance row is missing', async () => {
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ exists: true }] },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.deadlineEntityType).toBeNull();
  });

  it('derives projectIds from current order project links for order events', async () => {
    const orderEnvelope: OutboxEventRecord = {
      outboxEventId: '00000000-0000-0000-0000-000000000006',
      eventType: 'order.production_status_changed',
      aggregateType: 'order',
      aggregateId: '500',
      payload: { orderId: 500, beforeStatus: '11', afterStatus: '12' },
      attempts: 0,
    };
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] },
      {
        rows: [
          { project_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
          { project_id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB' },
        ],
      },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, orderEnvelope);

    expect(ctx.projectIds).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });

  it('uses explicit deadline-instance project attribution for deadline envelopes', async () => {
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] },
      { rows: [{ entity_type: 'order' }] },
      { rows: [{ project_id: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC' }] },
      { rows: [{ exists: true }] },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.projectIds).toEqual(['cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
    expect(ctx.isCurrentDeadlineEvent).toBe(true);
  });

  it('marks isOrderCompleted when the order has a completion_date', async () => {
    const client = makeFakeClient([
      {
        rows: [
          { order_status_id: 11, client_id: 42, completion_date: '2026-06-01T00:00:00.000Z' },
        ],
      },
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.isOrderCompleted).toBe(true);
  });

  it('leaves order fields null when the order is missing', async () => {
    const client = makeFakeClient([{ rows: [] }]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.orderId).toBe(500);
    expect(ctx.clientId).toBeNull();
    expect(ctx.orderStatusId).toBeNull();
    expect(ctx.isOrderCompleted).toBe(false);
  });

  it('does not touch the order top-up query when the envelope has no orderId', async () => {
    const noOrderEnvelope: OutboxEventRecord = {
      outboxEventId: '00000000-0000-0000-0000-000000000002',
      eventType: 'deadline.event.created',
      aggregateType: 'deadline',
      aggregateId: '11111111-1111-4111-8111-111111111111',
      payload: {
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'DEADLINE_EXPIRED',
        entityType: 'order',
        entityId: '500',
      },
    };
    let queryCalls = 0;
    const client = {
      query: async (): Promise<QueryResult> => {
        queryCalls += 1;
        return { rows: [] } as unknown as QueryResult;
      },
    } as unknown as DatabaseClient;
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, noOrderEnvelope);

    expect(ctx.orderId).toBeNull();
    expect(ctx.deadlineInstanceId).toBe('11111111-1111-4111-8111-111111111111');
    expect(queryCalls).toBe(2);
  });

  it('keeps the legacy order.* eventType unchanged', async () => {
    const orderEnvelope: OutboxEventRecord = {
      outboxEventId: '00000000-0000-0000-0000-000000000003',
      eventType: 'order.production_status_changed',
      aggregateType: 'order',
      aggregateId: '500',
      payload: { orderId: 500, beforeStatus: '11', afterStatus: '12' },
    };
    const client = makeFakeClient([{ rows: [] }]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, orderEnvelope);

    expect(ctx.eventType).toBe('order.production_status_changed');
    expect(ctx.deadlineInstanceId).toBeNull();
  });

  it('computes isCurrentDeadlineEvent=true for a deadline envelope when the staleness query returns a row', async () => {
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] }, // order top-up
      { rows: [{ entity_type: 'order' }] }, // deadline entity type
      { rows: [] }, // project attribution
      { rows: [{ exists: true }] }, // staleness query: row found -> current
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.isCurrentDeadlineEvent).toBe(true);
  });

  it('computes isCurrentDeadlineEvent=false for a deadline envelope when the staleness query returns no row', async () => {
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] }, // order top-up
      { rows: [{ entity_type: 'order' }] }, // deadline entity type
      { rows: [] }, // project attribution
      { rows: [] }, // staleness query: no row -> stale
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, baseEnvelope);

    expect(ctx.isCurrentDeadlineEvent).toBe(false);
  });

  it('defaults isCurrentDeadlineEvent=true for non-deadline events (no staleness query issued)', async () => {
    const orderEnvelope: OutboxEventRecord = {
      outboxEventId: '00000000-0000-0000-0000-000000000003',
      eventType: 'order.production_status_changed',
      aggregateType: 'order',
      aggregateId: '500',
      payload: { orderId: 500, beforeStatus: '11', afterStatus: '12' },
    };
    let queryCalls = 0;
    const client = {
      query: async (): Promise<QueryResult> => {
        queryCalls += 1;
        return { rows: [] } as unknown as QueryResult;
      },
    } as unknown as DatabaseClient;
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, orderEnvelope);

    expect(ctx.isCurrentDeadlineEvent).toBe(true);
    expect(queryCalls).toBe(2); // order top-up + project attribution
  });

  it('defaults isCurrentDeadlineEvent=true for a deadline envelope missing payload.deadlineEventId (cannot evaluate staleness)', async () => {
    const noEventIdEnvelope: OutboxEventRecord = {
      outboxEventId: '00000000-0000-0000-0000-000000000004',
      eventType: 'deadline.event.created',
      aggregateType: 'deadline',
      aggregateId: '11111111-1111-4111-8111-111111111111',
      payload: {
        eventType: 'DEADLINE_EXPIRED',
        entityType: 'order',
        entityId: '500',
        orderId: 500,
        // deadlineEventId intentionally omitted
      },
    };
    const client = makeFakeClient([
      { rows: [{ order_status_id: 11, client_id: 42, completion_date: null }] }, // order top-up
      { rows: [{ entity_type: 'order' }] }, // deadline entity type
      { rows: [] }, // project attribution
    ]);
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, noEventIdEnvelope);

    expect(ctx.isCurrentDeadlineEvent).toBe(true);
  });

  it('defaults isCurrentDeadlineEvent=true for a deadline envelope with no orderId (cannot evaluate staleness)', async () => {
    const noOrderEnvelope: OutboxEventRecord = {
      outboxEventId: '00000000-0000-0000-0000-000000000005',
      eventType: 'deadline.event.created',
      aggregateType: 'deadline',
      aggregateId: '11111111-1111-4111-8111-111111111111',
      payload: {
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'DEADLINE_EXPIRED',
        entityType: 'order',
        entityId: '500',
        // orderId intentionally omitted
      },
    };
    let queryCalls = 0;
    const client = {
      query: async (): Promise<QueryResult> => {
        queryCalls += 1;
        return { rows: [] } as unknown as QueryResult;
      },
    } as unknown as DatabaseClient;
    const builder = new PgNotificationContextBuilder();
    const ctx = await builder.buildContext(client, noOrderEnvelope);

    expect(ctx.isCurrentDeadlineEvent).toBe(true);
    expect(queryCalls).toBe(2);
  });
});
