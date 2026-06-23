import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type {
  ProjectNotificationDelivery,
  ProjectNotificationEventType,
  ProjectNotificationFact,
} from './project-notification.types';

type ProjectNotificationDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

interface NotificationRow extends QueryResultRow {
  notification_id: string;
}

const SOURCE = 'projects-p8-notifications';

export class PgProjectNotificationRepository {
  constructor(private readonly database: DatabaseClient | ProjectNotificationDatabase) {}

  async createNotifications(input: {
    eventType: ProjectNotificationEventType;
    projectId: string;
    sourceId: string;
    fact: ProjectNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: ProjectNotificationDelivery[];
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
        const inserted = await tx.query<NotificationRow>(
          `
          INSERT INTO notifications (
            user_id, level, title, message, entity_type, entity_id,
            source_type, source_id, idempotency_key
          )
          VALUES ($1::bigint, 'info', $2, $3, 'project', $4, $5, $6, $7)
          ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
          RETURNING notification_id
          `,
          [
            delivery.recipientUserId,
            delivery.title,
            delivery.message,
            input.projectId,
            input.eventType,
            `${input.sourceId}:${input.fact.factKey}`,
            notificationIdempotencyKey(input, delivery.recipientUserId),
          ],
        );
        if (inserted.rows[0]) notificationIds.push(String(inserted.rows[0].notification_id));
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
  database: DatabaseClient | ProjectNotificationDatabase,
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
    eventType: ProjectNotificationEventType;
    projectId: string;
    sourceId: string;
    fact: ProjectNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: ProjectNotificationDelivery[];
    auditMetadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'project', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING outbox_event_id
    `,
    [
      'PROJECT_NOTIFICATION_FACT_RESERVED',
      input.projectId,
      JSON.stringify({
        source: SOURCE,
        eventType: input.eventType,
        sourceId: input.sourceId,
        factKey: input.fact.factKey,
        projectId: input.projectId,
      }),
      factIdempotencyKey(input),
    ],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export class UnavailableProjectNotificationRepository {
  async createNotifications(): Promise<{ attempted: number; created: number; notificationIds: string[] }> {
    return { attempted: 0, created: 0, notificationIds: [] };
  }
}

async function insertAudit(
  tx: DatabaseClient,
  input: {
    eventType: ProjectNotificationEventType;
    projectId: string;
    sourceId: string;
    fact: ProjectNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: ProjectNotificationDelivery[];
    auditMetadata: Record<string, unknown>;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'projects.notification_created',
    entityType: 'project',
    entityId: input.projectId,
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
    eventType: ProjectNotificationEventType;
    projectId: string;
    sourceId: string;
    fact: ProjectNotificationFact;
    actorUserId: string | null;
    requestId: string;
    deliveries: ProjectNotificationDelivery[];
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
    VALUES ($1, 'project', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'PROJECT_NOTIFICATION_CREATED',
      input.projectId,
      JSON.stringify({
        source: SOURCE,
        eventType: input.eventType,
        sourceId: input.sourceId,
        factKey: input.fact.factKey,
        projectId: input.projectId,
        auditId,
        notificationIds,
        recipientUserIds: input.deliveries.map((delivery) => delivery.recipientUserId),
      }),
      `projects:p8:evidence:${input.eventType}:${input.projectId}:${input.sourceId}:${input.fact.factKey}`,
    ],
  );
}

function factIdempotencyKey(input: {
  eventType: ProjectNotificationEventType;
  projectId: string;
  sourceId: string;
  fact: ProjectNotificationFact;
}): string {
  return `projects:p8:fact:${input.eventType}:${input.projectId}:${input.sourceId}:${input.fact.factKey}`;
}

function notificationIdempotencyKey(
  input: { eventType: ProjectNotificationEventType; projectId: string; sourceId: string; fact: ProjectNotificationFact },
  recipientUserId: string,
): string {
  return `projects:p8:${input.eventType}:${input.projectId}:${input.sourceId}:${input.fact.factKey}:${recipientUserId}`;
}

function nullableNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
