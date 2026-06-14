import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { AuditEvent, DeniedAuditEvent } from '../../../common/audit/audit-event.types';
import type { NotificationRule } from '../domain/notification-rule.types';
import type {
  CreateNotificationRuleInput,
  NotificationRuleRepositoryPort,
  UpdateNotificationRuleInput,
} from '../ports/notification-rule-repository.port';
import { NotificationRulesService } from './notification-rules.service';

describe('NotificationRulesService', () => {
  describe('create', () => {
    it('persists a valid rule and records notification.rule_created audit', async () => {
      const audit = fakeAuditService();
      const repo = fakeRepository();
      const service = buildService({ repo, audit });

      const rule = await service.create(currentUser(), 'req-create-1', validCreateInput());

      expect(rule.notificationRuleId).toEqual('rule-1');
      expect(repo.created).toHaveLength(1);
      expect(repo.created[0]).toMatchObject({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        isEnabled: true,
        createdByUserId: 1,
      });

      expect(audit.recorded).toHaveLength(1);
      const event = audit.recorded[0];
      expect(event.event).toEqual('notification.rule_created');
      expect(event.entityType).toEqual('notification_rule');
      expect(event.entityId).toEqual('rule-1');
      expect(event.actorUserId).toEqual('1');
      expect(event.requestId).toEqual('req-create-1');
      expect(event.after).toMatchObject({ notificationRuleId: 'rule-1' });
      expect(event.metadata).toMatchObject({
        eventType: 'order.production_status_changed',
        ruleCode: 'notify-order-overdue-manager',
      });
      expect(audit.denied).toHaveLength(0);
    });

    it('denies creation without notifications.manage_rules and records denied audit', async () => {
      const audit = fakeAuditService();
      const repo = fakeRepository();
      const service = buildService({ repo, audit });

      await expect(
        service.create(currentUser([]), 'req-create-denied', validCreateInput()),
      ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);

      expect(repo.created).toHaveLength(0);
      expect(audit.recorded).toHaveLength(0);
      expect(audit.denied).toHaveLength(1);
      const denied = audit.denied[0];
      expect(denied.event).toEqual('notification.rule_create_denied');
      expect(denied.entityType).toEqual('notification_rule');
      expect(denied.entityId).toEqual('(none)');
      expect(denied.actorUserId).toEqual('1');
      expect(denied.requestId).toEqual('req-create-denied');
      expect(denied.requiredPermissions).toEqual(['notifications.manage_rules']);
    });

    it('rejects invalid rule input with 422 and writes no audit or persistence', async () => {
      const audit = fakeAuditService();
      const repo = fakeRepository();
      const service = buildService({ repo, audit });

      await expect(
        service.create(currentUser(), 'req-create-invalid', {
          ...validCreateInput(),
          recipients: { roleCodes: ['ghost-role'] },
        }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'INVALID_NOTIFICATION_RULE',
      } satisfies Partial<ApiError>);

      expect(repo.created).toHaveLength(0);
      expect(audit.recorded).toHaveLength(0);
      expect(audit.denied).toHaveLength(0);
    });

    it('passes projectId through create/update and keeps null as global scope', async () => {
      const repo = fakeRepository({ rules: [createRule()] });
      const service = buildService({ repo });

      await service.create(currentUser(), 'req-project-scope-create', {
        ...validCreateInput(),
        projectId: '11111111-1111-4111-8111-111111111111',
      });

      expect(repo.created[0].projectId).toBe('11111111-1111-4111-8111-111111111111');

      await service.update(currentUser(), 'req-project-scope-update', 'rule-1', {
        patch: { projectId: null },
        reason: 'clear project scope',
      });

      expect(repo.updated.at(-1)).toMatchObject({
        ruleId: 'rule-1',
        patch: { projectId: null },
      });
    });
  });

  describe('update', () => {
    it('persists merged patch and records notification.rule_updated with before/after', async () => {
      const audit = fakeAuditService();
      const existing = createRule({ priority: 100, isEnabled: true });
      const repo = fakeRepository({ rules: [existing] });
      const service = buildService({ repo, audit });

      const updated = await service.update(currentUser(), 'req-update-1', existing.notificationRuleId, {
        patch: { priority: 50, isEnabled: false },
        reason: 'Lower priority while testing',
        expectedUpdatedAt: existing.updatedAt,
      });

      expect(updated.priority).toEqual(50);
      expect(updated.isEnabled).toEqual(false);
      expect(repo.updated).toHaveLength(1);
      expect(repo.updated[0]).toMatchObject({
        ruleId: existing.notificationRuleId,
        patch: expect.objectContaining({
          priority: 50,
          isEnabled: false,
          updatedByUserId: 1,
          expectedUpdatedAt: existing.updatedAt,
        }),
      });

      expect(audit.recorded).toHaveLength(1);
      const event = audit.recorded[0];
      expect(event.event).toEqual('notification.rule_updated');
      expect(event.entityType).toEqual('notification_rule');
      expect(event.entityId).toEqual(existing.notificationRuleId);
      expect(event.before).toMatchObject({ priority: 100, isEnabled: true });
      expect(event.after).toMatchObject({ priority: 50, isEnabled: false });
      expect(event.diff).toMatchObject({
        priority: { from: 100, to: 50 },
        isEnabled: { from: true, to: false },
      });
      expect(event.metadata).toMatchObject({ reason: 'Lower priority while testing' });
    });

    it('throws 404 when the rule does not exist', async () => {
      const audit = fakeAuditService();
      const repo = fakeRepository();
      const service = buildService({ repo, audit });

      await expect(
        service.update(currentUser(), 'req-update-missing', 'missing-rule', { patch: { priority: 10 } }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOTIFICATION_RULE_NOT_FOUND',
      } satisfies Partial<ApiError>);

      expect(repo.updated).toHaveLength(0);
      expect(audit.recorded).toHaveLength(0);
    });

    it('rejects a merged patch that fails validation with 422', async () => {
      const audit = fakeAuditService();
      const existing = createRule();
      const repo = fakeRepository({ rules: [existing] });
      const service = buildService({ repo, audit });

      await expect(
        service.update(currentUser(), 'req-update-invalid', existing.notificationRuleId, {
          patch: { recipients: {} },
        }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'INVALID_NOTIFICATION_RULE',
      } satisfies Partial<ApiError>);

      expect(repo.updated).toHaveLength(0);
      expect(audit.recorded).toHaveLength(0);
    });

    it('denies update without notifications.manage_rules and records denied audit', async () => {
      const audit = fakeAuditService();
      const existing = createRule();
      const repo = fakeRepository({ rules: [existing] });
      const service = buildService({ repo, audit });

      await expect(
        service.update(currentUser([]), 'req-update-denied', existing.notificationRuleId, {
          patch: { priority: 5 },
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);

      expect(repo.updated).toHaveLength(0);
      expect(audit.recorded).toHaveLength(0);
      expect(audit.denied).toHaveLength(1);
      expect(audit.denied[0]).toMatchObject({
        event: 'notification.rule_update_denied',
        entityType: 'notification_rule',
        entityId: existing.notificationRuleId,
        requiredPermissions: ['notifications.manage_rules'],
      });
    });
  });

  describe('delete', () => {
    it('removes the rule and records notification.rule_deleted with before', async () => {
      const audit = fakeAuditService();
      const existing = createRule();
      const repo = fakeRepository({ rules: [existing] });
      const service = buildService({ repo, audit });

      const result = await service.delete(currentUser(), 'req-delete-1', existing.notificationRuleId);

      expect(result.notificationRuleId).toEqual(existing.notificationRuleId);
      expect(repo.deleted).toEqual([existing.notificationRuleId]);

      expect(audit.recorded).toHaveLength(1);
      const event = audit.recorded[0];
      expect(event.event).toEqual('notification.rule_deleted');
      expect(event.entityType).toEqual('notification_rule');
      expect(event.entityId).toEqual(existing.notificationRuleId);
      expect(event.before).toMatchObject({ notificationRuleId: existing.notificationRuleId });
    });

    it('throws 404 when the rule does not exist', async () => {
      const audit = fakeAuditService();
      const repo = fakeRepository();
      const service = buildService({ repo, audit });

      await expect(
        service.delete(currentUser(), 'req-delete-missing', 'missing-rule'),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOTIFICATION_RULE_NOT_FOUND',
      } satisfies Partial<ApiError>);

      expect(audit.recorded).toHaveLength(0);
    });

    it('denies deletion without notifications.manage_rules and records denied audit', async () => {
      const audit = fakeAuditService();
      const existing = createRule();
      const repo = fakeRepository({ rules: [existing] });
      const service = buildService({ repo, audit });

      await expect(
        service.delete(currentUser([]), 'req-delete-denied', existing.notificationRuleId),
      ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);

      expect(repo.deleted).toHaveLength(0);
      expect(audit.denied).toHaveLength(1);
      expect(audit.denied[0]).toMatchObject({
        event: 'notification.rule_delete_denied',
        entityId: existing.notificationRuleId,
        requiredPermissions: ['notifications.manage_rules'],
      });
    });
  });

  describe('list', () => {
    it('requires notifications.view_rules', async () => {
      const repo = fakeRepository({ rules: [createRule()] });
      const service = buildService({ repo });

      await expect(service.list(currentUser([]), {})).rejects.toMatchObject({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
      } satisfies Partial<ApiError>);
    });

    it('returns rules from the repository when permitted', async () => {
      const rule = createRule();
      const repo = fakeRepository({ rules: [rule] });
      const service = buildService({ repo, viewerPermissions: ['notifications.view_rules'] });

      const result = await service.list(currentUser(['notifications.view_rules']), {});
      expect(result).toEqual([rule]);
    });
  });

  describe('getById', () => {
    it('requires notifications.view_rules', async () => {
      const rule = createRule();
      const repo = fakeRepository({ rules: [rule] });
      const service = buildService({ repo });

      await expect(service.getById(currentUser([]), rule.notificationRuleId)).rejects.toMatchObject({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
      } satisfies Partial<ApiError>);
    });

    it('returns the rule when permitted', async () => {
      const rule = createRule();
      const repo = fakeRepository({ rules: [rule] });
      const service = buildService({ repo });

      const result = await service.getById(currentUser(['notifications.view_rules']), rule.notificationRuleId);
      expect(result).toEqual(rule);
    });

    it('throws 404 when the rule does not exist', async () => {
      const repo = fakeRepository();
      const service = buildService({ repo });

      await expect(
        service.getById(currentUser(['notifications.view_rules']), 'missing-rule'),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOTIFICATION_RULE_NOT_FOUND',
      } satisfies Partial<ApiError>);
    });
  });
});

function buildService(options: {
  repo: NotificationRuleRepositoryPort;
  audit?: ReturnType<typeof fakeAuditService>;
  viewerPermissions?: readonly string[];
}): NotificationRulesService {
  return new NotificationRulesService({
    repository: options.repo,
    database: fakeDatabase(),
    auditService: options.audit ?? fakeAuditService(),
  });
}

function currentUser(permissions: readonly string[] = getPermissionsForRole('admin')): CurrentUser {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: permissions as CurrentUser['permissions'],
  };
}

function validCreateInput(): CreateNotificationRuleInput & { isEnabled: boolean } {
  return {
    ruleCode: 'notify-order-overdue-manager',
    eventType: 'order.production_status_changed',
    level: 'warning',
    priority: 100,
    isEnabled: true,
    conditions: { excludeCompletedOrders: true },
    recipients: { resolvers: ['order_manager'] },
    titleTemplate: null,
    messageTemplate: null,
  } as unknown as CreateNotificationRuleInput & { isEnabled: boolean };
}

function createRule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    notificationRuleId: 'rule-1',
    ruleCode: 'notify-order-overdue-manager',
    eventType: 'order.production_status_changed',
    projectId: null,
    isEnabled: true,
    priority: 100,
    level: 'warning',
    conditions: { excludeCompletedOrders: true },
    recipients: { resolvers: ['order_manager'] },
    titleTemplate: null,
    messageTemplate: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function fakeDatabase() {
  const client = {
    query: async () => {
      throw new Error('unexpected query on fake database client');
    },
  } as unknown as TransactionClient;

  return {
    async query() {
      throw new Error('unexpected query on fake database');
    },
    async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
      return handler(client);
    },
  };
}

function fakeAuditService() {
  const recorded: AuditEvent[] = [];
  const denied: DeniedAuditEvent[] = [];

  return {
    recorded,
    denied,
    async record(_client: unknown, event: AuditEvent) {
      recorded.push(event);
      return `audit-${recorded.length}`;
    },
    async recordDenied(_client: unknown, event: DeniedAuditEvent) {
      denied.push(event);
      return `audit-denied-${denied.length}`;
    },
  };
}

function fakeRepository(options: { rules?: NotificationRule[] } = {}): NotificationRuleRepositoryPort & {
  created: CreateNotificationRuleInput[];
  updated: Array<{ ruleId: string; patch: UpdateNotificationRuleInput }>;
  deleted: string[];
} {
  const rules = new Map<string, NotificationRule>();
  for (const rule of options.rules ?? []) {
    rules.set(rule.notificationRuleId, rule);
  }

  const created: CreateNotificationRuleInput[] = [];
  const updated: Array<{ ruleId: string; patch: UpdateNotificationRuleInput }> = [];
  const deleted: string[] = [];
  let counter = rules.size;

  return {
    created,
    updated,
    deleted,
    async create(_client, input) {
      counter += 1;
      const rule: NotificationRule = {
        notificationRuleId: rules.size === 0 ? 'rule-1' : `rule-${counter}`,
        ruleCode: input.ruleCode,
        eventType: input.eventType,
        projectId: input.projectId ?? null,
        isEnabled: input.isEnabled,
        priority: input.priority,
        level: input.level,
        conditions: input.conditions,
        recipients: input.recipients,
        titleTemplate: input.titleTemplate,
        messageTemplate: input.messageTemplate,
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:00:00.000Z',
      };
      created.push(input);
      rules.set(rule.notificationRuleId, rule);
      return rule;
    },
    async update(_client, ruleId, patch) {
      const existing = rules.get(ruleId);
      if (!existing) {
        throw new ApiError(404, 'NOTIFICATION_RULE_NOT_FOUND', 'Notification rule not found');
      }
      const next: NotificationRule = {
        ...existing,
        projectId: patch.projectId !== undefined ? patch.projectId : existing.projectId,
        level: patch.level ?? existing.level,
        priority: patch.priority ?? existing.priority,
        isEnabled: patch.isEnabled ?? existing.isEnabled,
        conditions: patch.conditions ?? existing.conditions,
        recipients: patch.recipients ?? existing.recipients,
        titleTemplate: patch.titleTemplate !== undefined ? patch.titleTemplate : existing.titleTemplate,
        messageTemplate:
          patch.messageTemplate !== undefined ? patch.messageTemplate : existing.messageTemplate,
        updatedAt: '2026-06-02T10:00:00.000Z',
      };
      updated.push({ ruleId, patch });
      rules.set(ruleId, next);
      return next;
    },
    async delete(_client, ruleId) {
      const existing = rules.get(ruleId);
      if (!existing) return null;
      rules.delete(ruleId);
      deleted.push(ruleId);
      return existing;
    },
    async getById(_client, ruleId) {
      return rules.get(ruleId) ?? null;
    },
    async list(_client, _filter) {
      return Array.from(rules.values());
    },
    async listEnabledByEvent(_client, eventType) {
      return Array.from(rules.values()).filter((rule) => rule.eventType === eventType && rule.isEnabled);
    },
  };
}
