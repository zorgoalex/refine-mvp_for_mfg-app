import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { ProductionActionStatusNotFoundError } from '../../production-actions/errors/production-action.errors';
import type {
  OrderAutomationState,
  StatusAutomationEvent,
  StatusAutomationRule,
} from './status-automation.types';

const mocks = vi.hoisted(() => ({
  listEnabledRulesForEvent: vi.fn(),
  loadOrderAutomationState: vi.fn(),
  changeOrderStatusFromAutomationInTransaction: vi.fn(),
  changeProductionStatusFromAutomationInTransaction: vi.fn(),
  changeDetailsProductionStatusFromAutomationInTransaction: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../adapters/pg-status-automation-repository', () => ({
  listEnabledRulesForEvent: mocks.listEnabledRulesForEvent,
  loadOrderAutomationState: mocks.loadOrderAutomationState,
}));

vi.mock('../../production-actions/adapters/pg-production-action-repository', () => ({
  changeOrderStatusFromAutomationInTransaction: mocks.changeOrderStatusFromAutomationInTransaction,
  changeProductionStatusFromAutomationInTransaction: mocks.changeProductionStatusFromAutomationInTransaction,
  changeDetailsProductionStatusFromAutomationInTransaction: mocks.changeDetailsProductionStatusFromAutomationInTransaction,
}));

vi.mock('../../../common/audit/audit.service', () => ({
  auditService: { record: mocks.record },
}));

import {
  evaluateMdfOrderMachineFilesPresentAutomation,
  evaluateStatusAutomation,
} from './status-automation-runtime';

describe('evaluateStatusAutomation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BACKEND_STATUS_AUTOMATION = 'true';
    mocks.record.mockResolvedValue('automation-audit-id');
    mocks.loadOrderAutomationState.mockResolvedValue(makeState());
  });

  it('returns before querying when the feature flag is off', async () => {
    process.env.BACKEND_STATUS_AUTOMATION = 'false';

    await evaluateStatusAutomation(tx(), event());

    expect(mocks.listEnabledRulesForEvent).not.toHaveBeenCalled();
    expect(mocks.loadOrderAutomationState).not.toHaveBeenCalled();
  });

  it('returns for automation-origin events', async () => {
    await evaluateStatusAutomation(tx(), event({ origin: 'automation' }));

    expect(mocks.listEnabledRulesForEvent).not.toHaveBeenCalled();
    expect(mocks.loadOrderAutomationState).not.toHaveBeenCalled();
  });

  it('does not load state when no enabled rules match the event', async () => {
    mocks.listEnabledRulesForEvent.mockResolvedValue([]);

    await evaluateStatusAutomation(tx(), event());

    expect(mocks.listEnabledRulesForEvent).toHaveBeenCalledWith(expect.anything(), 'order.created');
    expect(mocks.loadOrderAutomationState).not.toHaveBeenCalled();
  });

  it.each([
    { sourceIdempotencyKey: 'key', expected: 'key:automation-10:order-100' },
    { sourceIdempotencyKey: undefined, expected: 'req-request-1:automation-10:order-100' },
  ])('calls an applied order rule with the $expected outbox key', async ({ sourceIdempotencyKey, expected }) => {
    const rule = makeRule({ id: 10 });
    mocks.listEnabledRulesForEvent.mockResolvedValue([rule]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockResolvedValue({
      status: 'executed',
      auditId: 'command-audit-id',
    });

    await evaluateStatusAutomation(tx(), event({ sourceIdempotencyKey }));

    expect(mocks.changeOrderStatusFromAutomationInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      100,
      2,
      expect.objectContaining({
        actor: event({ sourceIdempotencyKey }).actor,
        requestId: 'request-1',
        ruleId: 10,
        ruleName: 'Rule 10',
        eventType: 'order.created',
        outboxIdempotencyKey: expected,
      }),
    );
  });

  it('builds distinct outbox keys for the same rule across different orders (payment transfer)', async () => {
    const rule = makeRule({ id: 10 });
    mocks.listEnabledRulesForEvent.mockResolvedValue([rule]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockResolvedValue({
      status: 'executed',
      auditId: 'command-audit-id',
    });

    await evaluateStatusAutomation(tx(), event({ orderId: 100 }));
    await evaluateStatusAutomation(tx(), event({ orderId: 200 }));

    const keys = mocks.changeOrderStatusFromAutomationInTransaction.mock.calls.map(
      (call) => call[3].outboxIdempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('evaluates the MDF machine-files event for each unique order id from a card', async () => {
    const rule = makeRule({ id: 10, eventType: 'mdf.order_machine_files_present' });
    mocks.listEnabledRulesForEvent.mockResolvedValue([rule]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockResolvedValue({
      status: 'executed',
      auditId: 'command-audit-id',
    });

    await evaluateMdfOrderMachineFilesPresentAutomation(tx(), {
      orderIds: [200, null, 100, 100, 0],
      actor: currentUser(),
      requestId: 'request-2',
      sourceIdempotencyKey: 'cnc-card-1',
    });

    expect(mocks.listEnabledRulesForEvent).toHaveBeenCalledTimes(2);
    expect(mocks.listEnabledRulesForEvent).toHaveBeenCalledWith(
      expect.anything(),
      'mdf.order_machine_files_present',
    );
    expect(mocks.changeOrderStatusFromAutomationInTransaction.mock.calls.map((call) => call[1])).toEqual([100, 200]);
    expect(mocks.changeOrderStatusFromAutomationInTransaction.mock.calls.map((call) => call[3].outboxIdempotencyKey)).toEqual([
      'cnc-card-1:order-100:automation-10:order-100',
      'cnc-card-1:order-200:automation-10:order-200',
    ]);
  });

  it('continues after a target-status-not-found error and audits the skip', async () => {
    const first = makeRule({ id: 10 });
    const second = makeRule({ id: 20, actionType: 'change_production_status', targetStatusId: 4 });
    mocks.listEnabledRulesForEvent.mockResolvedValue([first, second]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockRejectedValue(
      new ProductionActionStatusNotFoundError('order_status', first.targetStatusId),
    );
    mocks.changeProductionStatusFromAutomationInTransaction.mockResolvedValue({
      status: 'executed',
      auditId: 'second-command-audit-id',
    });

    await evaluateStatusAutomation(tx(), event());

    expect(mocks.changeProductionStatusFromAutomationInTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'status_automation.rule_skipped',
        entityId: 10,
        relatedOrderId: 100,
        metadata: expect.objectContaining({ reason: 'target_status_missing' }),
      }),
    );
  });

  it('rethrows other action errors and does not call later rules', async () => {
    const first = makeRule({ id: 10 });
    const second = makeRule({ id: 20, actionType: 'change_production_status' });
    const error = new Error('database unavailable');
    mocks.listEnabledRulesForEvent.mockResolvedValue([first, second]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockRejectedValue(error);

    await expect(evaluateStatusAutomation(tx(), event())).rejects.toBe(error);

    expect(mocks.changeProductionStatusFromAutomationInTransaction).not.toHaveBeenCalled();
  });

  it('writes an applied audit with the rule and command audit id', async () => {
    const rule = makeRule({ id: 10 });
    mocks.listEnabledRulesForEvent.mockResolvedValue([rule]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockResolvedValue({
      status: 'executed',
      auditId: 'command-audit-id',
    });

    await evaluateStatusAutomation(tx(), event({ paymentStatusIdBefore: 1, paymentStatusIdAfter: 2 }));

    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'status_automation.rule_applied',
        entityType: 'status_automation_rule',
        entityId: 10,
        actorUserId: '1',
        actorUsername: 'tester',
        actorRole: 'manager',
        requestId: 'request-1',
        source: 'backend-status-automation',
        relatedOrderId: 100,
        metadata: {
          eventType: 'order.created',
          actionType: 'change_order_status',
          targetStatusId: 2,
          ruleName: 'Rule 10',
          statusCommandAuditId: 'command-audit-id',
          paymentStatusIdBefore: 1,
          paymentStatusIdAfter: 2,
          plannedCompletionDateBefore: null,
          plannedCompletionDateAfter: null,
        },
      }),
    );
  });

  it('copies planned-date before/after into applied audit metadata', async () => {
    mocks.listEnabledRulesForEvent.mockResolvedValue([makeRule({ id: 10 })]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockResolvedValue({
      status: 'executed',
      auditId: 'date-command-audit-id',
    });

    await evaluateStatusAutomation(
      tx(),
      event({
        eventType: 'order.planned_completion_date_changed',
        plannedCompletionDateBefore: '2026-08-10',
        plannedCompletionDateAfter: '2026-08-12',
      }),
    );

    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'status_automation.rule_applied',
        metadata: expect.objectContaining({
          plannedCompletionDateBefore: '2026-08-10',
          plannedCompletionDateAfter: '2026-08-12',
        }),
      }),
    );
  });

  it('audits meaningful skips returned by actions and the evaluator', async () => {
    const first = makeRule({ id: 10 });
    const lowerPriority = makeRule({ id: 20, priority: 20 });
    mocks.listEnabledRulesForEvent.mockResolvedValue([first, lowerPriority]);
    mocks.changeOrderStatusFromAutomationInTransaction.mockResolvedValue({
      status: 'skipped',
      skipReason: 'same_status',
    });

    await evaluateStatusAutomation(tx(), event());

    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'status_automation.rule_skipped',
        entityId: 10,
        metadata: expect.objectContaining({ reason: 'same_status' }),
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'status_automation.rule_skipped',
        entityId: 20,
        metadata: expect.objectContaining({ reason: 'lower_priority_same_target' }),
      }),
    );
  });

  it('does not audit condition mismatches', async () => {
    mocks.listEnabledRulesForEvent.mockResolvedValue([
      makeRule({ conditions: { currentOrderStatusIn: [999] } }),
    ]);

    await evaluateStatusAutomation(tx(), event());

    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.changeOrderStatusFromAutomationInTransaction).not.toHaveBeenCalled();
  });
});

function tx(): TransactionClient {
  return { query: vi.fn(), raw: {} } as unknown as TransactionClient;
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'tester',
    role: 'manager',
    roleId: 10,
    permissions: [],
  };
}

function event(overrides: Partial<StatusAutomationEvent> = {}): StatusAutomationEvent {
  return {
    eventType: 'order.created',
    origin: 'user',
    orderId: 100,
    actor: currentUser(),
    requestId: 'request-1',
    ...overrides,
  };
}

function makeRule(overrides: Partial<StatusAutomationRule> = {}): StatusAutomationRule {
  return {
    id: 1,
    name: 'Rule 1',
    eventType: 'order.created',
    actionType: 'change_order_status',
    targetStatusId: 2,
    conditions: {},
    priority: 10,
    isEnabled: true,
    version: 1,
    ...overrides,
    name: overrides.name ?? `Rule ${overrides.id ?? 1}`,
  };
}

function makeState(): OrderAutomationState {
  return {
    orderId: 100,
    orderStatusId: 1,
    paymentStatusId: 1,
    productionStatusId: 3,
    productionStatusFromDetailsEnabled: false,
    finalAmount: 100,
    paidAmount: 0,
    source: 'manual',
    version: 1,
    clientId: 5,
  };
}
