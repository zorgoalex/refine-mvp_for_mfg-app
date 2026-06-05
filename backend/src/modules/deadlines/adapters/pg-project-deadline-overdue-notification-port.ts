import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import type { ProjectNotificationService } from '../../projects/notifications/project-notification.service';
import type { DeadlineProjectDeadlineOverdueNotificationPort } from '../application/deadline.types';

interface ProjectLinkRow extends QueryResultRow {
  project_id: string;
}

export class PgProjectDeadlineOverdueNotificationPort implements DeadlineProjectDeadlineOverdueNotificationPort {
  constructor(
    private readonly database: DatabaseClient,
    private readonly notifications: ProjectNotificationService,
    private readonly enabled: boolean,
  ) {}

  async notifyDeadlineOverdue(input: {
    deadlineEventId: string;
    deadlineInstanceId: string;
    orderId: string | null;
    actorUserId: string | null;
    requestId: string;
  }): Promise<void> {
    if (!this.enabled) {
      await this.recordSkipped(input, 'project_p8_notifications_disabled');
      return;
    }
    if (!input.orderId) {
      await this.recordSkipped(input, 'no_order_visibility_anchor');
      return;
    }

    const result = await this.database.query<ProjectLinkRow>(
      `
      WITH deadline_links AS (
        SELECT pel.project_id
        FROM public.project_entity_links pel
        WHERE pel.entity_type_code = 'deadline_instance'
          AND pel.entity_id_text = $1
          AND pel.valid_to IS NULL
      ),
      order_links AS (
        SELECT pop.project_id
        FROM public.project_order_projects pop
        WHERE pop.order_id = $2::bigint
          AND pop.valid_to IS NULL
      )
      SELECT DISTINCT project_id::text AS project_id
      FROM (
        SELECT project_id FROM deadline_links
        UNION
        SELECT project_id FROM order_links
      ) linked_projects
      ORDER BY project_id::text ASC
      `,
      [input.deadlineInstanceId, input.orderId],
    );

    if (result.rows.length === 0) {
      await this.recordSkipped(input, 'no_project_link');
      return;
    }

    for (const row of result.rows) {
      await this.notifications.handleProjectDeadlineOverdue({
        projectId: row.project_id,
        sourceId: input.deadlineEventId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        deadlineInstanceId: input.deadlineInstanceId,
        orderId: input.orderId,
      });
    }
  }

  private async recordSkipped(
    input: {
      deadlineEventId: string;
      deadlineInstanceId: string;
      orderId: string | null;
      actorUserId: string | null;
      requestId: string;
    },
    skipReason: 'project_p8_notifications_disabled' | 'no_order_visibility_anchor' | 'no_project_link',
  ): Promise<void> {
    await this.database.query(
      `
      INSERT INTO public.outbox_events (
        event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
      )
      VALUES (
        'PROJECT_DEADLINE_OVERDUE_SKIPPED',
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
          source: 'projects-p8-notifications',
          eventType: 'PROJECT_DEADLINE_OVERDUE',
          deadlineEventId: input.deadlineEventId,
          deadlineInstanceId: input.deadlineInstanceId,
          orderId: input.orderId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          skipReason,
        }),
        `projects:p8:deadline-overdue-skipped:${input.deadlineEventId}:${skipReason}`,
      ],
    );
  }
}
