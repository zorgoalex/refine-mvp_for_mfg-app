import { describe, expect, it } from 'vitest';
import {
  CHANGE_PRODUCTION_STATUS_ACTION_CONFIG_CONTRACT,
  DEADLINE_AUDIT_EVENTS,
  DEADLINE_AUDIT_SOURCES,
  DEADLINE_ORDER_OVERRIDE_TARGET_TYPES,
  type DeadlineAuditContract,
  type DeadlineOrderOverrideAuditContract,
  isDeadlineAuditEvent,
  isDeadlineOrderOverrideTargetType,
} from './deadline-actions';

describe('deadline action domain contracts', () => {
  it('declares audit events required for rule and order override mutations', () => {
    expect(DEADLINE_AUDIT_EVENTS).toEqual(
      expect.arrayContaining([
        'deadline.timer_rule_created',
        'deadline.timer_rule_updated',
        'deadline.timer_rule_enabled',
        'deadline.timer_rule_disabled',
        'deadline.action_rule_created',
        'deadline.action_rule_updated',
        'deadline.action_rule_enabled',
        'deadline.action_rule_disabled',
        'deadline.order_override_created',
        'deadline.order_override_updated',
        'deadline.order_override_removed',
      ]),
    );
    expect(isDeadlineAuditEvent('deadline.order_override_created')).toBe(true);
    expect(isDeadlineAuditEvent('deadlines.policy.created')).toBe(false);
  });

  it('declares audit sources and evidence-bearing audit contract shape', () => {
    expect(DEADLINE_AUDIT_SOURCES).toEqual(['admin-ui', 'backend-command', 'deadline-engine']);

    const contract = {
      event: 'deadline.action_rule_updated',
      source: 'admin-ui',
      actorUserId: 42,
      requestId: 'req-1',
      timerRuleId: null,
      actionRuleId: 'rule-1',
      orderId: 100,
      before: { priority: 100 },
      after: { priority: 10 },
      diff: { priority: { from: 100, to: 10 } },
      reason: null,
      comment: 'Reprioritized transition rule',
      executionEvidence: {
        deadlineEventId: 'event-1',
        actionRuleVersionId: null,
        ruleConfigSnapshot: { actionRuleId: 'rule-1', priority: 10 },
        snapshotHash: 'sha256:rule-snapshot',
      },
    } satisfies DeadlineAuditContract;

    expect(contract.source).toBe('admin-ui');
    expect(contract.executionEvidence?.snapshotHash).toBe('sha256:rule-snapshot');
  });

  it('declares order override audit contract with order id and reason evidence', () => {
    const contract = {
      event: 'deadline.order_override_created',
      source: 'backend-command',
      actorUserId: '42',
      requestId: 'req-override',
      timerRuleId: null,
      actionRuleId: 'rule-1',
      orderId: 100,
      before: {},
      after: { isDisabled: true },
      diff: { isDisabled: { from: null, to: true } },
      reason: 'Customer escalation',
      comment: null,
      executionEvidence: null,
    } satisfies DeadlineOrderOverrideAuditContract;

    expect(contract.orderId).toBe(100);
    expect(contract.reason).toBe('Customer escalation');
  });

  it('declares policy and action-rule override targets', () => {
    expect(DEADLINE_ORDER_OVERRIDE_TARGET_TYPES).toEqual(['policy', 'action_rule']);
    expect(isDeadlineOrderOverrideTargetType('policy')).toBe(true);
    expect(isDeadlineOrderOverrideTargetType('action_rule')).toBe(true);
    expect(isDeadlineOrderOverrideTargetType('project')).toBe(false);
  });

  it('declares the accepted change_production_status action config contract', () => {
    expect(CHANGE_PRODUCTION_STATUS_ACTION_CONFIG_CONTRACT).toEqual({
      actionType: 'change_production_status',
      supportedEventTypes: ['DEADLINE_EXPIRED'],
      requiredActionConfig: ['targetProductionStatusId', 'productionStatusScope'],
      supportedProductionStatusScopes: ['order'],
      idempotencyMaterial: [
        'deadlineEventId',
        'actionType',
        'actionRuleId',
        'orderId',
        'targetProductionStatusId',
        'snapshotHash',
      ],
    });
  });
});
