import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../../permissions/require-permissions.decorator';
import type { StatusAutomationEventTypeDto } from '../dto/status-automation.dto';
import type { StatusAutomationRule } from '../application/status-automation.types';
import { StatusAutomationController } from './status-automation.controller';

describe('StatusAutomationController', () => {
  it('uses an unversioned root path so global API_PREFIX publishes status automation APIs', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StatusAutomationController)).toBe('');
  });

  it('declares create as HTTP 201', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, StatusAutomationController.prototype.create)).toBe(201);
  });

  describe('authentication', () => {
    it('requires a current user before delegating to the service', async () => {
      const controller = createController();

      await expect(controller.list({ requestId: 'req-1' })).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
      await expect(controller.create({ requestId: 'req-1' }, validCreateBody())).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
      await expect(controller.update({ requestId: 'req-1' }, '1', { version: 1, name: 'Updated' })).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
      await expect(controller.delete({ requestId: 'req-1' }, '1')).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
      await expect(controller.listEventTypes({ requestId: 'req-1' })).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
    });
  });

  describe('delegation', () => {
    it('delegates list with current user and request id', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        service: {
          async list(user, requestId) {
            calls.push({ method: 'list', userId: user.id, requestId });
            return [rule()];
          },
        },
      });

      await expect(controller.list(request())).resolves.toEqual([rule()]);
      expect(calls).toEqual([{ method: 'list', userId: 'admin-id', requestId: 'req-list' }]);
    });

    it('propagates a service 403 without changing it', async () => {
      const denied = new ApiError(403, 'PERMISSION_DENIED', 'Insufficient permissions');
      const controller = createController({
        service: {
          async list() {
            throw denied;
          },
        },
      });

      await expect(controller.list(request())).rejects.toBe(denied);
    });

    it('delegates create with parsed body, current user, and request id', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        service: {
          async create(user, requestId, input) {
            calls.push({ method: 'create', userId: user.id, requestId, input });
            return rule({ name: input.name });
          },
        },
      });

      await expect(controller.create({ ...request(), requestId: 'req-create' }, validCreateBody())).resolves.toEqual(
        rule({ name: 'New rule' }),
      );
      expect(calls).toEqual([
        {
          method: 'create',
          userId: 'admin-id',
          requestId: 'req-create',
          input: {
            name: 'New rule',
            eventType: 'order.created',
            actionType: 'change_order_status',
            targetStatusId: 4,
            conditions: { currentOrderStatusIn: [1, 2] },
            priority: 100,
            isEnabled: false,
          },
        },
      ]);
    });

    it('delegates update with an integer rule id and parsed patch', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        service: {
          async update(user, requestId, ruleId, input) {
            calls.push({ method: 'update', userId: user.id, requestId, ruleId, input });
            return rule({ id: ruleId, name: input.name ?? 'Updated rule', version: input.version + 1 });
          },
        },
      });

      await expect(
        controller.update({ ...request(), requestId: 'req-update' }, '7', {
          name: '  Updated rule  ',
          version: 3,
          isEnabled: true,
        }),
      ).resolves.toEqual(rule({ id: 7, name: 'Updated rule', version: 4 }));
      expect(calls).toEqual([
        {
          method: 'update',
          userId: 'admin-id',
          requestId: 'req-update',
          ruleId: 7,
          input: { name: 'Updated rule', version: 3, isEnabled: true },
        },
      ]);
    });

    it('delegates delete with an integer rule id', async () => {
      const calls: unknown[] = [];
      const controller = createController({
        service: {
          async delete(user, requestId, ruleId) {
            calls.push({ method: 'delete', userId: user.id, requestId, ruleId });
            return { deleted: true };
          },
        },
      });

      await expect(controller.delete({ ...request(), requestId: 'req-delete' }, '9')).resolves.toEqual({ deleted: true });
      expect(calls).toEqual([{ method: 'delete', userId: 'admin-id', requestId: 'req-delete', ruleId: 9 }]);
    });

    it('delegates event types with current user and request id', async () => {
      const calls: unknown[] = [];
      const eventTypes: StatusAutomationEventTypeDto[] = [];
      const controller = createController({
        service: {
          async listEventTypes(user, requestId) {
            calls.push({ method: 'listEventTypes', userId: user.id, requestId });
            return eventTypes;
          },
        },
      });

      await expect(controller.listEventTypes(request())).resolves.toBe(eventTypes);
      expect(calls).toEqual([{ method: 'listEventTypes', userId: 'admin-id', requestId: 'req-list' }]);
    });
  });

  describe('path validation', () => {
    it('rejects a non-positive or malformed rule id with 422', async () => {
      const controller = createController();

      for (const ruleId of ['0', 'not-an-integer', '1.5']) {
        await expect(controller.update(request(), ruleId, { version: 1, name: 'Updated' })).rejects.toMatchObject({
          statusCode: 422,
          code: 'VALIDATION_ERROR',
        } satisfies Partial<ApiError>);
        await expect(controller.delete(request(), ruleId)).rejects.toMatchObject({
          statusCode: 422,
          code: 'VALIDATION_ERROR',
        } satisfies Partial<ApiError>);
      }
    });
  });

  describe('@RequirePermissions metadata', () => {
    it('requires view permission on read handlers', () => {
      for (const handler of [StatusAutomationController.prototype.list, StatusAutomationController.prototype.listEventTypes]) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_METADATA_KEY, handler)).toEqual(['status_automation.view']);
      }
    });

    it('requires manage permission on write handlers', () => {
      for (const handler of [
        StatusAutomationController.prototype.create,
        StatusAutomationController.prototype.update,
        StatusAutomationController.prototype.delete,
      ]) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_METADATA_KEY, handler)).toEqual(['status_automation.manage']);
      }
    });
  });
});

interface FakeStatusAutomationService {
  list?(user: CurrentUser, requestId: string): Promise<StatusAutomationRule[]>;
  create?(user: CurrentUser, requestId: string, input: CreateInput): Promise<StatusAutomationRule>;
  update?(user: CurrentUser, requestId: string, ruleId: number, input: UpdateInput): Promise<StatusAutomationRule>;
  delete?(user: CurrentUser, requestId: string, ruleId: number): Promise<{ deleted: true }>;
  listEventTypes?(user: CurrentUser, requestId: string): Promise<StatusAutomationEventTypeDto[]>;
}

type CreateInput = {
  name: string;
  eventType: string;
  actionType: string;
  targetStatusId: number;
  conditions: Record<string, unknown>;
  priority: number;
  isEnabled: boolean;
};

type UpdateInput = {
  name?: string;
  version: number;
  isEnabled?: boolean;
};

function createController(overrides: { service?: FakeStatusAutomationService } = {}) {
  const service: FakeStatusAutomationService = {
    async list() {
      return [];
    },
    async create(_user, _requestId, input) {
      return rule({ name: input.name });
    },
    async update(_user, _requestId, ruleId, input) {
      return rule({ id: ruleId, name: input.name ?? 'Updated rule', version: input.version + 1 });
    },
    async delete() {
      return { deleted: true };
    },
    async listEventTypes() {
      return [];
    },
    ...overrides.service,
  };

  return new StatusAutomationController(service as never);
}

function request(overrides: Partial<{ requestId: string }> = {}) {
  return {
    user: currentUser(),
    requestId: 'req-list',
    ...overrides,
  };
}

function currentUser(): CurrentUser {
  return {
    id: 'admin-id',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: ['status_automation.view', 'status_automation.manage'],
  };
}

function rule(overrides: Partial<StatusAutomationRule> = {}): StatusAutomationRule {
  return {
    id: 1,
    name: 'New rule',
    eventType: 'order.created',
    actionType: 'change_order_status',
    targetStatusId: 4,
    conditions: { currentOrderStatusIn: [1, 2] },
    priority: 100,
    isEnabled: false,
    version: 1,
    ...overrides,
  };
}

function validCreateBody(): Record<string, unknown> {
  return {
    name: '  New rule  ',
    eventType: 'order.created',
    actionType: 'change_order_status',
    targetStatusId: 4,
    conditions: { currentOrderStatusIn: [1, 2] },
  };
}
