import { describe, expect, it } from 'vitest';
import { PgGroupNotificationRepository } from './group-notification.repository';

describe('PgGroupNotificationRepository', () => {
  it('inserts one notification per recipient with per-recipient idempotency key', async () => {
    const database = fakeDatabase();
    const repository = new PgGroupNotificationRepository(database);

    const result = await repository.createNotifications(baseInput());

    expect(result).toEqual({ attempted: 2, created: 2, notificationIds: ['n-1', 'n-2'] });
    const notificationParams = database.queries
      .filter((query) => query.text.includes('INSERT INTO notifications'))
      .map((query) => query.params);
    expect(notificationParams.map((params) => params[6])).toEqual([
      `groups:p8:GROUP_ORDER_LINKS_CHANGED:${groupId()}:command-1:order:15:group:${groupId()}:added:1`,
      `groups:p8:GROUP_ORDER_LINKS_CHANGED:${groupId()}:command-1:order:15:group:${groupId()}:added:2`,
    ]);
  });

  it('does not duplicate notifications on replay', async () => {
    const database = fakeDatabase({ duplicateNotifications: true });
    const repository = new PgGroupNotificationRepository(database);

    await expect(repository.createNotifications(baseInput())).resolves.toMatchObject({
      attempted: 2,
      created: 0,
      notificationIds: [],
    });
  });

  it('writes queryable audit dimensions for group and linked entity', async () => {
    const database = fakeDatabase();
    const repository = new PgGroupNotificationRepository(database);

    await repository.createNotifications(baseInput());

    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    expect(audit?.params).toEqual(expect.arrayContaining([
      groupId(),
      1,
      'request-1',
      'groups-p8-notifications',
      15,
    ]));
    expect(audit?.params.join('\n')).toContain('"eventType":"GROUP_ORDER_LINKS_CHANGED"');
    expect(audit?.params.join('\n')).toContain('"recipientUserIds":["1","2"]');
  });

  it('sets related_order_id for GROUP_ORDER_LINKS_CHANGED', async () => {
    const database = fakeDatabase();
    await new PgGroupNotificationRepository(database).createNotifications(baseInput());
    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    // params[8] = related_order_id in the standard 23-param AUDIT_INSERT
    expect(audit?.params[8]).toBe(15);
  });

  it('sets related_deadline_id and related_order_id when GROUP_DEADLINE_OVERDUE has an order', async () => {
    const database = fakeDatabase();
    await new PgGroupNotificationRepository(database).createNotifications({
      ...baseInput(),
      eventType: 'GROUP_DEADLINE_OVERDUE',
      fact: {
        factKey: 'deadline_instance:22:event:event-1',
        groupId: groupId(),
        linkedEntity: { entityType: 'deadline_instance', entityId: '22' },
        auditRelated: { orderId: '15', deadlineId: '22' },
      },
    });
    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    // params[8] = related_order_id, params[12] = related_deadline_id
    expect(audit?.params[8]).toBe(15);
    expect(audit?.params[12]).toBe(22);
  });

  it('sets related user or employee facts in metadata without exposing names', async () => {
    const database = fakeDatabase();
    await new PgGroupNotificationRepository(database).createNotifications({
      ...baseInput(),
      eventType: 'GROUP_MEMBER_ADDED',
      fact: {
        factKey: 'participant:user:158:role:manager:added',
        groupId: groupId(),
        linkedEntity: { entityType: 'user', entityId: '158' },
        auditRelated: { userId: '158' },
      },
      auditMetadata: { participantType: 'user' },
    });
    // params[22] = metadata_json in the standard 23-param AUDIT_INSERT
    const metadata = String(database.queries.find((query) => query.text.includes('INSERT INTO audit_log'))?.params[22]);
    expect(metadata).toContain('"relatedUserId":"158"');
    expect(metadata).not.toContain('User 158');
    expect(metadata).not.toContain('displayName');
  });

  it('writes a P8 outbox evidence event without creating broad downstream dispatch', async () => {
    const database = fakeDatabase();
    await new PgGroupNotificationRepository(database).createNotifications(baseInput());
    const outbox = database.queries.filter((query) => query.text.includes('INSERT INTO outbox_events'));
    expect(outbox.map((query) => query.params[0])).toEqual([
      'GROUP_NOTIFICATION_FACT_RESERVED',
      'GROUP_NOTIFICATION_CREATED',
    ]);
    expect(outbox[1]?.params[3]).toContain('groups:p8:evidence:GROUP_ORDER_LINKS_CHANGED');
  });

  it('writes one audit row and one evidence outbox row per normalized fact', async () => {
    const database = fakeDatabase();
    const repository = new PgGroupNotificationRepository(database);

    await repository.createNotifications(baseInput());
    await repository.createNotifications({
      ...baseInput(),
      fact: {
        factKey: `order:15:group:${groupId()}:removed`,
        groupId: groupId(),
        linkedEntity: { entityType: 'order', entityId: '15' },
        auditRelated: { orderId: '15' },
      },
    });

    expect(database.queries.filter((query) => query.text.includes('INSERT INTO audit_log'))).toHaveLength(2);
    expect(database.queries.filter((query) => query.params[0] === 'GROUP_NOTIFICATION_CREATED')).toHaveLength(2);
  });

  it('does not duplicate audit rows when the fact was already reserved', async () => {
    const database = fakeDatabase({ duplicateFact: true });
    const repository = new PgGroupNotificationRepository(database);

    await expect(repository.createNotifications(baseInput())).resolves.toMatchObject({
      attempted: 2,
      created: 0,
      notificationIds: [],
    });

    expect(database.queries.some((query) => query.text.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it('uses the provided transaction client directly when no transaction method exists', async () => {
    const tx = fakeTransactionClient();
    const repository = new PgGroupNotificationRepository(tx);

    await expect(repository.createNotifications(baseInput())).resolves.toMatchObject({
      attempted: 2,
      created: 2,
    });

    expect(tx.transactionCalls).toBe(0);
    expect(tx.queries.some((query) => query.text.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('audit notification_created: secret-shaped fields in auditMetadata are redacted by AuditService', async () => {
    const { auditService: svc } = await import('../../../common/audit/audit.service');
    const captured: Array<readonly unknown[]> = [];
    const fakeClient = {
      query: async (text: string, params: readonly unknown[] = []) => {
        if (text.includes('INSERT INTO audit_log')) captured.push(params);
        return { rows: [{ audit_id: 'notif-audit-1' }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      },
    };

    await svc.record(fakeClient as unknown as import('../../../database/database.types').DatabaseClient, {
      event: 'groups.notification_created',
      entityType: 'group',
      entityId: groupId(),
      actorUserId: 1,
      actorUsername: null,
      actorRole: null,
      requestId: 'req-notif-secret',
      source: 'groups-p8-notifications',
      relatedOrderId: 15,
      relatedDeadlineId: null,
      metadata: {
        source: 'groups-p8-notifications',
        eventType: 'GROUP_ORDER_LINKS_CHANGED',
        api_key: 'SUPER_SECRET',
        recipientUserIds: ['1', '2'],
      },
    });

    expect(captured).toHaveLength(1);
    const params = captured[0];
    // Dimensions
    expect(params[0]).toBe('groups.notification_created');
    expect(params[1]).toBe('group');
    expect(params[2]).toBe(groupId());
    expect(params[6]).toBe('req-notif-secret');
    expect(params[7]).toBe('groups-p8-notifications');
    expect(params[8]).toBe(15);   // related_order_id
    expect(params[12]).toBeNull(); // related_deadline_id
    // metadata_json: api_key redacted, eventType + recipientUserIds preserved
    const metaJson = JSON.parse(params[22] as string);
    expect(metaJson.eventType).toBe('GROUP_ORDER_LINKS_CHANGED');
    expect(metaJson.api_key).toBe('[REDACTED]');
    expect(metaJson.recipientUserIds).toEqual(['1', '2']);
    expect(JSON.stringify(metaJson)).not.toContain('SUPER_SECRET');
  });
});

function baseInput() {
  return {
    eventType: 'GROUP_ORDER_LINKS_CHANGED' as const,
    groupId: groupId(),
    sourceId: 'command-1',
    actorUserId: '1',
    requestId: 'request-1',
    fact: {
      factKey: `order:15:group:${groupId()}:added`,
      groupId: groupId(),
      linkedEntity: { entityType: 'order' as const, entityId: '15' },
      auditRelated: { orderId: '15' },
    },
    deliveries: [
      { recipientUserId: '1', title: 'Authorized', message: 'Authorized message' },
      { recipientUserId: '2', title: 'Redacted', message: 'Redacted message' },
    ],
    auditMetadata: {},
  };
}

function fakeDatabase({
  duplicateNotifications = false,
  duplicateFact = false,
}: {
  duplicateNotifications?: boolean;
  duplicateFact?: boolean;
} = {}) {
  let notificationSequence = 0;
  const database = {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query<T>(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (params[0] === 'GROUP_NOTIFICATION_FACT_RESERVED') {
        return duplicateFact
          ? { rows: [] as T[], rowCount: 0 }
          : { rows: [{ outbox_event_id: 'outbox-1' }] as T[], rowCount: 1 };
      }
      if (text.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }] as T[] };
      if (text.includes('INSERT INTO notifications')) {
        if (duplicateNotifications) return { rows: [] as T[] };
        notificationSequence += 1;
        return { rows: [{ notification_id: `n-${notificationSequence}` }] as T[] };
      }
      return { rows: [] as T[] };
    },
    async transaction<T>(handler: (client: typeof database) => Promise<T>): Promise<T> {
      return handler(this);
    },
  };
  return database;
}

function fakeTransactionClient() {
  let notificationSequence = 0;
  return {
    transactionCalls: 0,
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query<T>(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (params[0] === 'GROUP_NOTIFICATION_FACT_RESERVED') {
        return { rows: [{ outbox_event_id: 'outbox-1' }] as T[], rowCount: 1 };
      }
      if (text.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }] as T[] };
      if (text.includes('INSERT INTO notifications')) {
        notificationSequence += 1;
        return { rows: [{ notification_id: `n-${notificationSequence}` }] as T[] };
      }
      return { rows: [] as T[] };
    },
  };
}

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
