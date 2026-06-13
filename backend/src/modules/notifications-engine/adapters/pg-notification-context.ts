import type { DatabaseClient } from '../../../database/database.types';
import { resolveEffectiveEventType } from '../domain/deadline-event-extractor';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import type { NotificationContextBuilderPort } from '../ports/notification-context.port';

interface OrderTopUpRow {
  order_status_id: number | string | null;
  client_id: number | string | null;
  completion_date: string | Date | null;
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

    return {
      eventType: resolveEffectiveEventType(event),
      outboxEventId: event.outboxEventId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      orderId,
      clientId,
      paymentId,
      deadlineId,
      deadlineInstanceId: event.aggregateType === 'deadline' ? event.aggregateId : null,
      orderStatusId,
      isOrderCompleted,
      isCurrentDeadlineEvent: true,
      payload,
    };
  }
}
