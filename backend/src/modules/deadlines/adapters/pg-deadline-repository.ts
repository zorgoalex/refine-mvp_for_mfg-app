import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { DeadlineActionExecutionDto, DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
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
  CreateDeadlinePolicyCommand,
  DeadlineListQuery,
  DeadlineRepositoryPort,
  FindDueDeadlinesCommand,
  ListDeadlinesCommand,
  UpdateDeadlinePolicyCommand,
  UpdateDeadlineSettingsCommand,
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
  executed_at: string | Date | null;
  created_at: string | Date;
}

const DEADLINE_COLUMNS = `
  deadline_id, policy_id, policy_version_id, entity_type, entity_id,
  parent_entity_type, parent_entity_id, order_id, order_workshop_id, client_id,
  responsible_user_id, deadline_at, status, source, is_manually_overridden,
  policy_snapshot_json, metadata_json, started_at, completed_at, expired_at,
  cancelled_at, created_at, updated_at
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
  config_json, created_at, updated_at
`;

const ACTION_EXECUTION_COLUMNS = `
  action_execution_id, deadline_event_id, action_rule_id, action_type, target_type,
  target_id, status, idempotency_key, skip_reason, error_code, error_message,
  result_json, executed_at, created_at
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
        command.dto.policyName ?? row.policy_name,
        command.dto.targetType ?? row.target_type,
        command.dto.targetCode ?? row.target_code,
        command.dto.durationValue ?? row.duration_value,
        command.dto.durationUnit ?? row.duration_unit,
        command.dto.startPoint ?? row.start_point,
        command.dto.isEnabled ?? row.is_enabled,
      ],
    );
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

    return mapPolicy(result.rows[0]);
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
    for (const [settingKey, actionType] of Object.entries(SETTING_ACTIONS)) {
      const enabled = command.dto[settingKey as keyof DeadlineSettingsDto];
      if (enabled === undefined) {
        continue;
      }

      for (const scope of SETTING_SCOPES) {
        await this.upsertSettingActionRule(scope, actionType, enabled);
      }
    }

    return this.getSettings();
  }

  async createDeadlineInstance(command: CreateDeadlineCommand): Promise<DeadlineInstanceDto> {
    const result = await this.database.query<DeadlineRow>(
      `
      INSERT INTO deadline_instances (
        entity_type, entity_id, order_id, order_workshop_id, client_id,
        responsible_user_id, deadline_at, source, metadata_json,
        created_by_user_id, updated_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb, $10, $10)
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
      payload: { source: deadline.source, actorUserId: command.currentUser.id },
    });

    return deadline;
  }

  async overrideDeadline(command: import('../application/deadline.types').OverrideDeadlineCommand): Promise<DeadlineInstanceDto> {
    const current = await this.requireDeadline(command.deadlineId);
    await this.database.query(
      `
      UPDATE deadline_instances
      SET status = 'superseded',
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1
      `,
      [command.deadlineId, Number(command.currentUser.id)],
    );
    const result = await this.database.query<DeadlineRow>(
      `
      INSERT INTO deadline_instances (
        policy_id, policy_version_id, entity_type, entity_id, parent_entity_type,
        parent_entity_id, order_id, order_workshop_id, client_id, responsible_user_id,
        deadline_at, status, source, is_manually_overridden, policy_snapshot_json,
        metadata_json, started_at, created_by_user_id, updated_by_user_id
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11::timestamptz, 'active', 'manual', true, $12::jsonb,
        $13::jsonb, $14, $15, $15
      )
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
        JSON.stringify({ ...(current.metadata ?? {}), ...(command.dto.metadata ?? {}), overrideReason: command.dto.reason }),
        current.startedAt ?? null,
        Number(command.currentUser.id),
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
      },
    });

    return deadline;
  }

  async pauseDeadline(command: import('../application/deadline.types').PauseDeadlineCommand): Promise<DeadlineInstanceDto> {
    const result = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = 'paused',
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [command.deadlineId, Number(command.currentUser.id)],
    );
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
        actorUserId: command.currentUser.id,
      },
    });

    return deadline;
  }

  async resumeDeadline(command: import('../application/deadline.types').ResumeDeadlineCommand): Promise<DeadlineInstanceDto> {
    const result = await this.database.query<DeadlineRow>(
      `
      UPDATE deadline_instances
      SET status = 'active',
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1
      RETURNING ${DEADLINE_COLUMNS}
      `,
      [command.deadlineId, Number(command.currentUser.id)],
    );
    const deadline = mapDeadline(result.rows[0]);
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
      payload: { notes: command.dto.notes ?? null, actorUserId: command.currentUser.id },
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

  async createDeadlineEvent(input: CreateDeadlineEventInput): Promise<DeadlineEventDto> {
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

    if (row.was_inserted !== false) {
      await this.writeAuditEvent(event);
      await this.enqueueOutboxEvent(event);
    }

    return event;
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
      ORDER BY created_at ASC
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
        result_json, executed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)
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
        input.executedAt ?? null,
      ],
    );

    return mapActionExecution(result.rows[0]);
  }

  private async requireDeadline(deadlineId: string): Promise<DeadlineInstanceDto> {
    const deadline = await this.getDeadlineById(deadlineId);
    if (!deadline) {
      throw new ApiError(404, 'DEADLINE_NOT_FOUND', 'Deadline not found', { deadlineId });
    }

    return deadline;
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

  private async writeAuditEvent(event: DeadlineEventDto): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const beforeStatus = typeof payload.beforeStatus === 'string' ? payload.beforeStatus : null;
    const afterStatus = typeof payload.afterStatus === 'string' ? payload.afterStatus : null;
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
        JSON.stringify(beforeStatus ? { status: beforeStatus } : {}),
        JSON.stringify(afterStatus ? { status: afterStatus } : {}),
        JSON.stringify(beforeStatus && afterStatus ? { status: { from: beforeStatus, to: afterStatus } } : {}),
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
    config: row.config_json,
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
    executedAt: toNullableIso(row.executed_at),
    createdAt: toIso(row.created_at),
  };
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: string | Date | null): string | null {
  return value === null || value === undefined ? null : toIso(value);
}
