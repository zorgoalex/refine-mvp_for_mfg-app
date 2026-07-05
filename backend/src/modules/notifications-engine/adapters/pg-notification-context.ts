import type { DatabaseClient } from '../../../database/database.types';
import { resolveEffectiveEventType } from '../domain/deadline-event-extractor';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { DeadlineNotificationEntityType, NotificationEventContext } from '../domain/notification-rule.types';
import type { NotificationContextBuilderPort } from '../ports/notification-context.port';

interface OrderTopUpRow {
  order_status_id: number | string | null;
  client_id: number | string | null;
  completion_date: string | Date | null;
}

interface DeadlineEventCurrentRow {
  exists: boolean;
}

interface DeadlineEntityTypeRow {
  entity_type: unknown;
}

interface GroupAttributionRow {
  group_id: string;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toDeadlineEntityType(value: unknown): DeadlineNotificationEntityType | null {
  return value === 'order' || value === 'order_stage' ? value : null;
}

export class PgNotificationContextBuilder implements NotificationContextBuilderPort {
  async buildContext(client: DatabaseClient, event: OutboxEventRecord): Promise<NotificationEventContext> {
    const payload = event.payload ?? {};

    let orderId = toNullableNumber(payload.orderId);
    if (orderId == null && event.aggregateType === 'order') {
      orderId = toNullableNumber(event.aggregateId);
    }
    let clientId = toNullableNumber(payload.clientId);
    const paymentId = toNullableNumber(payload.paymentId);
    const deadlineId = toNullableNumber(payload.deadlineId);
    let orderStatusId = toNullableNumber(payload.orderStatusId);
    let isOrderCompleted = false;

    if (orderId != null) {
      const result = await client.query<OrderTopUpRow>(
        `SELECT order_status_id, client_id, completion_date
           FROM public.orders
          WHERE order_id = $1::bigint AND delete_flag = false
          LIMIT 1`,
        [orderId],
      );
      const row = result.rows[0];
      if (row) {
        orderStatusId = orderStatusId ?? toNullableNumber(row.order_status_id);
        clientId = clientId ?? toNullableNumber(row.client_id);
        isOrderCompleted = row.completion_date != null;
      }
    }

    const deadlineInstanceId = event.aggregateType === 'deadline' ? event.aggregateId : null;
    const deadlineEntityType = await this.resolveDeadlineEntityType(client, deadlineInstanceId);
    const groupIds = await this.resolveGroupIds(client, orderId, deadlineInstanceId);
    const isCurrentDeadlineEvent = await this.resolveIsCurrentDeadlineEvent(client, event, orderId);

    return {
      eventType: resolveEffectiveEventType(event),
      outboxEventId: event.outboxEventId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      orderId,
      clientId,
      paymentId,
      deadlineId,
      deadlineEntityType,
      deadlineInstanceId,
      groupIds,
      orderStatusId,
      isOrderCompleted,
      isCurrentDeadlineEvent,
      payload,
    };
  }

  private async resolveDeadlineEntityType(
    client: DatabaseClient,
    deadlineInstanceId: string | null,
  ): Promise<DeadlineNotificationEntityType | null> {
    if (deadlineInstanceId == null) {
      return null;
    }

    const result = await client.query<DeadlineEntityTypeRow>(
      `SELECT entity_type
         FROM public.deadline_instances
        WHERE deadline_id = $1::uuid
        LIMIT 1`,
      [deadlineInstanceId],
    );

    return toDeadlineEntityType(result.rows[0]?.entity_type);
  }

  /**
   * Mirrors `PgDeadlineRepository.isDeadlineEventCurrentForOrder`: a
   * DEADLINE_EXPIRED deadline_events row is "current" if it is the latest
   * (by event_at, created_at) DEADLINE_EXPIRED row for its
   * (order, deadline_instance) pair and the deadline_instance is not
   * cancelled/superseded. Returns `true` (no staleness gate) for non-deadline
   * envelopes or when required identifiers are missing from the payload —
   * fail-open here matches `NotificationEventContext.isCurrentDeadlineEvent`'s
   * documented default and avoids spuriously gating events the engine cannot
   * evaluate.
   */
  private async resolveIsCurrentDeadlineEvent(
    client: DatabaseClient,
    event: OutboxEventRecord,
    orderId: number | null,
  ): Promise<boolean> {
    if (event.aggregateType !== 'deadline' || orderId == null) {
      return true;
    }

    const payload = event.payload ?? {};
    const deadlineEventId = toNullableString(payload.deadlineEventId);
    const deadlineInstanceId = toNullableString(event.aggregateId);
    if (!deadlineEventId || !deadlineInstanceId) {
      return true;
    }

    const result = await client.query<DeadlineEventCurrentRow>(
      `
      SELECT true AS exists
      FROM deadline_events e
      JOIN deadline_instances d ON d.deadline_id = e.deadline_id
      WHERE e.order_id = $1
        AND e.deadline_event_id = $2
        AND e.event_type = 'DEADLINE_EXPIRED'
        AND d.deadline_id = $3
        AND d.order_id = $1
        AND d.status NOT IN ('cancelled', 'superseded')
        AND e.deadline_event_id = (
          SELECT latest.deadline_event_id
          FROM deadline_events latest
          WHERE latest.deadline_id = d.deadline_id
            AND latest.order_id = $1
            AND latest.event_type = 'DEADLINE_EXPIRED'
          ORDER BY latest.event_at DESC, latest.created_at DESC
          LIMIT 1
        )
      LIMIT 1
      `,
      [orderId, deadlineEventId, deadlineInstanceId],
    );

    return result.rows.length > 0;
  }

  private async resolveGroupIds(
    client: DatabaseClient,
    orderId: number | null,
    deadlineInstanceId: string | null,
  ): Promise<string[]> {
    if (orderId == null && deadlineInstanceId == null) {
      return [];
    }

    const result = deadlineInstanceId != null
      ? await client.query<GroupAttributionRow>(
        `
        WITH explicit_deadline_groups AS (
          SELECT DISTINCT pel.group_id
          FROM public.group_entity_links pel
          WHERE pel.entity_type_code = 'deadline_instance'
            AND pel.entity_id_text = $1::text
            AND pel.valid_to IS NULL
        ),
        derived_order_groups AS (
          SELECT DISTINCT pop.group_id
          FROM public.group_order_groups pop
          WHERE pop.order_id = $2::bigint
            AND pop.valid_to IS NULL
        )
        SELECT group_id
        FROM explicit_deadline_groups
        UNION
        SELECT group_id
        FROM derived_order_groups
        WHERE NOT EXISTS (SELECT 1 FROM explicit_deadline_groups)
        `,
        [deadlineInstanceId, orderId],
      )
      : await client.query<GroupAttributionRow>(
        `
        SELECT DISTINCT pop.group_id
        FROM public.group_order_groups pop
        WHERE pop.order_id = $1::bigint
          AND pop.valid_to IS NULL
        `,
        [orderId],
      );

    return result.rows
      .map((row) => row.group_id)
      .filter((groupId): groupId is string => typeof groupId === 'string' && groupId.trim() !== '')
      .map((groupId) => groupId.toLowerCase());
  }
}
