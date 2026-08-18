import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  OrderAutomationState,
  StatusAutomationActionConfig,
  StatusAutomationActionType,
  StatusAutomationConditions,
  StatusAutomationEventType,
  StatusAutomationRule,
} from '../application/status-automation.types';
import { getEventDescriptor } from '../domain/status-automation-events';

export interface CreateStatusAutomationRuleDto {
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number | null;
  conditions: StatusAutomationConditions;
  actionConfig?: StatusAutomationActionConfig;
  priority: number;
  isEnabled: boolean;
}

export interface UpdateStatusAutomationRuleDto {
  name?: string;
  eventType?: StatusAutomationEventType;
  actionType?: StatusAutomationActionType;
  targetStatusId?: number | null;
  conditions?: StatusAutomationConditions;
  actionConfig?: StatusAutomationActionConfig;
  priority?: number;
  isEnabled?: boolean;
  version: number;
}

interface StatusAutomationRuleRow extends QueryResultRow {
  id: string | number;
  name: string;
  event_type: string;
  action_type: string;
  target_status_id: string | number | null;
  conditions_json: StatusAutomationConditions | string | null;
  action_config_json: StatusAutomationActionConfig | string | null;
  priority: string | number;
  is_enabled: boolean;
  version: string | number;
}

interface OrderAutomationStateRow extends QueryResultRow {
  order_id: string | number;
  order_status_id: string | number;
  payment_status_id: string | number;
  production_status_id: string | number | null;
  production_status_from_details_enabled: boolean;
  final_amount: string | number;
  paid_amount: string | number;
  version: string | number;
  client_id: string | number | null;
  is_bazis: boolean;
  is_import: boolean;
}

interface OrderIdRow extends QueryResultRow {
  order_id: string | number;
}

export class PgStatusAutomationRepository {
  constructor(private readonly database: DatabaseService) {}

  async listRules(): Promise<StatusAutomationRule[]> {
    const result = await this.database.query<StatusAutomationRuleRow>(
      ruleSelectSql('ORDER BY priority, id'),
    );
    return result.rows.map(mapRuleRow);
  }

  async listRecentOrderIdsForAutomation(cutoffDate: string): Promise<number[]> {
    const result = await this.database.query<OrderIdRow>(
      `
      SELECT order_id
      FROM orders
      WHERE delete_flag = false
        AND order_date >= $1::date
        AND order_date <= CURRENT_DATE
      ORDER BY order_date DESC, order_id DESC
      `,
      [cutoffDate],
    );
    return result.rows.map((row) => toNumber(row.order_id));
  }

  createRule(command: {
    currentUser: CurrentUser;
    requestId: string;
    dto: CreateStatusAutomationRuleDto;
  }): Promise<StatusAutomationRule> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      assertConditionsAllowedForEvent(command.dto.eventType, command.dto.conditions, 0);
      assertActionAllowedForEvent(command.dto.eventType, command.dto.actionType, 0);
      const actionConfig = command.dto.actionConfig ?? {};
      assertActionConfigShape(command.dto.actionType, command.dto.targetStatusId, actionConfig, 0);
      await validateRuleStatusReferences(tx, command.dto.actionType, command.dto.targetStatusId, actionConfig);

      const inserted = await tx.query<StatusAutomationRuleRow>(
        `
        INSERT INTO status_automation_rules (
          name, event_type, action_type, target_status_id,
          conditions_json, action_config_json, priority, is_enabled, created_by, edited_by
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $9)
        RETURNING
          id, name, event_type, action_type, target_status_id,
          conditions_json, action_config_json, priority, is_enabled, version
        `,
        [
          command.dto.name,
          command.dto.eventType,
          command.dto.actionType,
          command.dto.targetStatusId,
          JSON.stringify(command.dto.conditions),
          JSON.stringify(actionConfig),
          command.dto.priority,
          command.dto.isEnabled,
          command.currentUser.id,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'Не удалось создать правило автоматизации статуса');
      }
      const rule = mapRuleRow(row);

      await writeRuleAudit(tx, {
        event: 'status_automation.rule_created',
        currentUser: command.currentUser,
        requestId: command.requestId,
        rule,
        before: null,
        after: { ...rule },
      });

      return rule;
    });
  }

  updateRule(command: {
    currentUser: CurrentUser;
    requestId: string;
    ruleId: number;
    dto: UpdateStatusAutomationRuleDto;
  }): Promise<StatusAutomationRule> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const existingResult = await tx.query<StatusAutomationRuleRow>(
        `${ruleSelectSql()} WHERE id = $1`,
        [command.ruleId],
      );
      const existingRow = existingResult.rows[0];
      if (!existingRow) {
        throw ruleNotFound(command.ruleId);
      }
      const existing = mapRuleRow(existingRow);
      const nextEventType = command.dto.eventType ?? existing.eventType;
      const nextActionType = command.dto.actionType ?? existing.actionType;
      const nextTargetStatusId =
        command.dto.targetStatusId !== undefined ? command.dto.targetStatusId : existing.targetStatusId;
      const nextConditions = command.dto.conditions ?? existing.conditions;
      const nextActionConfig = command.dto.actionConfig ?? existing.actionConfig ?? {};
      if (existing.version === command.dto.version) {
        // Валидируется СМЕРДЖЕННОЕ правило, не только дельта: смена eventType без
        // повторной отправки conditions и «оживление» правила с протухшим целевым
        // статусом (PATCH { isEnabled: true }) обязаны падать 422 здесь.
        assertConditionsAllowedForEvent(nextEventType, nextConditions, command.ruleId);
        assertActionAllowedForEvent(nextEventType, nextActionType, command.ruleId);
        assertActionConfigShape(nextActionType, nextTargetStatusId, nextActionConfig, command.ruleId);
        await validateRuleStatusReferences(tx, nextActionType, nextTargetStatusId, nextActionConfig);
      }

      const assignments: string[] = [];
      const values: unknown[] = [command.ruleId, command.dto.version, command.currentUser.id];
      addUpdateAssignment(assignments, values, 'name', command.dto.name);
      addUpdateAssignment(assignments, values, 'event_type', command.dto.eventType);
      addUpdateAssignment(assignments, values, 'action_type', command.dto.actionType);
      addUpdateAssignment(assignments, values, 'target_status_id', command.dto.targetStatusId);
      addUpdateAssignment(
        assignments,
        values,
        'conditions_json',
        command.dto.conditions === undefined ? undefined : JSON.stringify(command.dto.conditions),
        '::jsonb',
      );
      addUpdateAssignment(
        assignments,
        values,
        'action_config_json',
        command.dto.actionConfig === undefined ? undefined : JSON.stringify(command.dto.actionConfig),
        '::jsonb',
      );
      addUpdateAssignment(assignments, values, 'priority', command.dto.priority);
      addUpdateAssignment(assignments, values, 'is_enabled', command.dto.isEnabled);

      const updated = await tx.query<StatusAutomationRuleRow>(
        `
        UPDATE status_automation_rules
        SET ${assignments.length > 0 ? `${assignments.join(', ')}, ` : ''}
            edited_by = $3,
            version = version + 1,
            updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING
          id, name, event_type, action_type, target_status_id,
          conditions_json, action_config_json, priority, is_enabled, version
        `,
        values,
      );
      if (!hasRows(updated)) {
        const stillExists = await tx.query<{ id: string | number }>(
          'SELECT 1 FROM status_automation_rules WHERE id = $1',
          [command.ruleId],
        );
        if (hasRows(stillExists)) {
          throw new ApiError(409, 'STALE_VERSION', 'Правило было изменено другим пользователем', {
            ruleId: command.ruleId,
            expectedVersion: command.dto.version,
          });
        }
        throw ruleNotFound(command.ruleId);
      }

      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'Не удалось обновить правило автоматизации статуса');
      }
      const rule = mapRuleRow(updatedRow);
      await writeRuleAudit(tx, {
        event: 'status_automation.rule_updated',
        currentUser: command.currentUser,
        requestId: command.requestId,
        rule,
        before: { ...existing },
        after: { ...rule },
      });
      return rule;
    });
  }

  deleteRule(command: {
    currentUser: CurrentUser;
    requestId: string;
    ruleId: number;
  }): Promise<{ deleted: true }> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const deleted = await tx.query<StatusAutomationRuleRow>(
        `
        DELETE FROM status_automation_rules
        WHERE id = $1
        RETURNING
          id, name, event_type, action_type, target_status_id,
          conditions_json, action_config_json, priority, is_enabled, version
        `,
        [command.ruleId],
      );
      if (!hasRows(deleted)) {
        throw ruleNotFound(command.ruleId);
      }
      const row = deleted.rows[0];
      if (!row) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'Не удалось удалить правило автоматизации статуса');
      }
      const rule = mapRuleRow(row);
      await writeRuleAudit(tx, {
        event: 'status_automation.rule_deleted',
        currentUser: command.currentUser,
        requestId: command.requestId,
        rule,
        before: { ...rule },
        after: null,
      });
      return { deleted: true };
    });
  }
}

export async function listEnabledRulesForEvent(
  tx: TransactionClient,
  eventType: StatusAutomationEventType,
): Promise<StatusAutomationRule[]> {
  const result = await tx.query<StatusAutomationRuleRow>(
    ruleSelectSql('WHERE event_type = $1 AND is_enabled = true ORDER BY priority, id'),
    [eventType],
  );
  return result.rows.map(mapRuleRow);
}

export async function listEnabledRulesForManualRefresh(
  tx: TransactionClient,
): Promise<StatusAutomationRule[]> {
  const result = await tx.query<StatusAutomationRuleRow>(
    ruleSelectSql('WHERE is_enabled = true ORDER BY priority, id'),
  );
  return result.rows.map(mapRuleRow);
}

export async function loadOrderAutomationState(
  tx: TransactionClient,
  orderId: number,
): Promise<OrderAutomationState | null> {
  const result = await tx.query<OrderAutomationStateRow>(
    `
    SELECT o.order_id, o.order_status_id, o.payment_status_id, o.production_status_id,
           o.production_status_from_details_enabled, o.final_amount, o.paid_amount,
           o.version, o.client_id,
           EXISTS (SELECT 1 FROM bazis_order_links bol WHERE bol.order_id = o.order_id) AS is_bazis,
           EXISTS (SELECT 1 FROM order_import_entity_map m WHERE m.local_order_id = o.order_id) AS is_import
    FROM orders o
    WHERE o.order_id = $1 AND o.delete_flag = false
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
    paymentStatusId: toNumber(row.payment_status_id),
    productionStatusId: row.production_status_id === null ? null : toNumber(row.production_status_id),
    productionStatusFromDetailsEnabled: row.production_status_from_details_enabled,
    finalAmount: toNumber(row.final_amount),
    paidAmount: toNumber(row.paid_amount),
    version: toNumber(row.version),
    clientId: row.client_id === null ? null : toNumber(row.client_id),
    source: row.is_bazis ? 'bazis' : row.is_import ? 'import' : 'manual',
  };
}

function ruleSelectSql(suffix = ''): string {
  return `
    SELECT id, name, event_type, action_type, target_status_id,
           conditions_json, action_config_json, priority, is_enabled, version
    FROM status_automation_rules
    ${suffix}
  `;
}

function assertActionAllowedForEvent(
  eventType: StatusAutomationEventType,
  actionType: StatusAutomationActionType,
  ruleId: number,
): void {
  const descriptor = getEventDescriptor(eventType);
  if (!descriptor || !descriptor.allowedActions.includes(actionType)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Действие ${actionType} неприменимо к событию ${eventType}`, {
      ruleId,
      eventType,
      actionType,
    });
  }
}

function assertConditionsAllowedForEvent(
  eventType: StatusAutomationEventType,
  conditions: StatusAutomationConditions,
  ruleId: number,
): void {
  const descriptor = getEventDescriptor(eventType);
  if (!descriptor) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Неизвестное событие: ${eventType}`, { ruleId });
  }
  const allowed = new Set<string>(descriptor.allowedConditions as readonly string[]);
  const invalidKeys = Object.keys(conditions).filter((key) => !allowed.has(key));
  if (invalidKeys.length > 0) {
    throw new ApiError(
      422,
      'VALIDATION_ERROR',
      `Условия [${invalidKeys.join(', ')}] неприменимы к событию ${eventType}`,
      { ruleId, eventType, invalidKeys },
    );
  }
}

function assertActionConfigShape(
  actionType: StatusAutomationActionType,
  targetStatusId: number | null,
  actionConfig: StatusAutomationActionConfig,
  ruleId: number,
): void {
  const isMapping =
    actionType === 'map_order_status_to_details_production_status' ||
    actionType === 'map_production_status_to_order_status';
  const entries = actionConfig.statusMapping?.entries ?? [];
  if (isMapping && entries.length === 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Для действия маппинга нужны строки соответствий', { ruleId });
  }
  if (!isMapping && targetStatusId === null) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Для действия нужен целевой статус', { ruleId });
  }
}

async function validateRuleStatusReferences(
  tx: TransactionClient,
  actionType: StatusAutomationActionType,
  targetStatusId: number | null,
  actionConfig: StatusAutomationActionConfig,
): Promise<void> {
  if (actionType === 'map_order_status_to_details_production_status') {
    await validateStatusIds(tx, 'order', actionConfig.statusMapping?.entries.flatMap((entry) => entry.sourceStatusIds) ?? [], actionType);
    await validateStatusIds(tx, 'production', actionConfig.statusMapping?.entries.map((entry) => entry.targetStatusId) ?? [], actionType);
    return;
  }
  if (actionType === 'map_production_status_to_order_status') {
    await validateStatusIds(tx, 'production', actionConfig.statusMapping?.entries.flatMap((entry) => entry.sourceStatusIds) ?? [], actionType);
    await validateStatusIds(tx, 'order', actionConfig.statusMapping?.entries.map((entry) => entry.targetStatusId) ?? [], actionType);
    return;
  }
  if (targetStatusId === null) return;
  await validateStatusIds(tx, actionType === 'change_order_status' ? 'order' : 'production', [targetStatusId], actionType);
}

async function validateStatusIds(
  tx: TransactionClient,
  kind: 'order' | 'production',
  statusIds: number[],
  actionType: StatusAutomationActionType,
): Promise<void> {
  const uniqueIds = Array.from(new Set(statusIds));
  if (uniqueIds.length === 0) return;
  const isOrderStatus = kind === 'order';
  const table = isOrderStatus ? 'order_statuses' : 'production_statuses';
  const column = isOrderStatus ? 'order_status_id' : 'production_status_id';
  const result = await tx.query(
    `
    SELECT ${isOrderStatus ? 'order_status_id, order_status_name' : 'production_status_id, production_status_name, production_status_code'}
    FROM ${table}
    WHERE ${column} = ANY($1::bigint[]) AND is_active = true
    `,
    [uniqueIds],
  );
  if (result.rows.length !== uniqueIds.length) {
    throw new ApiError(422, 'TARGET_STATUS_NOT_FOUND', 'Целевой статус не найден или неактивен', {
      actionType,
      statusIds: uniqueIds,
      statusKind: kind,
    });
  }
}

function addUpdateAssignment(
  assignments: string[],
  values: unknown[],
  column: string,
  value: unknown,
  cast = '',
): void {
  if (value === undefined) {
    return;
  }
  const placeholder = values.length + 1;
  values.push(value);
  assignments.push(`${column} = $${placeholder}${cast}`);
}

async function writeRuleAudit(
  tx: TransactionClient,
  event: {
    event: 'status_automation.rule_created' | 'status_automation.rule_updated' | 'status_automation.rule_deleted';
    currentUser: CurrentUser;
    requestId: string;
    rule: StatusAutomationRule;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  await auditService.record(tx, {
    event: event.event,
    entityType: 'status_automation_rule',
    entityId: event.rule.id,
    actorUserId: event.currentUser.id,
    actorUsername: event.currentUser.username,
    actorRole: event.currentUser.role,
    requestId: event.requestId,
    source: 'backend-status-automation',
    before: event.before,
    after: event.after,
    metadata: {
      eventType: event.rule.eventType,
      actionType: event.rule.actionType,
      targetStatusId: event.rule.targetStatusId,
      ...(event.rule.actionConfig?.statusMapping ? { actionConfig: event.rule.actionConfig } : {}),
    },
  });
}

function mapRuleRow(row: StatusAutomationRuleRow): StatusAutomationRule {
  let conditions: StatusAutomationConditions;
  if (typeof row.conditions_json === 'string') {
    conditions = JSON.parse(row.conditions_json) as StatusAutomationConditions;
  } else {
    conditions = row.conditions_json ?? {};
  }
  const actionConfig =
    typeof row.action_config_json === 'string'
      ? (JSON.parse(row.action_config_json) as StatusAutomationActionConfig)
      : row.action_config_json ?? {};

  return {
    id: toNumber(row.id),
    name: row.name,
    eventType: row.event_type as StatusAutomationEventType,
    actionType: row.action_type as StatusAutomationActionType,
    targetStatusId: row.target_status_id === null ? null : toNumber(row.target_status_id),
    conditions,
    actionConfig,
    priority: toNumber(row.priority),
    isEnabled: row.is_enabled,
    version: toNumber(row.version),
  };
}

function hasRows(result: { rows: readonly unknown[]; rowCount: number | null }): boolean {
  return result.rows.length > 0 || (result.rowCount !== null && result.rowCount > 0);
}

function ruleNotFound(ruleId: number): ApiError {
  return new ApiError(404, 'RULE_NOT_FOUND', 'Правило автоматизации статуса не найдено', { ruleId });
}

function setSessionUser(tx: TransactionClient, userId: string): Promise<unknown> {
  return tx.query('SELECT set_session_user($1)', [userId]);
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}
