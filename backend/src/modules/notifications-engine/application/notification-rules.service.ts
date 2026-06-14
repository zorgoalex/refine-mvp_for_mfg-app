import { ApiError } from '../../../common/errors/api-error';
import { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { USER_ROLES, type PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import { validateNotificationRuleInput } from '../domain/notification-rule-validation';
import type { NotificationRule } from '../domain/notification-rule.types';
import type {
  CreateNotificationRuleInput,
  NotificationRuleRepositoryPort,
  UpdateNotificationRuleInput,
} from '../ports/notification-rule-repository.port';

const SOURCE = 'backend';
const ENTITY_TYPE = 'notification_rule';
const MANAGE_PERMISSION: PermissionName = 'notifications.manage_rules';
const VIEW_PERMISSION: PermissionName = 'notifications.view_rules';

/**
 * Minimal database dependency: a pool-backed client for reads plus a
 * transaction runner that yields a participating `TransactionClient` for
 * writes. `DatabaseService` satisfies this shape directly.
 */
export type NotificationRulesDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

export interface CreateNotificationRuleCommandInput {
  ruleCode: string;
  eventType: string;
  projectId?: string | null;
  level: 'info' | 'warning' | 'error';
  priority: number;
  isEnabled: boolean;
  conditions: NotificationRule['conditions'];
  recipients: NotificationRule['recipients'];
  titleTemplate?: string | null;
  messageTemplate?: string | null;
}

export interface UpdateNotificationRuleCommandInput {
  patch: {
    projectId?: string | null;
    level?: 'info' | 'warning' | 'error';
    priority?: number;
    isEnabled?: boolean;
    conditions?: NotificationRule['conditions'];
    recipients?: NotificationRule['recipients'];
    titleTemplate?: string | null;
    messageTemplate?: string | null;
  };
  reason?: string;
  expectedUpdatedAt?: string;
}

export interface ListNotificationRulesFilter {
  eventType?: string;
  isEnabled?: boolean;
  projectId?: string | 'global';
}

export interface NotificationRulesServicePorts {
  repository: NotificationRuleRepositoryPort;
  database: NotificationRulesDatabase;
  permissions?: PermissionsService;
  auditService?: AuditService;
}

/**
 * Command/query service for notification rules. Owns RBAC enforcement,
 * domain validation, and transactional persistence + audit (audit-first
 * invariant: every mutation, including denials, is recorded). HTTP-level
 * feature-flag/read-only gating lives in the controller (Task 10), not here.
 */
export class NotificationRulesService {
  private readonly permissions: PermissionsService;
  private readonly audit: AuditService;

  constructor(private readonly ports: NotificationRulesServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
    this.audit = ports.auditService ?? new AuditService();
  }

  async create(
    currentUser: CurrentUser,
    requestId: string,
    input: CreateNotificationRuleCommandInput,
  ): Promise<NotificationRule> {
    await this.requireManagePermission(currentUser, requestId, '(none)', 'notification.rule_create_denied');

    const validation = validateNotificationRuleInput(input, { knownRoleCodes: USER_ROLES });
    if (!validation.ok) {
      throw new ApiError(422, 'INVALID_NOTIFICATION_RULE', 'Notification rule validation failed', {
        code: validation.code,
        detail: validation.detail,
      });
    }

    return this.ports.database.transaction(async (client) => {
      const createInput: CreateNotificationRuleInput = {
        ruleCode: input.ruleCode,
        eventType: input.eventType,
        projectId: input.projectId ?? null,
        level: input.level,
        priority: input.priority,
        isEnabled: input.isEnabled,
        conditions: toJsonRecord(input.conditions),
        recipients: toJsonRecord(input.recipients),
        titleTemplate: input.titleTemplate ?? null,
        messageTemplate: input.messageTemplate ?? null,
        createdByUserId: Number(currentUser.id),
      };

      const rule = await this.ports.repository.create(client, createInput);

      await this.audit.record(client, {
        event: 'notification.rule_created',
        entityType: ENTITY_TYPE,
        entityId: rule.notificationRuleId,
        actorUserId: currentUser.id,
        actorUsername: currentUser.username,
        actorRole: currentUser.role,
        requestId,
        source: SOURCE,
        after: serializeRule(rule),
        metadata: { eventType: rule.eventType, ruleCode: rule.ruleCode },
      });

      return rule;
    });
  }

  async update(
    currentUser: CurrentUser,
    requestId: string,
    ruleId: string,
    command: UpdateNotificationRuleCommandInput,
  ): Promise<NotificationRule> {
    await this.requireManagePermission(currentUser, requestId, ruleId, 'notification.rule_update_denied');

    const existing = await this.ports.repository.getById(this.ports.database, ruleId);
    if (!existing) {
      throw new ApiError(404, 'NOTIFICATION_RULE_NOT_FOUND', 'Notification rule not found', { ruleId });
    }

    const merged = mergeRuleWithPatch(existing, command.patch);
    const validation = validateNotificationRuleInput(merged, { knownRoleCodes: USER_ROLES });
    if (!validation.ok) {
      throw new ApiError(422, 'INVALID_NOTIFICATION_RULE', 'Notification rule validation failed', {
        code: validation.code,
        detail: validation.detail,
      });
    }

    return this.ports.database.transaction(async (client) => {
      const { conditions, recipients, ...patchRest } = command.patch;
      const updateInput: UpdateNotificationRuleInput = {
        ...patchRest,
        ...(conditions !== undefined ? { conditions: toJsonRecord(conditions) } : {}),
        ...(recipients !== undefined ? { recipients: toJsonRecord(recipients) } : {}),
        updatedByUserId: Number(currentUser.id),
        ...(command.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: command.expectedUpdatedAt } : {}),
      };

      const updated = await this.ports.repository.update(client, ruleId, updateInput);

      await this.audit.record(client, {
        event: 'notification.rule_updated',
        entityType: ENTITY_TYPE,
        entityId: updated.notificationRuleId,
        actorUserId: currentUser.id,
        actorUsername: currentUser.username,
        actorRole: currentUser.role,
        requestId,
        source: SOURCE,
        before: serializeRule(existing),
        after: serializeRule(updated),
        diff: diffRules(existing, updated),
        metadata: {
          eventType: updated.eventType,
          ruleCode: updated.ruleCode,
          reason: command.reason ?? null,
        },
      });

      return updated;
    });
  }

  async delete(currentUser: CurrentUser, requestId: string, ruleId: string): Promise<NotificationRule> {
    await this.requireManagePermission(currentUser, requestId, ruleId, 'notification.rule_delete_denied');

    return this.ports.database.transaction(async (client) => {
      const deleted = await this.ports.repository.delete(client, ruleId);
      if (!deleted) {
        throw new ApiError(404, 'NOTIFICATION_RULE_NOT_FOUND', 'Notification rule not found', { ruleId });
      }

      await this.audit.record(client, {
        event: 'notification.rule_deleted',
        entityType: ENTITY_TYPE,
        entityId: deleted.notificationRuleId,
        actorUserId: currentUser.id,
        actorUsername: currentUser.username,
        actorRole: currentUser.role,
        requestId,
        source: SOURCE,
        before: serializeRule(deleted),
        metadata: { eventType: deleted.eventType, ruleCode: deleted.ruleCode },
      });

      return deleted;
    });
  }

  async list(currentUser: CurrentUser, filter: ListNotificationRulesFilter): Promise<NotificationRule[]> {
    this.requirePermission(currentUser, VIEW_PERMISSION);
    return this.ports.repository.list(this.ports.database, filter);
  }

  async getById(currentUser: CurrentUser, ruleId: string): Promise<NotificationRule> {
    this.requirePermission(currentUser, VIEW_PERMISSION);

    const rule = await this.ports.repository.getById(this.ports.database, ruleId);
    if (!rule) {
      throw new ApiError(404, 'NOTIFICATION_RULE_NOT_FOUND', 'Notification rule not found', { ruleId });
    }

    return rule;
  }

  /**
   * Checks `notifications.manage_rules`; on denial writes a denied audit row
   * (audit-first invariant — denials are query/report-ready, not silent
   * 403s) and throws the same 403 ApiError as permitted command services.
   */
  private async requireManagePermission(
    currentUser: CurrentUser,
    requestId: string,
    entityId: string,
    deniedEvent: string,
  ): Promise<void> {
    if (this.permissions.canUser(currentUser, MANAGE_PERMISSION)) {
      return;
    }

    await this.audit.recordDenied(this.ports.database, {
      event: deniedEvent,
      entityType: ENTITY_TYPE,
      entityId,
      actorUserId: currentUser.id,
      actorUsername: currentUser.username,
      actorRole: currentUser.role,
      requestId,
      source: SOURCE,
      reason: 'PERMISSION_DENIED',
      requiredPermissions: [MANAGE_PERMISSION],
    });

    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [MANAGE_PERMISSION],
    });
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}

/**
 * The repository port stores `conditions`/`recipients` as plain JSONB
 * (`Record<string, unknown>`), while the domain/validator types
 * (`NotificationRuleConditions`/`NotificationRuleRecipients`) are narrower
 * structural shapes without index signatures. Both are plain JSON-safe
 * object literals, so this is an intentional type-level widening at the
 * persistence boundary — mirrors `toNotificationRuleRecipients` in the DTO
 * parser, which performs the inverse narrowing.
 */
function toJsonRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Plain serializable projection of the rule for audit before/after columns. */
function serializeRule(rule: NotificationRule): Record<string, unknown> {
  return {
    notificationRuleId: rule.notificationRuleId,
    ruleCode: rule.ruleCode,
    eventType: rule.eventType,
    projectId: rule.projectId,
    isEnabled: rule.isEnabled,
    priority: rule.priority,
    level: rule.level,
    conditions: rule.conditions,
    recipients: rule.recipients,
    titleTemplate: rule.titleTemplate,
    messageTemplate: rule.messageTemplate,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

const DIFFABLE_FIELDS = [
  'level',
  'projectId',
  'priority',
  'isEnabled',
  'conditions',
  'recipients',
  'titleTemplate',
  'messageTemplate',
] as const;

/**
 * `eventType`/`ruleCode` are immutable, so the diff only ever covers the
 * fields that `UpdateNotificationRulePatch` can change — including
 * `isEnabled`. Per the plan, enable/disable is folded into
 * `notification.rule_updated` rather than emitting separate
 * `notification.rule_enabled` / `notification.rule_disabled` events: simpler
 * and still query/report-ready since `isEnabled` shows up in `diff`.
 */
function diffRules(before: NotificationRule, after: NotificationRule): Record<string, unknown> {
  const diff: Record<string, unknown> = {};

  for (const field of DIFFABLE_FIELDS) {
    const fromValue = before[field];
    const toValue = after[field];
    if (JSON.stringify(fromValue) !== JSON.stringify(toValue)) {
      diff[field] = { from: fromValue, to: toValue };
    }
  }

  return diff;
}

function mergeRuleWithPatch(
  existing: NotificationRule,
  patch: UpdateNotificationRuleCommandInput['patch'],
) {
  return {
    ruleCode: existing.ruleCode,
    eventType: existing.eventType,
    projectId: patch.projectId !== undefined ? patch.projectId : existing.projectId,
    level: patch.level ?? existing.level,
    priority: patch.priority ?? existing.priority,
    conditions: patch.conditions ?? existing.conditions,
    recipients: patch.recipients ?? existing.recipients,
    titleTemplate: patch.titleTemplate !== undefined ? patch.titleTemplate : existing.titleTemplate,
    messageTemplate:
      patch.messageTemplate !== undefined ? patch.messageTemplate : existing.messageTemplate,
  };
}
