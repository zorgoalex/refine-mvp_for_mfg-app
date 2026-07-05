import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import type { GroupNotificationService } from '../../groups/notifications/group-notification.service';
import type {
  DeadlineProjectDeadlineOverdueNotificationInput,
  DeadlineProjectDeadlineOverdueNotificationPort,
  DeadlineProjectDeadlineOverdueSkipReason,
} from '../application/deadline.types';

interface ProjectLinkRow extends QueryResultRow {
  group_id: string;
}

export class PgGroupDeadlineOverdueNotificationPort implements DeadlineProjectDeadlineOverdueNotificationPort {
  constructor(
    private readonly database: DatabaseClient,
    private readonly notifications: GroupNotificationService,
    private readonly enabled: boolean,
  ) {}

  async notifyDeadlineOverdue(input: DeadlineProjectDeadlineOverdueNotificationInput): Promise<void> {
    if (!this.enabled) {
      await this.recordSkipped(input, 'group_p8_notifications_disabled');
      return;
    }
    if (!input.orderId) {
      await this.recordSkipped(input, 'no_order_visibility_anchor');
      return;
    }

    const result = await this.database.query<ProjectLinkRow>(
      `
      WITH deadline_links AS (
        SELECT pel.group_id
        FROM public.group_entity_links pel
        WHERE pel.entity_type_code = 'deadline_instance'
          AND pel.entity_id_text = $1
          AND pel.valid_to IS NULL
      ),
      order_links AS (
        SELECT pop.group_id
        FROM public.group_order_groups pop
        WHERE pop.order_id = $2::bigint
          AND pop.valid_to IS NULL
      )
      SELECT DISTINCT group_id::text AS group_id
      FROM (
        SELECT group_id FROM deadline_links
        UNION
        SELECT group_id FROM order_links
      ) linked_groups
      ORDER BY group_id::text ASC
      `,
      [input.deadlineInstanceId, input.orderId],
    );

    if (result.rows.length === 0) {
      await this.recordSkipped(input, 'no_group_link');
      return;
    }

    for (const row of result.rows) {
      await this.notifications.handleGroupDeadlineOverdue({
        groupId: row.group_id,
        sourceId: input.deadlineEventId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        deadlineInstanceId: input.deadlineInstanceId,
        orderId: input.orderId,
      });
    }
  }

  async recordSkipped(
    input: DeadlineProjectDeadlineOverdueNotificationInput,
    skipReason: DeadlineProjectDeadlineOverdueSkipReason,
  ): Promise<void> {
    await this.database.query(
      `
      INSERT INTO public.outbox_events (
        event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
      )
      VALUES (
        'GROUP_DEADLINE_OVERDUE_SKIPPED',
        'deadline_instance',
        $1,
        $2::jsonb,
        $3
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        input.deadlineInstanceId,
        JSON.stringify({
          source: 'groups-p8-notifications',
          eventType: 'GROUP_DEADLINE_OVERDUE',
          deadlineEventId: input.deadlineEventId,
          deadlineInstanceId: input.deadlineInstanceId,
          orderId: input.orderId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          skipReason,
        }),
        `groups:p8:deadline-overdue-skipped:${input.deadlineEventId}:${skipReason}`,
      ],
    );
  }
}
