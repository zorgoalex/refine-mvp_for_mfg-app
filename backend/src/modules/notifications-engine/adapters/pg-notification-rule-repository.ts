import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  NotificationRule,
  NotificationRuleConditions,
  NotificationRuleRecipients,
} from '../domain/notification-rule.types';
import type {
  CreateNotificationRuleInput,
  NotificationRuleRepositoryPort,
  UpdateNotificationRuleInput,
} from '../ports/notification-rule-repository.port';

interface NotificationRuleRow {
  notification_rule_id: string;
  rule_code: string;
  event_type: string;
  is_enabled: boolean;
  priority: string | number;
  level: string;
  conditions_json: Record<string, unknown> | null;
  recipients_json: Record<string, unknown> | null;
  title_template: string | null;
  message_template: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const RULE_COLUMNS = `
  notification_rule_id, rule_code, event_type, is_enabled, priority, level,
  conditions_json, recipients_json, title_template, message_template,
  created_at, updated_at
`;

export class PgNotificationRuleRepository implements NotificationRuleRepositoryPort {
  async create(client: DatabaseClient, input: CreateNotificationRuleInput): Promise<NotificationRule> {
    const result = await client.query<NotificationRuleRow>(
      `
      INSERT INTO notification_rules (
        rule_code, event_type, level, priority, is_enabled,
        conditions_json, recipients_json, title_template, message_template,
        created_by_user_id, updated_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $10)
      RETURNING ${RULE_COLUMNS}
      `,
      [
        input.ruleCode,
        input.eventType,
        input.level,
        input.priority,
        input.isEnabled,
        JSON.stringify(input.conditions ?? {}),
        JSON.stringify(input.recipients ?? {}),
        input.titleTemplate,
        input.messageTemplate,
        input.createdByUserId,
      ],
    );

    return mapRow(result.rows[0]);
  }

  async update(
    client: DatabaseClient,
    ruleId: string,
    patch: UpdateNotificationRuleInput,
  ): Promise<NotificationRule> {
    const result = await client.query<NotificationRuleRow>(
      `
      UPDATE notification_rules
      SET level = COALESCE($2, level),
          priority = COALESCE($3, priority),
          is_enabled = COALESCE($4, is_enabled),
          conditions_json = COALESCE($5::jsonb, conditions_json),
          recipients_json = COALESCE($6::jsonb, recipients_json),
          title_template = CASE WHEN $7 THEN $8 ELSE title_template END,
          message_template = CASE WHEN $9 THEN $10 ELSE message_template END,
          updated_by_user_id = $11,
          updated_at = GREATEST(
            date_trunc('milliseconds', clock_timestamp()),
            date_trunc('milliseconds', updated_at) + interval '1 millisecond'
          )
      WHERE notification_rule_id = $1
        AND (
          $12::timestamptz IS NULL
          OR date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $12::timestamptz)
        )
      RETURNING ${RULE_COLUMNS}
      `,
      [
        ruleId,
        patch.level ?? null,
        patch.priority ?? null,
        patch.isEnabled ?? null,
        patch.conditions !== undefined ? JSON.stringify(patch.conditions) : null,
        patch.recipients !== undefined ? JSON.stringify(patch.recipients) : null,
        patch.titleTemplate !== undefined,
        patch.titleTemplate ?? null,
        patch.messageTemplate !== undefined,
        patch.messageTemplate ?? null,
        patch.updatedByUserId,
        patch.expectedUpdatedAt ?? null,
      ],
    );

    if (result.rowCount === 0) {
      throw new ApiError(409, 'NOTIFICATION_RULE_STALE', 'Notification rule was modified concurrently');
    }

    return mapRow(result.rows[0]);
  }

  async delete(client: DatabaseClient, ruleId: string): Promise<NotificationRule | null> {
    const result = await client.query<NotificationRuleRow>(
      `
      DELETE FROM notification_rules
      WHERE notification_rule_id = $1
      RETURNING ${RULE_COLUMNS}
      `,
      [ruleId],
    );
    const row = result.rows[0];

    return row ? mapRow(row) : null;
  }

  async getById(client: DatabaseClient, ruleId: string): Promise<NotificationRule | null> {
    const result = await client.query<NotificationRuleRow>(
      `SELECT ${RULE_COLUMNS} FROM notification_rules WHERE notification_rule_id = $1`,
      [ruleId],
    );
    const row = result.rows[0];

    return row ? mapRow(row) : null;
  }

  async list(
    client: DatabaseClient,
    filter: { eventType?: string; isEnabled?: boolean },
  ): Promise<NotificationRule[]> {
    const result = await client.query<NotificationRuleRow>(
      `
      SELECT ${RULE_COLUMNS}
      FROM notification_rules
      WHERE ($1::text IS NULL OR event_type = $1::text)
        AND ($2::boolean IS NULL OR is_enabled = $2::boolean)
      ORDER BY event_type ASC, priority ASC, created_at ASC
      `,
      [filter.eventType ?? null, filter.isEnabled ?? null],
    );

    return result.rows.map(mapRow);
  }

  async listEnabledByEvent(client: DatabaseClient, eventType: string): Promise<NotificationRule[]> {
    const result = await client.query<NotificationRuleRow>(
      `
      SELECT ${RULE_COLUMNS}
      FROM notification_rules
      WHERE event_type = $1
        AND is_enabled = true
      ORDER BY priority ASC, created_at ASC
      `,
      [eventType],
    );

    return result.rows.map(mapRow);
  }
}

function mapRow(row: NotificationRuleRow): NotificationRule {
  return {
    notificationRuleId: row.notification_rule_id,
    ruleCode: row.rule_code,
    eventType: row.event_type,
    isEnabled: row.is_enabled,
    priority: toNumber(row.priority),
    level: row.level as NotificationRule['level'],
    conditions: (row.conditions_json ?? {}) as NotificationRuleConditions,
    recipients: (row.recipients_json ?? {}) as NotificationRuleRecipients,
    titleTemplate: row.title_template,
    messageTemplate: row.message_template,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
