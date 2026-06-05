import { describe, expect, it } from 'vitest';
import { PgProjectNotificationRepository } from './project-notification.repository';

describe('PgProjectNotificationRepository', () => {
  it('inserts one notification per recipient with per-recipient idempotency key', async () => {
    const database = fakeDatabase();
    const repository = new PgProjectNotificationRepository(database);

    const result = await repository.createNotifications(baseInput());

    expect(result).toEqual({ attempted: 2, created: 2, notificationIds: ['n-1', 'n-2'] });
    const notificationParams = database.queries
      .filter((query) => query.text.includes('INSERT INTO notifications'))
      .map((query) => query.params);
    expect(notificationParams.map((params) => params[6])).toEqual([
      `projects:p8:PROJECT_ORDER_LINKS_CHANGED:${projectId()}:command-1:order:15:project:${projectId()}:added:1`,
      `projects:p8:PROJECT_ORDER_LINKS_CHANGED:${projectId()}:command-1:order:15:project:${projectId()}:added:2`,
    ]);
  });

  it('does not duplicate notifications on replay', async () => {
    const database = fakeDatabase({ duplicateNotifications: true });
    const repository = new PgProjectNotificationRepository(database);

    await expect(repository.createNotifications(baseInput())).resolves.toMatchObject({
      attempted: 2,
      created: 0,
      notificationIds: [],
    });
  });

  it('writes queryable audit dimensions for project and linked entity', async () => {
    const database = fakeDatabase();
    const repository = new PgProjectNotificationRepository(database);

    await repository.createNotifications(baseInput());

    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    expect(audit?.params).toEqual(expect.arrayContaining([
      projectId(),
      1,
      'request-1',
      'projects-p8-notifications',
      15,
    ]));
    expect(audit?.params.join('\n')).toContain('"eventType":"PROJECT_ORDER_LINKS_CHANGED"');
    expect(audit?.params.join('\n')).toContain('"recipientUserIds":["1","2"]');
  });

  it('sets related_order_id for PROJECT_ORDER_LINKS_CHANGED', async () => {
    const database = fakeDatabase();
    await new PgProjectNotificationRepository(database).createNotifications(baseInput());
    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[4]).toBe(15);
  });

  it('sets related_deadline_id and related_order_id when PROJECT_DEADLINE_OVERDUE has an order', async () => {
    const database = fakeDatabase();
    await new PgProjectNotificationRepository(database).createNotifications({
      ...baseInput(),
      eventType: 'PROJECT_DEADLINE_OVERDUE',
      fact: {
        factKey: 'deadline_instance:22:event:event-1',
        projectId: projectId(),
        linkedEntity: { entityType: 'deadline_instance', entityId: '22' },
        auditRelated: { orderId: '15', deadlineId: '22' },
      },
    });
    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[4]).toBe(15);
    expect(audit?.params[5]).toBe(22);
  });

  it('sets related user or employee facts in metadata without exposing names', async () => {
    const database = fakeDatabase();
    await new PgProjectNotificationRepository(database).createNotifications({
      ...baseInput(),
      eventType: 'PROJECT_MEMBER_ADDED',
      fact: {
        factKey: 'participant:user:158:role:manager:added',
        projectId: projectId(),
        linkedEntity: { entityType: 'user', entityId: '158' },
        auditRelated: { userId: '158' },
      },
      auditMetadata: { participantType: 'user' },
    });
    const metadata = String(database.queries.find((query) => query.text.includes('INSERT INTO audit_log'))?.params[6]);
    expect(metadata).toContain('"relatedUserId":"158"');
    expect(metadata).not.toContain('User 158');
    expect(metadata).not.toContain('displayName');
  });

  it('writes a P8 outbox evidence event without creating broad downstream dispatch', async () => {
    const database = fakeDatabase();
    await new PgProjectNotificationRepository(database).createNotifications(baseInput());
    const outbox = database.queries.filter((query) => query.text.includes('INSERT INTO outbox_events'));
    expect(outbox.map((query) => query.params[0])).toEqual([
      'PROJECT_NOTIFICATION_FACT_RESERVED',
      'PROJECT_NOTIFICATION_CREATED',
    ]);
    expect(outbox[1]?.params[3]).toContain('projects:p8:evidence:PROJECT_ORDER_LINKS_CHANGED');
  });

  it('writes one audit row and one evidence outbox row per normalized fact', async () => {
    const database = fakeDatabase();
    const repository = new PgProjectNotificationRepository(database);

    await repository.createNotifications(baseInput());
    await repository.createNotifications({
      ...baseInput(),
      fact: {
        factKey: `order:15:project:${projectId()}:removed`,
        projectId: projectId(),
        linkedEntity: { entityType: 'order', entityId: '15' },
        auditRelated: { orderId: '15' },
      },
    });

    expect(database.queries.filter((query) => query.text.includes('INSERT INTO audit_log'))).toHaveLength(2);
    expect(database.queries.filter((query) => query.params[0] === 'PROJECT_NOTIFICATION_CREATED')).toHaveLength(2);
  });

  it('does not duplicate audit rows when the fact was already reserved', async () => {
    const database = fakeDatabase({ duplicateFact: true });
    const repository = new PgProjectNotificationRepository(database);

    await expect(repository.createNotifications(baseInput())).resolves.toMatchObject({
      attempted: 2,
      created: 0,
      notificationIds: [],
    });

    expect(database.queries.some((query) => query.text.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it('uses the provided transaction client directly when no transaction method exists', async () => {
    const tx = fakeTransactionClient();
    const repository = new PgProjectNotificationRepository(tx);

    await expect(repository.createNotifications(baseInput())).resolves.toMatchObject({
      attempted: 2,
      created: 2,
    });

    expect(tx.transactionCalls).toBe(0);
    expect(tx.queries.some((query) => query.text.includes('INSERT INTO audit_log'))).toBe(true);
  });
});

function baseInput() {
  return {
    eventType: 'PROJECT_ORDER_LINKS_CHANGED' as const,
    projectId: projectId(),
    sourceId: 'command-1',
    actorUserId: '1',
    requestId: 'request-1',
    fact: {
      factKey: `order:15:project:${projectId()}:added`,
      projectId: projectId(),
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
      if (params[0] === 'PROJECT_NOTIFICATION_FACT_RESERVED') {
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
      if (params[0] === 'PROJECT_NOTIFICATION_FACT_RESERVED') {
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

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
