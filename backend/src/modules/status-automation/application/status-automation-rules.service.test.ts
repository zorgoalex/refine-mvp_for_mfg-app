import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type {
  CreateStatusAutomationRuleDto,
  PgStatusAutomationRepository,
  UpdateStatusAutomationRuleDto,
} from '../adapters/pg-status-automation-repository';
import type { CurrentUser } from '../../../permissions/current-user';
import type { StatusAutomationRule } from './status-automation.types';
import { StatusAutomationRulesService } from './status-automation-rules.service';

describe('StatusAutomationRulesService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('denies list without view permission and records a view denied audit', async () => {
    const { service, repository } = buildService();
    const denied = mockDeniedAudit();

    await expect(service.list(user([]), 'req-list-denied')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);

    expect(repository.listCalls).toBe(0);
    expectDeniedAudit(denied, {
      event: 'status_automation.rule_view_denied',
      entityId: 0,
      requestId: 'req-list-denied',
      attemptedAction: 'list',
      permission: 'status_automation.view',
    });
  });

  it('denies event catalog access and records a view denied audit', async () => {
    const { service } = buildService();
    const denied = mockDeniedAudit();

    await expect(service.listEventTypes(user([]), 'req-event-types-denied')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);

    expectDeniedAudit(denied, {
      event: 'status_automation.rule_view_denied',
      entityId: 0,
      requestId: 'req-event-types-denied',
      attemptedAction: 'listEventTypes',
      permission: 'status_automation.view',
    });
  });

  it('denies each mutation without manage permission and records denied audit', async () => {
    const cases = [
      {
        action: 'create',
        call: (service: StatusAutomationRulesService) => service.create(user([]), 'req-create-denied', createDto()),
        attemptedAction: 'create',
        entityId: 0,
      },
      {
        action: 'update',
        call: (service: StatusAutomationRulesService) => service.update(user([]), 'req-update-denied', 12, updateDto()),
        attemptedAction: 'update',
        entityId: 12,
      },
      {
        action: 'delete',
        call: (service: StatusAutomationRulesService) => service.delete(user([]), 'req-delete-denied', 12),
        attemptedAction: 'delete',
        entityId: 12,
      },
    ] as const;

    for (const testCase of cases) {
      const { service, repository } = buildService();
      const denied = mockDeniedAudit();

      await expect(testCase.call(service)).rejects.toMatchObject({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
      } satisfies Partial<ApiError>);

      expect(repository.mutationCalls).toBe(0);
      expectDeniedAudit(denied, {
        event: 'status_automation.rule_change_denied',
        entityId: testCase.entityId,
        requestId: `req-${testCase.action}-denied`,
        attemptedAction: testCase.attemptedAction,
        permission: 'status_automation.manage',
      });
    }
  });

  it('does not mask the 403 when denied-audit fails', async () => {
    const { service } = buildService();
    vi.spyOn(auditService, 'recordDenied').mockRejectedValue(new Error('audit unavailable'));

    await expect(service.delete(user([]), 'req-audit-failure', 12)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });

  it('delegates permitted list/create/update/delete with the original arguments', async () => {
    const rule = sampleRule();
    const { service, repository } = buildService({ rule });
    const currentUser = user(['status_automation.view', 'status_automation.manage']);
    const create = createDto();
    const update = updateDto();

    await expect(service.list(currentUser, 'req-list')).resolves.toEqual([rule]);
    await expect(service.create(currentUser, 'req-create', create)).resolves.toEqual(rule);
    await expect(service.update(currentUser, 'req-update', 12, update)).resolves.toEqual(rule);
    await expect(service.delete(currentUser, 'req-delete', 12)).resolves.toEqual({ deleted: true });

    expect(repository.listCalls).toBe(1);
    expect(repository.created).toEqual([{ currentUser, requestId: 'req-create', dto: create }]);
    expect(repository.updated).toEqual([{ currentUser, requestId: 'req-update', ruleId: 12, dto: update }]);
    expect(repository.deleted).toEqual([{ currentUser, requestId: 'req-delete', ruleId: 12 }]);
  });

  it('maps the event catalog for permitted users', async () => {
    const { service } = buildService();
    const catalog = await service.listEventTypes(user(['status_automation.view']), 'req-event-types');

    expect(catalog).toHaveLength(7);
    expect(catalog).toContainEqual({
      eventType: 'payment.created',
      title: 'Платёж создан',
      group: 'payments',
      description: 'После добавления нового платежа к заказу.',
      allowedConditions: expect.arrayContaining(['firstPaymentOnly', 'paidShareGte']),
      allowedActions: expect.arrayContaining(['change_order_status', 'change_production_status']),
    });
    expect(catalog).toContainEqual(
      expect.objectContaining({
        eventType: 'order.planned_completion_date_changed',
        group: 'dates',
      }),
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid ruleId %s with 422', async (ruleId) => {
    const { service, repository } = buildService();

    await expect(service.delete(user(['status_automation.manage']), 'req-invalid-id', ruleId)).rejects.toMatchObject({
      statusCode: 422,
    } satisfies Partial<ApiError>);
    expect(repository.mutationCalls).toBe(0);
  });
});

type CreateCommand = Parameters<PgStatusAutomationRepository['createRule']>[0];
type UpdateCommand = Parameters<PgStatusAutomationRepository['updateRule']>[0];
type DeleteCommand = Parameters<PgStatusAutomationRepository['deleteRule']>[0];

interface FakeRepository {
  repository: PgStatusAutomationRepository;
  listCalls: number;
  mutationCalls: number;
  created: CreateCommand[];
  updated: UpdateCommand[];
  deleted: DeleteCommand[];
}

function buildService(options: { rule?: StatusAutomationRule } = {}): {
  service: StatusAutomationRulesService;
  repository: FakeRepository;
} {
  const rule = options.rule ?? sampleRule();
  const fake: FakeRepository = {
    repository: undefined as unknown as PgStatusAutomationRepository,
    listCalls: 0,
    mutationCalls: 0,
    created: [],
    updated: [],
    deleted: [],
  };
  fake.repository = {
    listRules: async () => {
      fake.listCalls += 1;
      return [rule];
    },
    createRule: async (command: CreateCommand) => {
      fake.mutationCalls += 1;
      fake.created.push(command);
      return rule;
    },
    updateRule: async (command: UpdateCommand) => {
      fake.mutationCalls += 1;
      fake.updated.push(command);
      return rule;
    },
    deleteRule: async (command: DeleteCommand) => {
      fake.mutationCalls += 1;
      fake.deleted.push(command);
      return { deleted: true };
    },
  } as unknown as PgStatusAutomationRepository;

  return {
    service: new StatusAutomationRulesService({
      repository: fake.repository,
      database: {} as DatabaseService,
    }),
    repository: fake,
  };
}

function mockDeniedAudit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(auditService, 'recordDenied').mockResolvedValue('audit-denied');
}

function expectDeniedAudit(
  denied: ReturnType<typeof vi.spyOn>,
  expected: {
    event: string;
    entityId: number;
    requestId: string;
    attemptedAction: string;
    permission: string;
  },
): void {
  expect(denied).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      event: expected.event,
      entityType: 'status_automation_rule',
      entityId: expected.entityId,
      actorUserId: '1',
      requestId: expected.requestId,
      source: 'backend-status-automation',
      requiredPermissions: [expected.permission],
      metadata: { attemptedAction: expected.attemptedAction },
    }),
  );
}

function user(permissions: CurrentUser['permissions'] = []): CurrentUser {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions,
  };
}

function createDto(): CreateStatusAutomationRuleDto {
  return {
    name: 'Rule',
    eventType: 'payment.created',
    actionType: 'change_order_status',
    targetStatusId: 7,
    conditions: {},
    priority: 10,
    isEnabled: false,
  };
}

function updateDto(): UpdateStatusAutomationRuleDto {
  return { name: 'Updated', version: 2 };
}

function sampleRule(): StatusAutomationRule {
  return { ...createDto(), id: 12, version: 2 };
}
