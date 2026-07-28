import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  NotificationChannel,
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
  group_id: string | null;
  is_enabled: boolean;
  priority: string | number;
  level: string;
  channels_json: unknown;
  conditions_json: Record<string, unknown> | null;
  recipients_json: Record<string, unknown> | null;
  title_template: string | null;
  message_template: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const RULE_COLUMNS = `
  notification_rule_id, rule_code, event_type, group_id, is_enabled, priority, level,
  channels_json, conditions_json, recipients_json, title_template, message_template,
  created_at, updated_at
`;

export class PgNotificationRuleRepository implements NotificationRuleRepositoryPort {
  async create(client: DatabaseClient, input: CreateNotificationRuleInput): Promise<NotificationRule> {
    const result = await client.query<NotificationRuleRow>(
      `
      INSERT INTO notification_rules (
        rule_code, event_type, group_id, level, priority, is_enabled,
        channels_json, conditions_json, recipients_json, title_template, message_template,
        created_by_user_id, updated_by_user_id
      )
      VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $12)
      RETURNING ${RULE_COLUMNS}
      `,
      [
        input.ruleCode,
        input.eventType,
        input.groupId ?? null,
        input.level,
        input.priority,
        input.isEnabled,
        JSON.stringify(input.channels),
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
      SET group_id = CASE WHEN $2 THEN $3::uuid ELSE group_id END,
          level = COALESCE($4, level),
          priority = COALESCE($5, priority),
          is_enabled = COALESCE($6, is_enabled),
          channels_json = COALESCE($7::jsonb, channels_json),
          conditions_json = COALESCE($8::jsonb, conditions_json),
          recipients_json = COALESCE($9::jsonb, recipients_json),
          title_template = CASE WHEN $10 THEN $11 ELSE title_template END,
          message_template = CASE WHEN $12 THEN $13 ELSE message_template END,
          updated_by_user_id = $14,
          updated_at = GREATEST(
            date_trunc('milliseconds', clock_timestamp()),
            date_trunc('milliseconds', updated_at) + interval '1 millisecond'
          )
      WHERE notification_rule_id = $1
        AND (
          $15::timestamptz IS NULL
          OR date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $15::timestamptz)
        )
      RETURNING ${RULE_COLUMNS}
      `,
      [
        ruleId,
        patch.groupId !== undefined,
        patch.groupId ?? null,
        patch.level ?? null,
        patch.priority ?? null,
        patch.isEnabled ?? null,
        patch.channels !== undefined ? JSON.stringify(patch.channels) : null,
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
    filter: { eventType?: string; isEnabled?: boolean; groupId?: string | 'global' },
  ): Promise<NotificationRule[]> {
    const result = await client.query<NotificationRuleRow>(
      `
      SELECT ${RULE_COLUMNS}
      FROM notification_rules
      WHERE ($1::text IS NULL OR event_type = $1::text)
        AND ($2::boolean IS NULL OR is_enabled = $2::boolean)
        AND CASE
          WHEN $3::text IS NULL THEN true
          WHEN $3::text = 'global' THEN group_id IS NULL
          ELSE group_id = $3::uuid
        END
      ORDER BY event_type ASC, priority ASC, created_at ASC
      `,
      [filter.eventType ?? null, filter.isEnabled ?? null, filter.groupId ?? null],
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
    groupId: row.group_id,
    isEnabled: row.is_enabled,
    priority: toNumber(row.priority),
    level: row.level as NotificationRule['level'],
    channels: normalizeChannels(row.channels_json),
    conditions: (row.conditions_json ?? {}) as NotificationRuleConditions,
    recipients: (row.recipients_json ?? {}) as NotificationRuleRecipients,
    titleTemplate: row.title_template,
    messageTemplate: row.message_template,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeChannels(value: unknown): NotificationChannel[] {
  if (!Array.isArray(value)) return ['in_app'];
  const channels = value.filter(
    (channel): channel is NotificationChannel => channel === 'in_app' || channel === 'telegram',
  );
  return channels.length > 0 ? Array.from(new Set(channels)) : ['in_app'];
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
