import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  DeadlineActionExecutionDto,
  DeadlineActionRuleConfigDto,
  DeadlineActionRuleDto,
  DeadlineOrderOverrideDto,
  DeadlineRuleConfigSnapshotDto,
} from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto, DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import type { DeadlinePolicyDto } from '../dto/deadline-policy.dto';
import { DEFAULT_DEADLINE_SETTINGS, type DeadlineSettingsDto } from '../dto/deadline-settings.dto';
import type { DeadlineActionType } from '../domain/deadline-actions';
import type { DeadlineEventSeverity, DeadlineEventType } from '../domain/deadline-events';
import type { DeadlineStatus } from '../domain/deadline-status';
import type { DeadlineEntityType } from '../domain/deadline-validation';
import { DeadlinePolicyNotFoundError } from '../errors/deadline.errors';
import type {
  CreateActionExecutionInput,
  CreateDeadlineCommand,
  CreateDeadlineEventInput,
  CreateDeadlineEventResult,
  CreateDeadlinePolicyCommand,
  CreateGlobalTransitionRuleCommand,
  DeadlineListQuery,
  DeadlineRepositoryPort,
  DeleteGlobalTransitionRuleCommand,
  FindDueDeadlinesCommand,
  ListDeadlinesCommand,
  OverrideDeadlineCommand,
  PauseDeadlineCommand,
  ResumeDeadlineCommand,
  UpdateDeadlinePolicyCommand,
  UpdateGlobalTransitionRuleCommand,
  UpdateDeadlineSettingsCommand,
  DeadlineEventCurrentForOrderQuery,
  RetireDeadlineOrderOverrideCommand,
  UpsertDeadlineOrderOverrideCommand,
} from '../application/deadline.types';

export interface DeadlineRow {
  deadline_id: string;
  policy_id: string | null;
  policy_version_id: string | null;
  entity_type: string;
  entity_id: string;
  parent_entity_type: string | null;
  parent_entity_id: string | null;
  order_id: string | number | null;
  order_workshop_id: string | number | null;
  client_id: string | number | null;
  responsible_user_id: string | number | null;
  deadline_at: string | Date;
  status: string;
  source: string;
  is_manually_overridden: boolean;
  policy_snapshot_json: Record<string, unknown> | null;
  metadata_json: Record<string, unknown> | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  expired_at: string | Date | null;
  cancelled_at: string | Date | null;
  idempotency_key: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DeadlineEventRow {
  deadline_event_id: string;
  deadline_id: string;
  event_type: string;
  severity: string;
  entity_type: string;
  entity_id: string;
  order_id: string | number | null;
  order_workshop_id: string | number | null;
  client_id: string | number | null;
  deadline_at: string | Date | null;
  event_at: string | Date;
  delay_minutes: string | number | null;
  payload_json: Record<string, unknown> | null;
  idempotency_key: string | null;
  was_inserted?: boolean;
  created_at: string | Date;
}

interface DeadlinePolicyRow {
  policy_id: string;
  policy_code: string;
  policy_name: string;
  scope_type: string;
  target_type: string | null;
  target_code: string | null;
  duration_value: string | number | null;
  duration_unit: string | null;
  start_point: string | null;
  is_enabled: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DeadlineActionRuleRow {
  action_rule_id: string;
  policy_id: string | null;
  scope_type: string;
  event_type: string;
  action_type: string;
  is_enabled: boolean;
  priority: string | number;
  config_json: Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DeadlineActionExecutionRow {
  action_execution_id: string;
  deadline_event_id: string;
  action_rule_id: string | null;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  status: 'executed' | 'skipped' | 'failed';
  idempotency_key: string;
  skip_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  result_json: Record<string, unknown> | null;
  rule_config_snapshot_json: Record<string, unknown>;
  rule_version_id: string | null;
  order_id: string | number | null;
  target_status_id: string | number | null;
  executed_at: string | Date | null;
  created_at: string | Date;
}

interface DeadlineOrderOverrideRow {
  override_id: string;
  order_id: string | number;
  policy_id: string | null;
  action_rule_id: string | null;
  is_disabled: boolean;
  override_config_json: Record<string, unknown>;
  reason: string;
  created_by_user_id: string | number;
  updated_by_user_id: string | number;
  retired_by_user_id: string | number | null;
  retired_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface OrderDeadlineEvaluationContextRow {
  order_id: string | number;
  order_status_id: string | number;
  completion_date: string | Date | null;
  issue_date: string | Date | null;
}

const DEADLINE_COLUMNS = `
  deadline_id, policy_id, policy_version_id, entity_type, entity_id,
  parent_entity_type, parent_entity_id, order_id, order_workshop_id, client_id,
  responsible_user_id, deadline_at, status, source, is_manually_overridden,
  policy_snapshot_json, metadata_json, started_at, completed_at, expired_at,
  cancelled_at, idempotency_key, created_at, updated_at
`;

const EVENT_COLUMNS = `
  deadline_event_id, deadline_id, event_type, severity, entity_type, entity_id,
  order_id, order_workshop_id, client_id, deadline_at, event_at, delay_minutes,
  payload_json, idempotency_key, created_at
`;

const POLICY_COLUMNS = `
  policy_id, policy_code, policy_name, scope_type, target_type, target_code,
  duration_value, duration_unit, start_point, is_enabled, created_at, updated_at
`;

const ACTION_RULE_COLUMNS = `
  action_rule_id, policy_id, scope_type, event_type, action_type, is_enabled,
  priority, config_json, created_at, updated_at
`;

const ACTION_EXECUTION_COLUMNS = `
  action_execution_id, deadline_event_id, action_rule_id, action_type, target_type,
  target_id, status, idempotency_key, skip_reason, error_code, error_message,
  result_json, rule_config_snapshot_json, rule_version_id, order_id, target_status_id,
  executed_at, created_at
`;

const ORDER_OVERRIDE_COLUMNS = `
  override_id, order_id, policy_id, action_rule_id, is_disabled,
  override_config_json, reason, created_by_user_id, updated_by_user_id,
  retired_by_user_id, retired_at, created_at, updated_at
`;

const SETTING_ACTIONS = {
  notifyAssigneeEnabled: 'notify_assignee',
  notifyManagerEnabled: 'notify_manager',
  notifyDepartmentHeadEnabled: 'notify_department_head',
  setOverdueFlagEnabled: 'set_overdue_flag',
  changeOrderStatusEnabled: 'change_order_status',
  changeProductionStatusEnabled: 'change_production_status',
  escalationEnabled: 'escalate',
} as const satisfies Partial<Record<keyof DeadlineSettingsDto, DeadlineActionType>>;

const SETTING_SCOPES: DeadlineEntityType[] = ['order', 'order_stage', 'client_action'];

export class PgDeadlineRepository implements DeadlineRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listDeadlines(command: ListDeadlinesCommand): Promise<{
    data: DeadlineInstanceDto[];
    total: number;
  }> {
    const filter = buildDeadlineFilter(command.query);
    const count = await this.database.query<{ total: string | number }>(
      `SELECT COUNT(*)::int AS total FROM deadline_instances d ${filter.whereSql}`,
      filter.params,
    );
    const sortColumn = deadlineSortColumn(command.query.sortBy);
    const offset = (command.query.page - 1) * command.query.pageSize;
    const result = await this.database.query<DeadlineRow>(
      `
      SELECT ${DEADLINE_COLUMNS}
      FROM deadline_instances d
      ${filter.whereSql}
      ORDER BY ${sortColumn} ${command.query.sortOrder.toUpperCase()}, d.deadline_id ASC
      LIMIT $${filter.params.length + 1}
      OFFSET $${filter.params.length + 2}
      `,
      [...filter.params, command.query.pageSize, offset],
    );

    return {
      data: result.rows.map(mapDeadline),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async getDeadlineById(deadlineId: string): Promise<DeadlineInstanceDto | null> {
    const result = await this.database.query<DeadlineRow>(
      `SELECT ${DEADLINE_COLUMNS} FROM deadline_instances WHERE deadline_id = $1`,
      [deadlineId],
    );
    const row = result.rows[0];

    return row ? mapDeadline(row) : null;
  }

  async getDeadlineByIdForUpdate(deadlineId: string): Promise<DeadlineInstanceDto | null> {
    const result = await this.database.query<DeadlineRow>(
      `SELECT ${DEADLINE_COLUMNS} FROM deadline_instances WHERE deadline_id = $1 FOR UPDATE`,
      [deadlineId],
    );
    const row = result.rows[0];

    return row ? mapDeadline(row) : null;
  }

  async listOrderDeadlines(orderId: number): Promise<DeadlineInstanceDto[]> {
    const result = await this.database.query<DeadlineRow>(
      `
      SELECT ${DEADLINE_COLUMNS}
      FROM deadline_instances
      WHERE order_id = $1
      ORDER BY deadline_at ASC, created_at ASC
      `,
      [orderId],
    );

    return result.rows.map(mapDeadline);
  }

  async listOrderDeadlineEvents(orderId: number): Promise<DeadlineEventDto[]> {
    const result = await this.database.query<DeadlineEventRow>(
      `
      SELECT ${EVENT_COLUMNS}
      FROM deadline_events
      WHERE order_id = $1
      ORDER BY event_at DESC, created_at DESC
      `,
      [orderId],
    );

    return result.rows.map(mapEvent);
  }

  async listPolicies(): Promise<DeadlinePolicyDto[]> {
    const result = await this.database.query<DeadlinePolicyRow>(
      `
      SELECT ${POLICY_COLUMNS}
      FROM deadline_policies
      ORDER BY policy_code ASC
      `,
    );

    return result.rows.map(mapPolicy);
  }

  async createPolicy(command: CreateDeadlinePolicyCommand): Promise<DeadlinePolicyDto> {
    const result = await this.database.query<DeadlinePolicyRow>(
      `
      INSERT INTO deadline_policies (
        policy_code, policy_name, scope_type, target_type, target_code,
        duration_value, duration_unit, start_point, is_enabled
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING ${POLICY_COLUMNS}
      `,
      [
        command.dto.policyCode,
        command.dto.policyName,
        command.dto.scopeType,
        command.dto.targetType ?? null,
        command.dto.targetCode ?? null,
        command.dto.durationValue ?? null,
        command.dto.durationUnit ?? null,
        command.dto.startPoint ?? null,
        command.dto.isEnabled ?? true,
      ],
    );
    const policy = mapPolicy(result.rows[0]);
    await this.createPolicyVersion(policy.policyId, 1, command.dto.config ?? {}, command.currentUser.id);
    await this.writeConfigAudit({
      event: 'deadlines.policy.created',
      entityType: 'deadline_policy',
      entityId: policy.policyId,
      userId: command.currentUser.id,
      requestId: command.requestId,
      before: {},
      after: policyAuditSnapshot(policy),
      diff: diffRecords({}, policyAuditSnapshot(policy)),
      metadata: {
        policyId: policy.policyId,
        policyCode: policy.policyCode,
        scopeType: policy.scopeType,
        versionNumber: 1,
      },
    });

    return policy;
  }

  async updatePolicy(command: UpdateDeadlinePolicyCommand): Promise<DeadlinePolicyDto> {
    const current = await this.database.query<DeadlinePolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM deadline_policies WHERE policy_id = $1`,
      [command.policyId],
    );

    if (!current.rows[0]) {
      throw new DeadlinePolicyNotFoundError(command.policyId);
    }

    const row = current.rows[0];
    const beforePolicy = mapPolicy(row);
    const result = await this.database.query<DeadlinePolicyRow>(
      `
      UPDATE deadline_policies
      SET policy_name = $2,
          target_type = $3,
          target_code = $4,
          duration_value = $5,
          duration_unit = $6,
          start_point = $7,
          is_enabled = $8,
          updated_at = now()
      WHERE policy_id = $1
      RETURNING ${POLICY_COLUMNS}
      `,
      [
        command.policyId,
        hasOwn(command.dto, 'policyName') ? command.dto.policyName : row.policy_name,
        hasOwn(command.dto, 'targetType') ? command.dto.targetType : row.target_type,
        hasOwn(command.dto, 'targetCode') ? command.dto.targetCode : row.target_code,
        hasOwn(command.dto, 'durationValue') ? command.dto.durationValue : row.duration_value,
        hasOwn(command.dto, 'durationUnit') ? command.dto.durationUnit : row.duration_unit,
        hasOwn(command.dto, 'startPoint') ? command.dto.startPoint : row.start_point,
        hasOwn(command.dto, 'isEnabled') ? command.dto.isEnabled : row.is_enabled,
      ],
    );
    const policy = mapPolicy(result.rows[0]);
    const version = await this.database.query<{ next_version: number }>(
      `
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM deadline_policy_versions
      WHERE policy_id = $1
      `,
      [command.policyId],
    );
    await this.createPolicyVersion(
      command.policyId,
      Number(version.rows[0]?.next_version ?? 1),
      command.dto.config ?? {},
      command.currentUser.id,
    );
    const versionNumber = Number(version.rows[0]?.next_version ?? 1);
    await this.writeConfigAudit({
      event: 'deadlines.policy.updated',
      entityType: 'deadline_policy',
      entityId: policy.policyId,
      userId: command.currentUser.id,
      requestId: command.requestId,
      before: policyAuditSnapshot(beforePolicy),
      after: policyAuditSnapshot(policy),
      diff: diffRecords(policyAuditSnapshot(beforePolicy), policyAuditSnapshot(policy)),
      metadata: {
        policyId: policy.policyId,
        policyCode: policy.policyCode,
        scopeType: policy.scopeType,
        versionNumber,
      },
    });

    return policy;
  }

  async getSettings(): Promise<DeadlineSettingsDto> {
    const result = await this.database.query<{ action_type: string; is_enabled: boolean }>(
      `
      SELECT action_type, bool_or(is_enabled) AS is_enabled
      FROM deadline_action_rules
      WHERE event_type = 'DEADLINE_EXPIRED'
        AND action_type = ANY($1::text[])
      GROUP BY action_type
      `,
      [Object.values(SETTING_ACTIONS)],
    );
    const settings = { ...DEFAULT_DEADLINE_SETTINGS };
    const byAction = new Map(result.rows.map((row) => [row.action_type, row.is_enabled]));

    for (const [settingKey, actionType] of Object.entries(SETTING_ACTIONS)) {
      (settings as Record<string, boolean>)[settingKey] = byAction.get(actionType) ?? false;
    }

    return settings;
  }

  async updateSettings(command: UpdateDeadlineSettingsCommand): Promise<DeadlineSettingsDto> {
    const beforeSettings = await this.getSettings();
    for (const [settingKey, actionType] of Object.entries(SETTING_ACTIONS)) {
      const enabled = command.dto[settingKey as keyof DeadlineSettingsDto];
      if (enabled === undefined) {
        continue;
      }

      for (const scope of SETTING_SCOPES) {
        await this.upsertSettingActionRule(scope, actionType, enabled);
      }
    }

    const afterSettings = await this.getSettings();
    const auditedKeys = Object.keys(command.dto).filter((key) =>
      Object.prototype.hasOwnProperty.call(SETTING_ACTIONS, key),
    ) as Array<keyof DeadlineSettingsDto>;
    const beforeAudit = pickRecord(beforeSettings, auditedKeys);
    const afterAudit = pickRecord(afterSettings, auditedKeys);
    const diff = diffRecords(beforeAudit, afterAudit);

    if (Object.keys(diff).length > 0) {
      await this.writeConfigAudit({
        event: 'deadlines.settings.updated',
        entityType: 'deadline_settings',
        entityId: 'global',
        userId: command.currentUser.id,
        requestId: command.requestId,
        before: beforeAudit,
        after: afterAudit,
        diff,
        metadata: {
          settingsKeys: Object.keys(diff),
        },
      });
    }

    return afterSettings;
  }

  async createDeadlineInstance(command: CreateDeadlineCommand): Promise<DeadlineInstanceDto> {
    const requestId = command.requestId ?? 'deadline-command';
    const idempotencyKey =
      command.requestId ? `deadline-create:${command.requestId}` : null;
    const result = await this.database.query<DeadlineRow>(
      `
      INSERT INTO deadline_instances (
        entity_type, entity_id, order_id, order_workshop_id, client_id,
        responsible_user_id, deadline_at, source, metadata_json,
        created_by_user_id, updated_by_user_id, idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb, $10, $10, $11)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
      SET idempotency_key = deadline_instances.idempotency_key
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [
        command.dto.entityType,
        command.dto.entityId,
        command.dto.orderId ?? null,
        command.dto.orderWorkshopId ?? null,
        command.dto.clientId ?? null,
        command.dto.responsibleUserId ?? null,
        command.dto.deadlineAt,
        command.dto.source ?? 'manual',
        JSON.stringify(command.dto.metadata ?? {}),
        Number(command.currentUser.id),
        idempotencyKey,
      ],
    );
    const deadline = mapDeadline(result.rows[0]);
    await this.createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType: 'DEADLINE_CREATED',
      severity: 'info',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: {
        source: 'backend-deadline-command',
        requestId,
        actorUserId: command.currentUser.id,
        afterStatus: deadline.status,
      },
      idempotencyKey: `deadline-command:${deadline.deadlineId}:DEADLINE_CREATED:${requestId}`,
    });

    return deadline;
  }

  async overrideDeadline(command: OverrideDeadlineCommand): Promise<DeadlineInstanceDto> {
    const requestId = command.requestId ?? 'deadline-command';
    const current = await this.requireDeadline(command.deadlineId);
    const idempotencyKey =
      command.requestId ? `deadline-override:${command.deadlineId}:${command.requestId}` : null;
    const superseded = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = 'superseded',
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1 AND status NOT IN ('expired', 'completed_on_time', 'completed_late', 'cancelled', 'superseded')
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [command.deadlineId, Number(command.currentUser.id)],
    );
    if (!superseded.rows[0]) {
      const existing = idempotencyKey
        ? await this.findDeadlineByIdempotencyKey(idempotencyKey)
        : null;
      if (existing) {
        return existing;
      }

      throw new ApiError(409, 'DEADLINE_INVALID_STATUS_TRANSITION', 'Deadline status transition is not allowed', {
        deadlineId: command.deadlineId,
        fromStatus: current.status,
        toStatus: 'superseded',
      });
    }

    const result = await this.database.query<DeadlineRow>(
      `
      INSERT INTO deadline_instances (
        policy_id, policy_version_id, entity_type, entity_id, parent_entity_type,
        parent_entity_id, order_id, order_workshop_id, client_id, responsible_user_id,
        deadline_at, status, source, is_manually_overridden, policy_snapshot_json,
        metadata_json, started_at, created_by_user_id, updated_by_user_id, idempotency_key
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11::timestamptz, 'active', 'manual', true, $12::jsonb,
        $13::jsonb, $14, $15, $15, $16
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
      SET idempotency_key = deadline_instances.idempotency_key
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [
        current.policyId,
        current.policyVersionId,
        current.entityType,
        current.entityId,
        current.parentEntityType ?? null,
        current.parentEntityId ?? null,
        current.orderId ?? null,
        current.orderWorkshopId ?? null,
        current.clientId ?? null,
        current.responsibleUserId ?? null,
        command.dto.deadlineAt,
        JSON.stringify(current.policySnapshot ?? {}),
        JSON.stringify({
          ...(current.metadata ?? {}),
          ...(command.dto.metadata ?? {}),
          overrideReason: command.dto.reason,
          overriddenDeadlineId: current.deadlineId,
        }),
        current.startedAt ?? null,
        Number(command.currentUser.id),
        idempotencyKey,
      ],
    );
    const deadline = mapDeadline(result.rows[0]);
    await this.createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType: 'DEADLINE_UPDATED',
      severity: 'warning',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: {
        previousDeadlineId: current.deadlineId,
        previousDeadlineAt: current.deadlineAt,
        reason: command.dto.reason,
        actorUserId: command.currentUser.id,
        requestId,
        source: 'backend-deadline-command',
        beforeStatus: current.status,
        afterStatus: deadline.status,
        beforeDeadlineAt: current.deadlineAt,
        afterDeadlineAt: deadline.deadlineAt,
      },
      idempotencyKey: `deadline-command:${deadline.deadlineId}:DEADLINE_UPDATED:${requestId}`,
    });

    return deadline;
  }

  async pauseDeadline(command: PauseDeadlineCommand): Promise<DeadlineInstanceDto> {
    const current = await this.requireDeadline(command.deadlineId);
    const result = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = 'paused',
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1 AND status = 'active'
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [command.deadlineId, Number(command.currentUser.id)],
    );
    if (!result.rows[0]) {
      throw new ApiError(409, 'DEADLINE_INVALID_STATUS_TRANSITION', 'Deadline status transition is not allowed', {
        deadlineId: command.deadlineId,
        fromStatus: current.status,
        toStatus: 'paused',
      });
    }

    const deadline = mapDeadline(result.rows[0]);
    await this.database.query(
      `
      INSERT INTO deadline_pauses (
        deadline_id, pause_reason, pause_mode, paused_by_user_id, notes
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        command.deadlineId,
        command.dto.pauseReason,
        command.dto.pauseMode,
        Number(command.currentUser.id),
        command.dto.notes ?? null,
      ],
    );
    await this.createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType: 'DEADLINE_PAUSED',
      severity: 'info',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: {
        pauseMode: command.dto.pauseMode,
        pauseReason: command.dto.pauseReason,
        notes: command.dto.notes ?? null,
        actorUserId: command.currentUser.id,
        requestId: command.requestId ?? 'deadline-command',
        source: 'backend-deadline-command',
        reason: command.dto.pauseReason,
        beforeStatus: current.status,
        afterStatus: deadline.status,
      },
    });

    return deadline;
  }

  async resumeDeadline(command: ResumeDeadlineCommand): Promise<DeadlineInstanceDto> {
    const current = await this.requireDeadline(command.deadlineId);
    const result = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = 'active',
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1 AND status = 'paused'
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [command.deadlineId, Number(command.currentUser.id)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(409, 'DEADLINE_INVALID_STATUS_TRANSITION', 'Deadline status transition is not allowed', {
        deadlineId: command.deadlineId,
        fromStatus: current.status,
        toStatus: 'active',
      });
    }

    const deadline = mapDeadline(row);
    await this.database.query(
      `
      UPDATE deadline_pauses
      SET resumed_at = now(),
          resumed_by_user_id = $2,
          notes = COALESCE($3, notes)
      WHERE deadline_id = $1 AND resumed_at IS NULL
      `,
      [command.deadlineId, Number(command.currentUser.id), command.dto.notes ?? null],
    );
    await this.createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType: 'DEADLINE_RESUMED',
      severity: 'info',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: {
        notes: command.dto.notes ?? null,
        actorUserId: command.currentUser.id,
        requestId: command.requestId ?? 'deadline-command',
        source: 'backend-deadline-command',
        beforeStatus: current.status,
        afterStatus: deadline.status,
      },
    });

    return deadline;
  }

  async cancelDeadline(command: import('../application/deadline.types').CancelDeadlineCommand): Promise<DeadlineInstanceDto> {
    const current = await this.requireDeadline(command.deadlineId);
    const result = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = 'cancelled',
          cancelled_at = now(),
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1 AND status NOT IN ('expired', 'completed_on_time', 'completed_late', 'cancelled', 'superseded')
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [command.deadlineId, Number(command.currentUser.id)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(409, 'DEADLINE_INVALID_STATUS_TRANSITION', 'Deadline status transition is not allowed', {
        deadlineId: command.deadlineId,
        fromStatus: current.status,
        toStatus: 'cancelled',
      });
    }

    const deadline = mapDeadline(row);
    await this.createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType: 'DEADLINE_CANCELLED',
      severity: 'info',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: {
        reason: command.dto.reason,
        actorUserId: command.currentUser.id,
        requestId: command.requestId ?? 'deadline-command',
        source: 'backend-deadline-command',
        beforeStatus: current.status,
        afterStatus: deadline.status,
      },
    });

    return deadline;
  }

  async findDueDeadlinesForUpdate(command: FindDueDeadlinesCommand): Promise<DeadlineInstanceDto[]> {
    const result = await this.database.query<DeadlineRow>(
      `
      SELECT ${DEADLINE_COLUMNS}
      FROM deadline_instances
      WHERE status = 'active'
        AND deadline_at <= $1::timestamptz
      ORDER BY deadline_at ASC, created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
      `,
      [command.now, command.limit],
    );

    return result.rows.map(mapDeadline);
  }

  async markDeadlineExpired(input: { deadlineId: string; expiredAt: string }): Promise<DeadlineInstanceDto> {
    const result = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = 'expired',
          expired_at = $2::timestamptz,
          updated_at = now()
      WHERE deadline_id = $1 AND status = 'active'
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [input.deadlineId, input.expiredAt],
    );
    const row = result.rows[0];

    return row ? mapDeadline(row) : this.requireDeadline(input.deadlineId);
  }

  async markDeadlineCompleted(input: {
    deadlineId: string;
    status: Extract<DeadlineStatus, 'completed_on_time' | 'completed_late'>;
    completedAt: string;
  }): Promise<DeadlineInstanceDto> {
    const result = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = $2,
          completed_at = $3::timestamptz,
          updated_at = now()
      WHERE deadline_id = $1 AND status = 'active'
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [input.deadlineId, input.status, input.completedAt],
    );
    const row = result.rows[0];

    return row ? mapDeadline(row) : this.requireDeadline(input.deadlineId);
  }

  async createDeadlineEvent(input: CreateDeadlineEventInput): Promise<CreateDeadlineEventResult> {
    const result = await this.database.query<DeadlineEventRow>(
      `
      INSERT INTO deadline_events (
        deadline_id, event_type, severity, entity_type, entity_id, order_id,
        order_workshop_id, client_id, deadline_at, event_at, delay_minutes, payload_json,
        idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12::jsonb, $13)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
      SET idempotency_key = deadline_events.idempotency_key
      RETURNING ${EVENT_COLUMNS}, (xmax = 0) AS was_inserted
      `,
      [
        input.deadlineId,
        input.eventType,
        input.severity,
        input.entityType,
        input.entityId,
        input.orderId ?? null,
        input.orderWorkshopId ?? null,
        input.clientId ?? null,
        input.deadlineAt ?? null,
        input.eventAt,
        input.delayMinutes ?? null,
        JSON.stringify(input.payload ?? {}),
        input.idempotencyKey ?? null,
      ],
    );
    const row = result.rows[0];
    const event = mapEvent(row);

    const created = row.was_inserted !== false;

    if (created) {
      await this.writeAuditEvent(event);
      await this.enqueueOutboxEvent(event);
    }

    return { event, created };
  }

  async listActionRules(input: {
    scopeType: DeadlineEntityType;
    eventType: DeadlineEventType;
  }): Promise<DeadlineActionRuleDto[]> {
    const result = await this.database.query<DeadlineActionRuleRow>(
      `
      SELECT ${ACTION_RULE_COLUMNS}
      FROM deadline_action_rules
      WHERE scope_type = $1
        AND event_type = $2
      ORDER BY priority ASC, created_at ASC, action_rule_id ASC
      `,
      [input.scopeType, input.eventType],
    );

    return result.rows.map(mapActionRule);
  }

  async createActionExecution(input: CreateActionExecutionInput): Promise<DeadlineActionExecutionDto> {
    const result = await this.database.query<DeadlineActionExecutionRow>(
      `
      INSERT INTO deadline_action_executions (
        deadline_event_id, action_rule_id, action_type, target_type, target_id,
        status, idempotency_key, skip_reason, error_code, error_message,
        result_json, rule_config_snapshot_json, rule_version_id, order_id,
        target_status_id, executed_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11::jsonb, $12::jsonb, $13, $14, $15, $16::timestamptz
      )
      ON CONFLICT (idempotency_key) DO UPDATE
      SET status = deadline_action_executions.status
      RETURNING ${ACTION_EXECUTION_COLUMNS}
      `,
      [
        input.deadlineEventId,
        input.actionRuleId ?? null,
        input.actionType,
        input.targetType ?? null,
        input.targetId ?? null,
        input.status,
        input.idempotencyKey,
        input.skipReason ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        JSON.stringify(input.result ?? {}),
        JSON.stringify(input.ruleConfigSnapshot ?? {}),
        input.ruleVersionId ?? null,
        input.orderId ?? null,
        input.targetStatusId ?? null,
        input.executedAt ?? null,
      ],
    );

    return mapActionExecution(result.rows[0]);
  }

  async listOrderOverrides(orderId: number): Promise<DeadlineOrderOverrideDto[]> {
    const result = await this.database.query<DeadlineOrderOverrideRow>(
      `
      SELECT ${ORDER_OVERRIDE_COLUMNS}
      FROM deadline_order_overrides
      WHERE order_id = $1
        AND retired_at IS NULL
      ORDER BY updated_at DESC, override_id ASC
      `,
      [orderId],
    );

    return result.rows.map(mapOrderOverride);
  }

  async listOrderActionRuleOverrides(
    orderId: number,
    actionRuleIds: string[],
  ): Promise<DeadlineOrderOverrideDto[]> {
    if (actionRuleIds.length === 0) {
      return [];
    }

    const result = await this.database.query<DeadlineOrderOverrideRow>(
      `
      SELECT ${ORDER_OVERRIDE_COLUMNS}
      FROM deadline_order_overrides
      WHERE order_id = $1
        AND retired_at IS NULL
        AND policy_id IS NULL
        AND action_rule_id = ANY($2::uuid[])
      ORDER BY updated_at DESC, override_id ASC
      `,
      [orderId, actionRuleIds],
    );

    return result.rows.map(mapOrderOverride);
  }

  async upsertOrderOverride(
    command: UpsertDeadlineOrderOverrideCommand,
  ): Promise<DeadlineOrderOverrideDto> {
    const isPolicy = command.dto.targetType === 'policy';
    const beforeOverride = await this.findActiveOrderOverride({
      orderId: command.dto.orderId,
      policyId: isPolicy ? command.dto.policyId : null,
      actionRuleId: isPolicy ? null : command.dto.actionRuleId,
    });
    const result = await this.database.query<DeadlineOrderOverrideRow>(
      isPolicy
        ? `
        INSERT INTO deadline_order_overrides (
          order_id, policy_id, action_rule_id, is_disabled, override_config_json,
          reason, created_by_user_id, updated_by_user_id
        )
        VALUES ($1, $2, NULL, $3, $4::jsonb, $5, $6, $6)
        ON CONFLICT (order_id, policy_id) WHERE retired_at IS NULL AND policy_id IS NOT NULL DO UPDATE
        SET is_disabled = EXCLUDED.is_disabled,
            override_config_json = EXCLUDED.override_config_json,
            reason = EXCLUDED.reason,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = now()
        RETURNING ${ORDER_OVERRIDE_COLUMNS}
        `
        : `
        INSERT INTO deadline_order_overrides (
          order_id, policy_id, action_rule_id, is_disabled, override_config_json,
          reason, created_by_user_id, updated_by_user_id
        )
        VALUES ($1, NULL, $2, $3, $4::jsonb, $5, $6, $6)
        ON CONFLICT (order_id, action_rule_id) WHERE retired_at IS NULL AND action_rule_id IS NOT NULL DO UPDATE
        SET is_disabled = EXCLUDED.is_disabled,
            override_config_json = EXCLUDED.override_config_json,
            reason = EXCLUDED.reason,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = now()
        RETURNING ${ORDER_OVERRIDE_COLUMNS}
        `,
      [
        command.dto.orderId,
        isPolicy ? command.dto.policyId : command.dto.actionRuleId,
        command.dto.isDisabled ?? false,
        JSON.stringify(command.dto.overrideConfig ?? {}),
        command.dto.reason,
        Number(command.currentUser.id),
      ],
    );
    const override = mapOrderOverride(result.rows[0]);
    const beforeAudit = beforeOverride ? orderOverrideAuditSnapshot(beforeOverride) : {};
    const afterAudit = orderOverrideAuditSnapshot(override);
    await this.writeConfigAudit({
      event: beforeOverride ? 'deadline.order_override_updated' : 'deadline.order_override_created',
      entityType: 'deadline_order_override',
      entityId: override.overrideId,
      userId: String(command.currentUser.id),
      requestId: command.requestId,
      source: command.audit.source,
      relatedOrderId: override.orderId,
      before: beforeAudit,
      after: afterAudit,
      diff: diffRecords(beforeAudit, afterAudit),
      metadata: {
        orderId: override.orderId,
        policyId: override.policyId ?? null,
        actionRuleId: override.actionRuleId ?? null,
        reason: command.dto.reason,
        comment: command.audit.comment ?? null,
      },
    });

    return override;
  }

  async retireOrderOverride(
    command: RetireDeadlineOrderOverrideCommand,
  ): Promise<DeadlineOrderOverrideDto> {
    const beforeOverride = await this.findActiveOrderOverrideById(command.overrideId, command.orderId);
    if (!beforeOverride) {
      throw new ApiError(404, 'DEADLINE_ORDER_OVERRIDE_NOT_FOUND', 'Deadline order override not found', {
        overrideId: command.overrideId,
        orderId: command.orderId,
      });
    }

    const result = await this.database.query<DeadlineOrderOverrideRow>(
      `
      UPDATE deadline_order_overrides
      SET retired_at = now(),
          retired_by_user_id = $3,
          updated_by_user_id = $3,
          updated_at = now()
      WHERE override_id = $1 AND order_id = $2
        AND retired_at IS NULL
      RETURNING ${ORDER_OVERRIDE_COLUMNS}
      `,
      [command.overrideId, command.orderId, Number(command.currentUser.id)],
    );
    if (!result.rows[0]) {
      throw new ApiError(404, 'DEADLINE_ORDER_OVERRIDE_NOT_FOUND', 'Deadline order override not found', {
        overrideId: command.overrideId,
      });
    }

    const override = mapOrderOverride(result.rows[0]);
    const beforeAudit = orderOverrideAuditSnapshot(beforeOverride);
    const afterAudit = orderOverrideAuditSnapshot(override);
    await this.writeConfigAudit({
      event: command.audit.event,
      entityType: 'deadline_order_override',
      entityId: override.overrideId,
      userId: String(command.currentUser.id),
      requestId: command.requestId,
      source: command.audit.source,
      relatedOrderId: override.orderId,
      before: beforeAudit,
      after: afterAudit,
      diff: diffRecords(beforeAudit, afterAudit),
      metadata: {
        orderId: override.orderId,
        policyId: override.policyId ?? null,
        actionRuleId: override.actionRuleId ?? null,
        reason: command.reason,
        comment: command.audit.comment ?? null,
      },
    });

    return override;
  }

  async listGlobalTransitionRules(): Promise<DeadlineActionRuleDto[]> {
    const result = await this.database.query<DeadlineActionRuleRow>(
      `
      SELECT ${ACTION_RULE_COLUMNS}
      FROM deadline_action_rules
      WHERE scope_type = 'order'
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = 'change_order_status'
        AND config_json->'scope'->>'type' = 'global_orders'
      ORDER BY priority ASC, created_at ASC, action_rule_id ASC
      `,
    );

    return result.rows.map(mapActionRule);
  }

  async createGlobalTransitionRule(
    command: CreateGlobalTransitionRuleCommand,
  ): Promise<DeadlineActionRuleDto> {
    await this.assertActiveOrderStatusesExist([
      command.dto.targetOrderStatusId,
      ...command.dto.allowedFromOrderStatusIds,
      ...(command.dto.excludeOrderStatusIds ?? []),
    ]);

    const result = await this.database.query<DeadlineActionRuleRow>(
      `
      INSERT INTO deadline_action_rules (
        scope_type, event_type, action_type, is_enabled, priority, config_json
      )
      VALUES ('order', 'DEADLINE_EXPIRED', 'change_order_status', $1, $2, $3::jsonb)
      RETURNING ${ACTION_RULE_COLUMNS}
      `,
      [
        false,
        command.dto.priority ?? 100,
        JSON.stringify(buildCreateTransitionRuleConfig(command.dto)),
      ],
    );
    const rule = mapActionRule(result.rows[0]);
    const afterAudit = actionRuleAuditSnapshot(rule);
    await this.writeConfigAudit({
      event: command.audit.event,
      entityType: 'deadline_transition_rule',
      entityId: rule.actionRuleId,
      userId: String(command.currentUser.id),
      requestId: command.requestId,
      source: command.audit.source,
      relatedOrderId: null,
      relatedClientId: null,
      before: {},
      after: afterAudit,
      diff: diffRecords({}, afterAudit),
      metadata: buildTransitionRuleAuditMetadata(rule, command.dto.reason, command.dto.comment ?? null),
    });

    return rule;
  }

  async updateGlobalTransitionRule(
    command: UpdateGlobalTransitionRuleCommand,
  ): Promise<DeadlineActionRuleDto> {
    const current = await this.database.query<DeadlineActionRuleRow>(
      `
      SELECT ${ACTION_RULE_COLUMNS}
      FROM deadline_action_rules
      WHERE action_rule_id = $1
        AND scope_type = 'order'
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = 'change_order_status'
        AND config_json->'scope'->>'type' = 'global_orders'
      FOR UPDATE
      `,
      [command.actionRuleId],
    );
    if (!current.rows[0]) {
      throw new ApiError(404, 'DEADLINE_ACTION_RULE_NOT_FOUND', 'Deadline action rule not found', {
        actionRuleId: command.actionRuleId,
      });
    }

    const before = mapActionRule(current.rows[0]);
    if (!sameMillisecond(before.updatedAt, command.dto.expectedUpdatedAt)) {
      throw new ApiError(409, 'DEADLINE_TRANSITION_RULE_STALE', 'Deadline transition rule was modified concurrently', {
        actionRuleId: command.actionRuleId,
      });
    }

    await this.assertActiveOrderStatusesExist([
      ...(command.dto.targetOrderStatusId !== undefined ? [command.dto.targetOrderStatusId] : []),
      ...(command.dto.allowedFromOrderStatusIds ?? []),
      ...(command.dto.excludeOrderStatusIds ?? []),
    ]);
    const config = buildTransitionRuleConfig(before.config, command.dto);
    const result = await this.database.query<DeadlineActionRuleRow>(
      `
      UPDATE deadline_action_rules
      SET is_enabled = $2,
          priority = $3,
          config_json = $4::jsonb,
          updated_at = GREATEST(
            date_trunc('milliseconds', clock_timestamp()),
            date_trunc('milliseconds', updated_at) + interval '1 millisecond'
          )
      WHERE action_rule_id = $1
        AND scope_type = 'order'
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = 'change_order_status'
        AND config_json->'scope'->>'type' = 'global_orders'
        AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $5::timestamptz)
      RETURNING ${ACTION_RULE_COLUMNS}
      `,
      [
        command.actionRuleId,
        false,
        command.dto.priority ?? before.priority,
        JSON.stringify(config),
        command.dto.expectedUpdatedAt,
      ],
    );
    if (!result.rows[0]) {
      throw new ApiError(409, 'DEADLINE_TRANSITION_RULE_STALE', 'Deadline transition rule was modified concurrently', {
        actionRuleId: command.actionRuleId,
      });
    }

    const rule = mapActionRule(result.rows[0]);
    const beforeAudit = actionRuleAuditSnapshot(before);
    const afterAudit = actionRuleAuditSnapshot(rule);
    await this.writeConfigAudit({
      event: command.audit.event,
      entityType: 'deadline_transition_rule',
      entityId: rule.actionRuleId,
      userId: String(command.currentUser.id),
      requestId: command.requestId,
      source: command.audit.source,
      relatedOrderId: null,
      relatedClientId: null,
      before: beforeAudit,
      after: afterAudit,
      diff: diffRecords(beforeAudit, afterAudit),
      metadata: buildTransitionRuleAuditMetadata(rule, command.dto.reason, command.dto.comment ?? null),
    });

    return rule;
  }

  async deleteGlobalTransitionRule(
    command: DeleteGlobalTransitionRuleCommand,
  ): Promise<DeadlineActionRuleDto> {
    const current = await this.database.query<DeadlineActionRuleRow>(
      `
      SELECT ${ACTION_RULE_COLUMNS}
      FROM deadline_action_rules
      WHERE action_rule_id = $1
        AND scope_type = 'order'
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = 'change_order_status'
        AND config_json->'scope'->>'type' = 'global_orders'
      FOR UPDATE
      `,
      [command.actionRuleId],
    );
    if (!current.rows[0]) {
      throw new ApiError(404, 'DEADLINE_ACTION_RULE_NOT_FOUND', 'Deadline action rule not found', {
        actionRuleId: command.actionRuleId,
      });
    }

    const before = mapActionRule(current.rows[0]);
    if (!sameMillisecond(before.updatedAt, command.dto.expectedUpdatedAt)) {
      throw new ApiError(409, 'DEADLINE_TRANSITION_RULE_STALE', 'Deadline transition rule was modified concurrently', {
        actionRuleId: command.actionRuleId,
      });
    }

    await this.assertTransitionRuleNotReferenced(command.actionRuleId);

    let result;
    try {
      result = await this.database.query<DeadlineActionRuleRow>(
        `
        DELETE FROM deadline_action_rules
        WHERE action_rule_id = $1
          AND scope_type = 'order'
          AND event_type = 'DEADLINE_EXPIRED'
          AND action_type = 'change_order_status'
          AND config_json->'scope'->>'type' = 'global_orders'
          AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $2::timestamptz)
        RETURNING ${ACTION_RULE_COLUMNS}
        `,
        [command.actionRuleId, command.dto.expectedUpdatedAt],
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw transitionRuleInUseError(command.actionRuleId);
      }
      throw error;
    }

    if (!result.rows[0]) {
      throw new ApiError(409, 'DEADLINE_TRANSITION_RULE_STALE', 'Deadline transition rule was modified concurrently', {
        actionRuleId: command.actionRuleId,
      });
    }

    const deleted = mapActionRule(result.rows[0]);
    const beforeAudit = actionRuleAuditSnapshot(before);
    await this.writeConfigAudit({
      event: command.audit.event,
      entityType: 'deadline_transition_rule',
      entityId: deleted.actionRuleId,
      userId: String(command.currentUser.id),
      requestId: command.requestId,
      source: command.audit.source,
      relatedOrderId: null,
      relatedClientId: null,
      before: beforeAudit,
      after: { deleted: true, ...beforeAudit },
      diff: diffRecords(beforeAudit, { deleted: true, ...beforeAudit }),
      metadata: buildTransitionRuleAuditMetadata(before, command.dto.reason, command.dto.comment ?? null),
    });

    return deleted;
  }

  async getOrderDeadlineEvaluationContext(orderId: number) {
    const result = await this.database.query<OrderDeadlineEvaluationContextRow>(
      `
      SELECT order_id, order_status_id, completion_date, issue_date
      FROM orders
      WHERE order_id = $1
        AND COALESCE(delete_flag, false) = false
      `,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      orderId: toNumber(row.order_id),
      orderStatusId: toNumber(row.order_status_id),
      isCompleted: row.completion_date !== null || row.issue_date !== null,
    };
  }

  async isDeadlineEventCurrentForOrder(query: DeadlineEventCurrentForOrderQuery): Promise<boolean> {
    if (!query.deadlineId || !query.deadlineEventId) {
      return false;
    }

    const result = await this.database.query<{ exists: boolean }>(
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
      [query.orderId, query.deadlineEventId, query.deadlineId],
    );

    return result.rows.length > 0;
  }

  private async requireDeadline(deadlineId: string): Promise<DeadlineInstanceDto> {
    const deadline = await this.getDeadlineById(deadlineId);
    if (!deadline) {
      throw new ApiError(404, 'DEADLINE_NOT_FOUND', 'Deadline not found', { deadlineId });
    }

    return deadline;
  }

  private async findDeadlineByIdempotencyKey(idempotencyKey: string): Promise<DeadlineInstanceDto | null> {
    const result = await this.database.query<DeadlineRow>(
      `SELECT ${DEADLINE_COLUMNS} FROM deadline_instances WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];

    return row ? mapDeadline(row) : null;
  }

  private async createPolicyVersion(
    policyId: string,
    versionNumber: number,
    config: Record<string, unknown>,
    actorUserId: string,
  ): Promise<void> {
    await this.database.query(
      `
      INSERT INTO deadline_policy_versions (
        policy_id, version_number, config_json, created_by_user_id
      )
      VALUES ($1, $2, $3::jsonb, $4)
      `,
      [policyId, versionNumber, JSON.stringify(config), Number(actorUserId)],
    );
  }

  private async findActiveOrderOverride(input: {
    orderId: number;
    policyId?: string | null;
    actionRuleId?: string | null;
  }): Promise<DeadlineOrderOverrideDto | null> {
    const result = await this.database.query<DeadlineOrderOverrideRow>(
      `
      SELECT ${ORDER_OVERRIDE_COLUMNS}
      FROM deadline_order_overrides
      WHERE order_id = $1
        AND retired_at IS NULL
        AND (($2::uuid IS NOT NULL AND policy_id = $2::uuid)
          OR ($3::uuid IS NOT NULL AND action_rule_id = $3::uuid))
      LIMIT 1
      `,
      [input.orderId, input.policyId ?? null, input.actionRuleId ?? null],
    );
    const row = result.rows[0];

    return row ? mapOrderOverride(row) : null;
  }

  private async findActiveOrderOverrideById(
    overrideId: string,
    orderId: number,
  ): Promise<DeadlineOrderOverrideDto | null> {
    const result = await this.database.query<DeadlineOrderOverrideRow>(
      `
      SELECT ${ORDER_OVERRIDE_COLUMNS}
      FROM deadline_order_overrides
      WHERE override_id = $1
        AND order_id = $2
        AND retired_at IS NULL
      LIMIT 1
      `,
      [overrideId, orderId],
    );
    const row = result.rows[0];

    return row ? mapOrderOverride(row) : null;
  }

  private async assertActiveOrderStatusesExist(statusIds: number[]): Promise<void> {
    const uniqueStatusIds = [...new Set(statusIds)];
    if (uniqueStatusIds.length === 0) {
      return;
    }

    const result = await this.database.query<{ order_status_id: string | number }>(
      `
      SELECT order_status_id
      FROM order_statuses
      WHERE order_status_id = ANY($1::bigint[])
        AND is_active = true
      `,
      [uniqueStatusIds],
    );
    const found = new Set(result.rows.map((row) => Number(row.order_status_id)));
    const missingStatusIds = uniqueStatusIds.filter((statusId) => !found.has(statusId));
    if (missingStatusIds.length > 0) {
      throw new ApiError(422, 'DEADLINE_TRANSITION_RULE_STATUS_NOT_FOUND', 'Deadline transition rule references inactive or missing order statuses', {
        statusIds: missingStatusIds,
      });
    }
  }

  private async assertTransitionRuleNotReferenced(actionRuleId: string): Promise<void> {
    const overrides = await this.database.query<{ total: string | number }>(
      `
      SELECT COUNT(*)::int AS total
      FROM deadline_order_overrides
      WHERE action_rule_id = $1
      `,
      [actionRuleId],
    );
    const executions = await this.database.query<{ total: string | number }>(
      `
      SELECT COUNT(*)::int AS total
      FROM deadline_action_executions
      WHERE action_rule_id = $1
      `,
      [actionRuleId],
    );

    if (Number(overrides.rows[0]?.total ?? 0) > 0 || Number(executions.rows[0]?.total ?? 0) > 0) {
      throw transitionRuleInUseError(actionRuleId);
    }
  }

  private async upsertSettingActionRule(
    scopeType: DeadlineEntityType,
    actionType: DeadlineActionType,
    enabled: boolean,
  ): Promise<void> {
    const existing = await this.database.query<{ action_rule_id: string }>(
      `
      SELECT action_rule_id
      FROM deadline_action_rules
      WHERE scope_type = $1
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = $2
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [scopeType, actionType],
    );
    const actionRuleId = existing.rows[0]?.action_rule_id;

    if (!actionRuleId) {
      await this.database.query(
        `
        INSERT INTO deadline_action_rules (scope_type, event_type, action_type, is_enabled, config_json)
        VALUES ($1, 'DEADLINE_EXPIRED', $2, $3, '{}'::jsonb)
        `,
        [scopeType, actionType, enabled],
      );
      return;
    }

    await this.database.query(
      `
      UPDATE deadline_action_rules
      SET is_enabled = $2,
          updated_at = now()
      WHERE action_rule_id = $1
      `,
      [actionRuleId, enabled],
    );
  }

  private async writeConfigAudit(input: {
    event: string;
    entityType: string;
    entityId: string;
    userId: string;
    requestId?: string;
    source?: string;
    relatedOrderId?: number | null;
    relatedClientId?: number | null;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    diff: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, request_id, source,
        related_order_id, related_client_id,
        before_json, after_json, diff_json, metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8,
        $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb
      )
      `,
      [
        input.event,
        input.entityType,
        input.entityId,
        input.userId,
        input.requestId ?? 'deadline-command',
        input.source ?? 'backend-deadline-command',
        input.relatedOrderId ?? null,
        input.relatedClientId ?? null,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        JSON.stringify(input.diff),
        JSON.stringify(input.metadata),
      ],
    );
  }

  private async writeAuditEvent(event: DeadlineEventDto): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const beforeStatus = typeof payload.beforeStatus === 'string' ? payload.beforeStatus : null;
    const afterStatus = typeof payload.afterStatus === 'string' ? payload.afterStatus : null;
    const beforeDeadlineAt = typeof payload.beforeDeadlineAt === 'string' ? payload.beforeDeadlineAt : null;
    const afterDeadlineAt = typeof payload.afterDeadlineAt === 'string' ? payload.afterDeadlineAt : null;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : 'deadline-engine';
    const source = typeof payload.source === 'string'
      ? payload.source
      : typeof payload.requestId === 'string'
        ? 'backend-deadline-command'
        : 'deadline-engine';
    const trigger = payload.trigger === 'scheduler' ? 'scheduler' : 'manual';
    const auditSource = source === 'deadline-engine' ? `deadline-engine-${trigger}` : source;
    const actorUserId =
      typeof payload.actorUserId === 'string' || typeof payload.actorUserId === 'number'
        ? String(payload.actorUserId)
        : null;
    const workerId = typeof payload.workerId === 'string' ? payload.workerId : null;
    const schedulerRunId = typeof payload.schedulerRunId === 'string' ? payload.schedulerRunId : null;
    const beforeJson = {
      ...(beforeStatus ? { status: beforeStatus } : {}),
      ...(beforeDeadlineAt ? { deadlineAt: beforeDeadlineAt } : {}),
    };
    const afterJson = {
      ...(afterStatus ? { status: afterStatus } : {}),
      ...(afterDeadlineAt ? { deadlineAt: afterDeadlineAt } : {}),
    };
    const diffJson = {
      ...(afterStatus ? { status: { from: beforeStatus, to: afterStatus } } : {}),
      ...(afterDeadlineAt ? { deadlineAt: { from: beforeDeadlineAt, to: afterDeadlineAt } } : {}),
    };

    await this.database.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, request_id, source,
        related_order_id, related_client_id,
        before_json, after_json, diff_json, metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8,
        $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb
      )
      `,
      [
        `deadlines.${event.eventType.toLowerCase()}`,
        'deadline',
        event.deadlineId,
        actorUserId,
        requestId,
        auditSource,
        event.orderId ?? null,
        event.clientId ?? null,
        JSON.stringify(beforeJson),
        JSON.stringify(afterJson),
        JSON.stringify(diffJson),
        JSON.stringify({
          deadlineEventId: event.deadlineEventId,
          eventType: event.eventType,
          entityType: event.entityType,
          entityId: event.entityId,
          orderWorkshopId: event.orderWorkshopId ?? null,
          reason,
          trigger,
          workerId,
          schedulerRunId,
        }),
      ],
    );
  }

  private async enqueueOutboxEvent(event: DeadlineEventDto): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
    const actorUserId =
      typeof payload.actorUserId === 'string' || typeof payload.actorUserId === 'number'
        ? String(payload.actorUserId)
        : null;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const beforeStatus = typeof payload.beforeStatus === 'string' ? payload.beforeStatus : null;
    const afterStatus = typeof payload.afterStatus === 'string' ? payload.afterStatus : null;
    const beforeDeadlineAt = typeof payload.beforeDeadlineAt === 'string' ? payload.beforeDeadlineAt : null;
    const afterDeadlineAt = typeof payload.afterDeadlineAt === 'string' ? payload.afterDeadlineAt : null;
    const includeDeadlineAt = event.eventType === 'DEADLINE_UPDATED';
    const deadlineAt = includeDeadlineAt ? afterDeadlineAt ?? event.deadlineAt ?? null : null;
    const workerId = typeof payload.workerId === 'string' ? payload.workerId : null;
    const trigger = payload.trigger === 'scheduler' ? 'scheduler' : 'manual';
    const schedulerRunId = typeof payload.schedulerRunId === 'string' ? payload.schedulerRunId : null;
    const source = typeof payload.source === 'string'
      ? payload.source
      : requestId
        ? 'backend-deadline-command'
        : 'deadline-engine';

    await this.database.query(
      `
      INSERT INTO outbox_events (
        event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
      )
      VALUES ($1, 'deadline', $2, $3::jsonb, $4)
      ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        'deadline.event.created',
        event.deadlineId,
        JSON.stringify({
          deadlineEventId: event.deadlineEventId,
          eventType: event.eventType,
          entityType: event.entityType,
          entityId: event.entityId,
          orderId: event.orderId ?? null,
          requestId,
          actorUserId,
          reason,
          ...(includeDeadlineAt ? { deadlineAt, beforeDeadlineAt, afterDeadlineAt } : {}),
          beforeStatus,
          afterStatus,
          trigger,
          workerId,
          schedulerRunId,
          source,
        }),
        `deadline-event:${event.deadlineEventId}:outbox`,
      ],
    );
  }
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function policyAuditSnapshot(policy: DeadlinePolicyDto): Record<string, unknown> {
  return {
    policyCode: policy.policyCode,
    policyName: policy.policyName,
    scopeType: policy.scopeType,
    targetType: policy.targetType ?? null,
    targetCode: policy.targetCode ?? null,
    durationValue: policy.durationValue ?? null,
    durationUnit: policy.durationUnit ?? null,
    startPoint: policy.startPoint ?? null,
    isEnabled: policy.isEnabled,
  };
}

function actionRuleAuditSnapshot(rule: DeadlineActionRuleDto): Record<string, unknown> {
  return {
    actionRuleId: rule.actionRuleId,
    scopeType: rule.scopeType,
    eventType: rule.eventType,
    actionType: rule.actionType,
    isEnabled: rule.isEnabled,
    priority: rule.priority,
    config: rule.config ?? {},
  };
}

function orderOverrideAuditSnapshot(override: DeadlineOrderOverrideDto): Record<string, unknown> {
  return {
    overrideId: override.overrideId,
    orderId: override.orderId,
    targetType: override.targetType,
    policyId: override.policyId ?? null,
    actionRuleId: override.actionRuleId ?? null,
    isDisabled: override.isDisabled,
    overrideConfig: override.overrideConfig,
    reason: override.reason,
    retiredByUserId: override.retiredByUserId ?? null,
    retiredAt: override.retiredAt ?? null,
  };
}

function buildCreateTransitionRuleConfig(
  dto: CreateGlobalTransitionRuleCommand['dto'],
): DeadlineActionRuleConfigDto {
  return {
    ...(dto.ruleCode ? { ruleCode: dto.ruleCode } : {}),
    scope: { type: 'global_orders' },
    conditions: {
      allowedFromOrderStatusIds: dto.allowedFromOrderStatusIds,
      excludeOrderStatusIds: dto.excludeOrderStatusIds ?? [],
      excludeCompletedOrders: dto.excludeCompletedOrders ?? true,
      requireCurrentDeadlineEvent: dto.requireCurrentDeadlineEvent ?? true,
    },
    actionConfig: {
      targetOrderStatusId: dto.targetOrderStatusId,
    },
  };
}

function buildTransitionRuleConfig(
  current: DeadlineActionRuleConfigDto | null | undefined,
  dto: UpdateGlobalTransitionRuleCommand['dto'],
): DeadlineActionRuleConfigDto {
  return {
    ...(current ?? {}),
    scope: { type: 'global_orders' },
    conditions: {
      ...(current?.conditions ?? {}),
      ...(hasOwn(dto, 'allowedFromOrderStatusIds')
        ? { allowedFromOrderStatusIds: dto.allowedFromOrderStatusIds }
        : {}),
      ...(hasOwn(dto, 'excludeOrderStatusIds')
        ? { excludeOrderStatusIds: dto.excludeOrderStatusIds }
        : {}),
      ...(hasOwn(dto, 'excludeCompletedOrders')
        ? { excludeCompletedOrders: dto.excludeCompletedOrders }
        : {}),
      ...(hasOwn(dto, 'requireCurrentDeadlineEvent')
        ? { requireCurrentDeadlineEvent: dto.requireCurrentDeadlineEvent }
        : {}),
    },
    actionConfig: {
      ...(current?.actionConfig ?? {}),
      ...(hasOwn(dto, 'targetOrderStatusId')
        ? { targetOrderStatusId: dto.targetOrderStatusId }
        : {}),
    },
  };
}

function buildTransitionRuleAuditMetadata(
  rule: DeadlineActionRuleDto,
  reason: string,
  comment: string | null,
): Record<string, unknown> {
  return {
    actionRuleId: rule.actionRuleId,
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    scopeType: 'order',
    scope: { type: 'global_orders' },
    targetOrderStatusId: rule.config?.actionConfig?.targetOrderStatusId ?? null,
    allowedFromOrderStatusIds: rule.config?.conditions?.allowedFromOrderStatusIds ?? [],
    excludeOrderStatusIds: rule.config?.conditions?.excludeOrderStatusIds ?? [],
    excludeCompletedOrders: rule.config?.conditions?.excludeCompletedOrders ?? true,
    requireCurrentDeadlineEvent: rule.config?.conditions?.requireCurrentDeadlineEvent ?? true,
    priority: rule.priority,
    isEnabled: rule.isEnabled,
    reason,
    comment,
  };
}

function transitionRuleInUseError(actionRuleId: string): ApiError {
  return new ApiError(409, 'DEADLINE_TRANSITION_RULE_IN_USE', 'Deadline transition rule is referenced and cannot be deleted', {
    actionRuleId,
  });
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23503';
}

function sameMillisecond(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return !Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime === rightTime;
}

function pickRecord(
  value: DeadlineSettingsDto,
  keys: ReadonlyArray<keyof DeadlineSettingsDto>,
): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (!Object.is(before[key], after[key])) {
      diff[key] = {
        from: before[key] ?? null,
        to: after[key] ?? null,
      };
    }
  }

  return diff;
}

function buildDeadlineFilter(query: DeadlineListQuery): {
  whereSql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.entityType) clauses.push(`d.entity_type = $${params.push(query.entityType)}`);
  if (query.entityId) clauses.push(`d.entity_id = $${params.push(query.entityId)}`);
  if (query.orderId) clauses.push(`d.order_id = $${params.push(query.orderId)}`);
  if (query.status) clauses.push(`d.status = $${params.push(query.status)}`);
  if (query.responsibleUserId) {
    clauses.push(`d.responsible_user_id = $${params.push(query.responsibleUserId)}`);
  }
  if (query.dateFrom) clauses.push(`d.deadline_at >= $${params.push(query.dateFrom)}::timestamptz`);
  if (query.dateTo) clauses.push(`d.deadline_at <= $${params.push(query.dateTo)}::timestamptz`);
  if (query.onlyOverdue) {
    clauses.push(`(d.status = 'expired' OR (d.status = 'active' AND d.deadline_at < now()))`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function deadlineSortColumn(sortBy: string): string {
  const columns: Record<string, string> = {
    deadlineAt: 'd.deadline_at',
    status: 'd.status',
    entityType: 'd.entity_type',
    orderId: 'd.order_id',
    responsibleUserId: 'd.responsible_user_id',
    createdAt: 'd.created_at',
    updatedAt: 'd.updated_at',
  };

  return columns[sortBy] ?? columns.deadlineAt;
}

export function mapDeadline(row: DeadlineRow): DeadlineInstanceDto {
  return {
    deadlineId: row.deadline_id,
    policyId: row.policy_id,
    policyVersionId: row.policy_version_id,
    entityType: row.entity_type as DeadlineEntityType,
    entityId: row.entity_id,
    parentEntityType: row.parent_entity_type,
    parentEntityId: row.parent_entity_id,
    orderId: toNullableNumber(row.order_id),
    orderWorkshopId: toNullableNumber(row.order_workshop_id),
    clientId: toNullableNumber(row.client_id),
    responsibleUserId: toNullableNumber(row.responsible_user_id),
    deadlineAt: toIso(row.deadline_at),
    status: row.status as DeadlineStatus,
    source: row.source as DeadlineInstanceDto['source'],
    isManuallyOverridden: row.is_manually_overridden,
    policySnapshot: row.policy_snapshot_json,
    metadata: row.metadata_json,
    startedAt: toNullableIso(row.started_at),
    completedAt: toNullableIso(row.completed_at),
    expiredAt: toNullableIso(row.expired_at),
    cancelledAt: toNullableIso(row.cancelled_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: DeadlineEventRow): DeadlineEventDto {
  return {
    deadlineEventId: row.deadline_event_id,
    deadlineId: row.deadline_id,
    eventType: row.event_type as DeadlineEventType,
    severity: row.severity as DeadlineEventSeverity,
    entityType: row.entity_type as DeadlineEntityType,
    entityId: row.entity_id,
    orderId: toNullableNumber(row.order_id),
    orderWorkshopId: toNullableNumber(row.order_workshop_id),
    clientId: toNullableNumber(row.client_id),
    deadlineAt: toNullableIso(row.deadline_at),
    eventAt: toIso(row.event_at),
    delayMinutes: toNullableNumber(row.delay_minutes),
    payload: row.payload_json,
    createdAt: toIso(row.created_at),
  };
}

function mapPolicy(row: DeadlinePolicyRow): DeadlinePolicyDto {
  return {
    policyId: row.policy_id,
    policyCode: row.policy_code,
    policyName: row.policy_name,
    scopeType: row.scope_type as DeadlineEntityType,
    targetType: row.target_type,
    targetCode: row.target_code,
    durationValue: toNullableNumber(row.duration_value),
    durationUnit: row.duration_unit as DeadlinePolicyDto['durationUnit'],
    startPoint: row.start_point,
    isEnabled: row.is_enabled,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapActionRule(row: DeadlineActionRuleRow): DeadlineActionRuleDto {
  return {
    actionRuleId: row.action_rule_id,
    policyId: row.policy_id,
    scopeType: row.scope_type as DeadlineEntityType,
    eventType: row.event_type as DeadlineEventType,
    actionType: row.action_type as DeadlineActionType,
    isEnabled: row.is_enabled,
    priority: toNumber(row.priority),
    config: row.config_json as DeadlineActionRuleConfigDto | null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapActionExecution(row: DeadlineActionExecutionRow): DeadlineActionExecutionDto {
  return {
    actionExecutionId: row.action_execution_id,
    deadlineEventId: row.deadline_event_id,
    actionRuleId: row.action_rule_id,
    actionType: row.action_type as DeadlineActionType,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    skipReason: row.skip_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    result: row.result_json,
    ruleConfigSnapshot: row.rule_config_snapshot_json as unknown as DeadlineRuleConfigSnapshotDto,
    ruleVersionId: row.rule_version_id,
    orderId: toNullableNumber(row.order_id),
    targetStatusId: toNullableNumber(row.target_status_id),
    executedAt: toNullableIso(row.executed_at),
    createdAt: toIso(row.created_at),
  };
}

function mapOrderOverride(row: DeadlineOrderOverrideRow): DeadlineOrderOverrideDto {
  return {
    overrideId: row.override_id,
    orderId: toNumber(row.order_id),
    targetType: row.policy_id ? 'policy' : 'action_rule',
    policyId: row.policy_id,
    actionRuleId: row.action_rule_id,
    isDisabled: row.is_disabled,
    overrideConfig: row.override_config_json,
    reason: row.reason,
    createdByUserId: toNumber(row.created_by_user_id),
    updatedByUserId: toNumber(row.updated_by_user_id),
    retiredByUserId: toNullableNumber(row.retired_by_user_id),
    retiredAt: toNullableIso(row.retired_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  return toNumber(value);
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: string | Date | null): string | null {
  return value === null || value === undefined ? null : toIso(value);
}
