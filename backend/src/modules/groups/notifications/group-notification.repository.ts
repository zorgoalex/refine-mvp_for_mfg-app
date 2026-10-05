import { auditService } from '../../../common/audit/audit.service';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type {
  GroupNotificationDelivery,
  GroupNotificationEventType,
  GroupNotificationFact,
} from './group-notification.types';

type GroupNotificationDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

const SOURCE = 'groups-p8-notifications';
const notificationWrite = new PgNotificationWriteAdapter();

export class PgGroupNotificationRepository {
  constructor(private readonly database: DatabaseClient | GroupNotificationDatabase) {}

  async createNotifications(input: {
    eventType: GroupNotificationEventType;
    groupId: string;
    sourceId: string;
    fact: GroupNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: GroupNotificationDelivery[];
    auditMetadata: Record<string, unknown>;
  }): Promise<{ attempted: number; created: number; notificationIds: string[] }> {
    return withNotificationTransaction(this.database, async (tx) => {
      const reserved = await reserveFact(tx, input);
      if (!reserved) {
        return { attempted: input.deliveries.length, created: 0, notificationIds: [] };
      }

      const auditId = await insertAudit(tx, input);
      const notificationIds: string[] = [];

      for (const delivery of input.deliveries) {
        // Единый адаптер записи уведомлений (план 2026-10-03 §2.1); групповые события — не по правилам, без балуна.
        const inserted = await notificationWrite.insertIfAbsent(tx, {
          userId: Number(delivery.recipientUserId),
          level: 'info',
          title: delivery.title,
          message: delivery.message,
          entityType: 'group',
          entityId: input.groupId,
          sourceType: input.eventType,
          sourceId: `${input.sourceId}:${input.fact.factKey}`,
          idempotencyKey: notificationIdempotencyKey(input, delivery.recipientUserId),
          balloonMode: null,
        });
        if (inserted.created) notificationIds.push(inserted.notificationId);
      }

      await insertOutbox(tx, input, auditId, notificationIds);

      return {
        attempted: input.deliveries.length,
        created: notificationIds.length,
        notificationIds,
      };
    });
  }
}

function withNotificationTransaction<T>(
  database: DatabaseClient | GroupNotificationDatabase,
  handler: (tx: DatabaseClient) => Promise<T>,
): Promise<T> {
  if ('transaction' in database && typeof database.transaction === 'function') {
    return database.transaction(handler as (client: TransactionClient) => Promise<T>);
  }

  return handler(database);
}

async function reserveFact(
  tx: DatabaseClient,
  input: {
    eventType: GroupNotificationEventType;
    groupId: string;
    sourceId: string;
    fact: GroupNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: GroupNotificationDelivery[];
    auditMetadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'group', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING outbox_event_id
    `,
    [
      'GROUP_NOTIFICATION_FACT_RESERVED',
      input.groupId,
      JSON.stringify({
        source: SOURCE,
        eventType: input.eventType,
        sourceId: input.sourceId,
        factKey: input.fact.factKey,
        groupId: input.groupId,
      }),
      factIdempotencyKey(input),
    ],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export class UnavailableGroupNotificationRepository {
  async createNotifications(): Promise<{ attempted: number; created: number; notificationIds: string[] }> {
    return { attempted: 0, created: 0, notificationIds: [] };
  }
}

async function insertAudit(
  tx: DatabaseClient,
  input: {
    eventType: GroupNotificationEventType;
    groupId: string;
    sourceId: string;
    fact: GroupNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: GroupNotificationDelivery[];
    auditMetadata: Record<string, unknown>;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'groups.notification_created',
    entityType: 'group',
    entityId: input.groupId,
    actorUserId: nullableNumber(input.actorUserId),
    actorUsername: null,
    actorRole: null,
    requestId: input.requestId,
    source: SOURCE,
    relatedOrderId: nullableNumber(input.fact.auditRelated.orderId),
    relatedDeadlineId: nullableNumber(input.fact.auditRelated.deadlineId),
    metadata: {
      ...input.auditMetadata,
      source: SOURCE,
      eventType: input.eventType,
      sourceId: input.sourceId,
      factKey: input.fact.factKey,
      linkedEntity: input.fact.linkedEntity,
      relatedUserId: input.fact.auditRelated.userId ?? null,
      relatedEmployeeId: input.fact.auditRelated.employeeId ?? null,
      recipientUserIds: input.deliveries.map((delivery) => delivery.recipientUserId),
    },
  });
}

async function insertOutbox(
  tx: DatabaseClient,
  input: {
    eventType: GroupNotificationEventType;
    groupId: string;
    sourceId: string;
    fact: GroupNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: GroupNotificationDelivery[];
    auditMetadata: Record<string, unknown>;
  },
  auditId: string,
  notificationIds: string[],
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'group', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'GROUP_NOTIFICATION_CREATED',
      input.groupId,
      JSON.stringify({
        source: SOURCE,
        eventType: input.eventType,
        sourceId: input.sourceId,
        factKey: input.fact.factKey,
        groupId: input.groupId,
        auditId,
        notificationIds,
        recipientUserIds: input.deliveries.map((delivery) => delivery.recipientUserId),
      }),
      `groups:p8:evidence:${input.eventType}:${input.groupId}:${input.sourceId}:${input.fact.factKey}`,
    ],
  );
}

function factIdempotencyKey(input: {
  eventType: GroupNotificationEventType;
  groupId: string;
  sourceId: string;
  fact: GroupNotificationFact;
}): string {
  return `groups:p8:fact:${input.eventType}:${input.groupId}:${input.sourceId}:${input.fact.factKey}`;
}

function notificationIdempotencyKey(
  input: { eventType: GroupNotificationEventType; groupId: string; sourceId: string; fact: GroupNotificationFact },
  recipientUserId: string,
): string {
  return `groups:p8:${input.eventType}:${input.groupId}:${input.sourceId}:${input.fact.factKey}:${recipientUserId}`;
}

function nullableNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
