import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../../permissions/require-permissions.decorator';
import type { NotificationRule } from '../domain/notification-rule.types';
import { listConfigurableEventTypes } from '../domain/notification-event-registry';
import {
  NotificationRulesController,
} from './notification-rules.controller';
import type { NotificationsFeatureFlags } from './notifications-runtime-config.service';

describe('NotificationRulesController', () => {
  it('uses an unversioned root path so global API_PREFIX publishes notification rule APIs', () => {
    expect(Reflect.getMetadata(PATH_METADATA, NotificationRulesController)).toBe('');
  });

  describe('feature gates', () => {
    it('rejects reads with 503 NOTIFICATION_ENGINE_DISABLED when the engine is disabled', async () => {
      const controller = createController({ flags: flags({ engineEnabled: false }) });

      await expect(controller.list({ user: currentUser() }, {})).rejects.toMatchObject({
        statusCode: 503,
        code: 'NOTIFICATION_ENGINE_DISABLED',
      } satisfies Partial<ApiError>);
      await expect(
        controller.getById({ user: currentUser() }, 'rule-1'),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_ENGINE_DISABLED' });
      await expect(
        controller.listEventTypes({ user: currentUser() }),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_ENGINE_DISABLED' });
    });

    it('rejects writes with 503 NOTIFICATION_ENGINE_DISABLED when the engine is disabled', async () => {
      const controller = createController({ flags: flags({ engineEnabled: false }) });

      await expect(
        controller.create({ user: currentUser(), requestId: 'req-1' }, validCreateBody()),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_ENGINE_DISABLED' });
      await expect(
        controller.update({ user: currentUser(), requestId: 'req-1' }, 'rule-1', { priority: 50 }),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_ENGINE_DISABLED' });
      await expect(
        controller.delete({ user: currentUser(), requestId: 'req-1' }, 'rule-1'),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_ENGINE_DISABLED' });
    });

    it('allows reads but rejects writes with 503 NOTIFICATION_RULES_READ_ONLY in read-only mode', async () => {
      const calls: string[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true, rulesReadOnly: true }),
        service: {
          async list() {
            calls.push('list');
            return [];
          },
        },
      });

      await expect(controller.list({ user: currentUser() }, {})).resolves.toEqual([]);
      expect(calls).toEqual(['list']);

      await expect(
        controller.create({ user: currentUser(), requestId: 'req-1' }, validCreateBody()),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'NOTIFICATION_RULES_READ_ONLY',
      } satisfies Partial<ApiError>);
      await expect(
        controller.update({ user: currentUser(), requestId: 'req-1' }, 'rule-1', { priority: 50 }),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_RULES_READ_ONLY' });
      await expect(
        controller.delete({ user: currentUser(), requestId: 'req-1' }, 'rule-1'),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_RULES_READ_ONLY' });
    });

    it('reports NOTIFICATION_ENGINE_DISABLED before NOTIFICATION_RULES_READ_ONLY when both apply', async () => {
      const controller = createController({
        flags: flags({ engineEnabled: false, rulesReadOnly: true }),
      });

      await expect(
        controller.create({ user: currentUser(), requestId: 'req-1' }, validCreateBody()),
      ).rejects.toMatchObject({ statusCode: 503, code: 'NOTIFICATION_ENGINE_DISABLED' });
    });
  });

  describe('authentication', () => {
    it('requires a current user before delegating to the service', async () => {
      const controller = createController({ flags: flags({ engineEnabled: true }) });

      await expect(controller.list({}, {})).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
      await expect(controller.getById({}, 'rule-1')).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      });
      await expect(controller.create({ requestId: 'req-1' }, validCreateBody())).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      });
      await expect(
        controller.update({ requestId: 'req-1' }, 'rule-1', { priority: 50 }),
      ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
      await expect(controller.delete({ requestId: 'req-1' }, 'rule-1')).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      });
      await expect(controller.listEventTypes({})).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      });
    });
  });

  describe('delegation', () => {
    it('delegates list with parsed query filters', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true }),
        service: {
          async list(user, filter) {
            calls.push({ method: 'list', userId: user.id, filter });
            return [notificationRule()];
          },
        },
      });

      await expect(
        controller.list({
          user: currentUser(),
        }, {
          eventType: 'order.status_changed',
          isEnabled: 'true',
          groupId: '11111111-1111-4111-8111-111111111111',
        }),
      ).resolves.toEqual([notificationRule()]);

      expect(calls).toEqual([
        {
          method: 'list',
          userId: 'admin-id',
          filter: {
            eventType: 'order.status_changed',
            isEnabled: true,
            groupId: '11111111-1111-4111-8111-111111111111',
          },
        },
      ]);
    });

    it('delegates list with global group scope filter', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true }),
        service: {
          async list(user, filter) {
            calls.push({ userId: user.id, filter });
            return [];
          },
        },
      });

      await controller.list({ user: currentUser() }, { groupId: 'global' });

      expect(calls).toEqual([{ userId: 'admin-id', filter: { groupId: 'global' } }]);
    });

    it('rejects malformed list groupId with 422', async () => {
      const controller = createController({ flags: flags({ engineEnabled: true }) });

      await expect(
        controller.list({ user: currentUser() }, { groupId: 'not-a-uuid' }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
      } satisfies Partial<ApiError>);
    });

    it('delegates list with no filters when query params are absent', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true }),
        service: {
          async list(user, filter) {
            calls.push({ userId: user.id, filter });
            return [];
          },
        },
      });

      await controller.list({ user: currentUser() }, {});

      expect(calls).toEqual([{ userId: 'admin-id', filter: {} }]);
    });

    it('delegates getById with the path rule id', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true }),
        service: {
          async getById(user, ruleId) {
            calls.push({ userId: user.id, ruleId });
            return notificationRule({ notificationRuleId: ruleId });
          },
        },
      });

      await expect(controller.getById({ user: currentUser() }, 'rule-42')).resolves.toEqual(
        notificationRule({ notificationRuleId: 'rule-42' }),
      );
      expect(calls).toEqual([{ userId: 'admin-id', ruleId: 'rule-42' }]);
    });

    it('delegates create with the parsed request body, current user, and request id', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true, rulesReadOnly: false }),
        service: {
          async create(user, requestId, input) {
            calls.push({ userId: user.id, requestId, input });
            return notificationRule({ ruleCode: input.ruleCode, eventType: input.eventType });
          },
        },
      });

      await expect(
        controller.create({ user: currentUser(), requestId: 'req-create-1' }, validCreateBody()),
      ).resolves.toEqual(
        notificationRule({ ruleCode: 'notify-order-overdue', eventType: 'order.status_changed' }),
      );

      expect(calls).toEqual([
        {
          userId: 'admin-id',
          requestId: 'req-create-1',
          input: {
            ruleCode: 'notify-order-overdue',
            eventType: 'order.status_changed',
            groupId: '11111111-1111-4111-8111-111111111111',
            level: 'warning',
            priority: 50,
            isEnabled: true,
            conditions: {},
            recipients: { roleCodes: ['manager'] },
          },
        },
      ]);
    });

    it('rejects create with 422 when the request body fails structural validation', async () => {
      const controller = createController({ flags: flags({ engineEnabled: true }) });

      await expect(
        controller.create({ user: currentUser(), requestId: 'req-1' }, { ruleCode: '' }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'INVALID_NOTIFICATION_RULE_PAYLOAD',
      } satisfies Partial<ApiError>);
    });

    it('delegates update with the parsed patch, rule id, current user, and request id', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true, rulesReadOnly: false }),
        service: {
          async update(user, requestId, ruleId, command) {
            calls.push({ userId: user.id, requestId, ruleId, command });
            return notificationRule({ notificationRuleId: ruleId, priority: command.patch.priority ?? 100 });
          },
        },
      });

      await expect(
        controller.update(
          { user: currentUser(), requestId: 'req-update-1' },
          'rule-7',
          {
            priority: 25,
            isEnabled: false,
            groupId: null,
            reason: 'Lower urgency',
            expectedUpdatedAt: '2026-06-14T10:00:00.123Z',
          },
        ),
      ).resolves.toEqual(notificationRule({ notificationRuleId: 'rule-7', priority: 25 }));

      expect(calls).toEqual([
        {
          userId: 'admin-id',
          requestId: 'req-update-1',
          ruleId: 'rule-7',
          command: {
            patch: { priority: 25, isEnabled: false, groupId: null },
            reason: 'Lower urgency',
            expectedUpdatedAt: '2026-06-14T10:00:00.123Z',
          },
        },
      ]);
    });

    it('keeps missing expectedUpdatedAt as an explicit compatibility update path', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true, rulesReadOnly: false }),
        service: {
          async update(user, requestId, ruleId, command) {
            calls.push({ userId: user.id, requestId, ruleId, command });
            return notificationRule({ notificationRuleId: ruleId, priority: 25 });
          },
        },
      });

      await expect(
        controller.update(
          { user: currentUser(), requestId: 'req-update-compat' },
          'rule-7',
          { priority: 25, reason: 'Legacy client compatibility' },
        ),
      ).resolves.toEqual(notificationRule({ notificationRuleId: 'rule-7', priority: 25 }));

      expect(calls).toEqual([
        {
          userId: 'admin-id',
          requestId: 'req-update-compat',
          ruleId: 'rule-7',
          command: {
            patch: { priority: 25 },
            reason: 'Legacy client compatibility',
          },
        },
      ]);
    });

    it('rejects update with 422 when the request body fails structural validation', async () => {
      const controller = createController({ flags: flags({ engineEnabled: true }) });

      await expect(
        controller.update({ user: currentUser(), requestId: 'req-1' }, 'rule-1', {}),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'INVALID_NOTIFICATION_RULE_PAYLOAD',
      } satisfies Partial<ApiError>);
    });

    it('delegates delete with the path rule id, current user, and request id', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        flags: flags({ engineEnabled: true, rulesReadOnly: false }),
        service: {
          async delete(user, requestId, ruleId) {
            calls.push({ userId: user.id, requestId, ruleId });
            return notificationRule({ notificationRuleId: ruleId });
          },
        },
      });

      await expect(
        controller.delete({ user: currentUser(), requestId: 'req-delete-1' }, 'rule-9'),
      ).resolves.toEqual(notificationRule({ notificationRuleId: 'rule-9' }));
      expect(calls).toEqual([{ userId: 'admin-id', requestId: 'req-delete-1', ruleId: 'rule-9' }]);
    });

    it('returns the configurable event type registry for the event types endpoint', async () => {
      const controller = createController({ flags: flags({ engineEnabled: true }) });

      await expect(controller.listEventTypes({ user: currentUser() })).resolves.toEqual(
        listConfigurableEventTypes(),
      );
    });
  });

  describe('@RequirePermissions metadata', () => {
    it('requires notifications.view_rules on read handlers', () => {
      for (const handler of [
        NotificationRulesController.prototype.list,
        NotificationRulesController.prototype.getById,
        NotificationRulesController.prototype.listEventTypes,
      ]) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_METADATA_KEY, handler)).toEqual([
          'notifications.view_rules',
        ]);
      }
    });

    it('requires notifications.manage_rules on write handlers', () => {
      for (const handler of [
        NotificationRulesController.prototype.create,
        NotificationRulesController.prototype.update,
        NotificationRulesController.prototype.delete,
      ]) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_METADATA_KEY, handler)).toEqual([
          'notifications.manage_rules',
        ]);
      }
    });
  });
});

interface FakeNotificationRulesService {
  list?(
    user: CurrentUser,
    filter: { eventType?: string; isEnabled?: boolean; groupId?: string | 'global' },
  ): Promise<NotificationRule[]>;
  getById?(user: CurrentUser, ruleId: string): Promise<NotificationRule>;
  create?(user: CurrentUser, requestId: string, input: unknown): Promise<NotificationRule>;
  update?(user: CurrentUser, requestId: string, ruleId: string, command: unknown): Promise<NotificationRule>;
  delete?(user: CurrentUser, requestId: string, ruleId: string): Promise<NotificationRule>;
}

function createController(overrides: {
  flags?: NotificationsFeatureFlags;
  service?: FakeNotificationRulesService;
} = {}) {
  const service: FakeNotificationRulesService = {
    async list() {
      return [];
    },
    async getById(_user, ruleId) {
      return notificationRule({ notificationRuleId: ruleId });
    },
    async create(_user, _requestId, input) {
      const parsed = input as { ruleCode: string; eventType: string };
      return notificationRule({ ruleCode: parsed.ruleCode, eventType: parsed.eventType });
    },
    async update(_user, _requestId, ruleId) {
      return notificationRule({ notificationRuleId: ruleId });
    },
    async delete(_user, _requestId, ruleId) {
      return notificationRule({ notificationRuleId: ruleId });
    },
    ...overrides.service,
  };

  return new NotificationRulesController(service as never, {
    isEngineEnabled: () => (overrides.flags ?? flags()).engineEnabled,
    isRulesReadOnly: () => (overrides.flags ?? flags()).rulesReadOnly,
  } as never);
}

function flags(overrides: Partial<NotificationsFeatureFlags> = {}): NotificationsFeatureFlags {
  return {
    engineEnabled: true,
    rulesReadOnly: false,
    ...overrides,
  };
}

function currentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'admin-id',
    username: 'admin',
    role: 'superadmin',
    roleId: 1,
    permissions: ['notifications.view_rules', 'notifications.manage_rules'],
    ...overrides,
  };
}

function notificationRule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    notificationRuleId: 'rule-1',
    ruleCode: 'notify-order-overdue',
    eventType: 'order.status_changed',
    groupId: null,
    isEnabled: true,
    priority: 100,
    level: 'info',
    conditions: {},
    recipients: {},
    titleTemplate: null,
    messageTemplate: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function validCreateBody(): Record<string, unknown> {
  return {
    ruleCode: 'notify-order-overdue',
    eventType: 'order.status_changed',
    level: 'warning',
    priority: 50,
    isEnabled: true,
    groupId: '11111111-1111-4111-8111-111111111111',
    conditions: {},
    recipients: { roleCodes: ['manager'] },
  };
}
