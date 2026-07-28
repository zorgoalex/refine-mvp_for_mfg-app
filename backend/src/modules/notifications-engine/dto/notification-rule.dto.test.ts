import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  parseCreateNotificationRuleRequest,
  parseUpdateNotificationRuleRequest,
} from './notification-rule.dto';

function expectInvalidPayloadError(fn: () => unknown): void {
  try {
    fn();
    throw new Error('Expected ApiError to be thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(422);
    expect(apiError.code).toBe('INVALID_NOTIFICATION_RULE_PAYLOAD');
  }
}

describe('parseCreateNotificationRuleRequest', () => {
  it('returns a typed object with defaults applied for a minimal valid payload', () => {
    const result = parseCreateNotificationRuleRequest({
      ruleCode: 'notify-order-overdue-manager',
      eventType: 'order.production_status_changed',
    });

    expect(result).toEqual({
      ruleCode: 'notify-order-overdue-manager',
      eventType: 'order.production_status_changed',
      level: 'info',
      priority: 100,
      isEnabled: true,
      channels: ['in_app'],
      conditions: {},
      recipients: {},
    });
  });

  it('returns a typed object preserving all explicitly provided fields', () => {
    const result = parseCreateNotificationRuleRequest({
      ruleCode: 'notify-order-overdue-manager',
      eventType: 'order.production_status_changed',
      level: 'warning',
      priority: 50,
      isEnabled: false,
      channels: ['in_app', 'telegram'],
      conditions: {
        allowedFromOrderStatusIds: [1, 2],
        excludeOrderStatusIds: [7],
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: false,
      },
      recipients: {
        resolvers: ['order_manager'],
        roleCodes: ['admin'],
        userIds: [10, 20],
      },
      titleTemplate: 'Order overdue',
      messageTemplate: 'Order {{orderId}} is overdue',
    });

    expect(result).toEqual({
      ruleCode: 'notify-order-overdue-manager',
      eventType: 'order.production_status_changed',
      level: 'warning',
      priority: 50,
      isEnabled: false,
      channels: ['in_app', 'telegram'],
      conditions: {
        allowedFromOrderStatusIds: [1, 2],
        excludeOrderStatusIds: [7],
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: false,
      },
      recipients: {
        resolvers: ['order_manager'],
        roleCodes: ['admin'],
        userIds: [10, 20],
      },
      titleTemplate: 'Order overdue',
      messageTemplate: 'Order {{orderId}} is overdue',
    });
  });

  it('parses groupId on create', () => {
    const result = parseCreateNotificationRuleRequest({
      ruleCode: 'group-deadline-overdue',
      eventType: 'DEADLINE_EXPIRED',
      level: 'warning',
      priority: 10,
      isEnabled: true,
      groupId: '11111111-1111-4111-8111-111111111111',
      recipients: { resolvers: ['group_participants'] },
    });

    expect(result.groupId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('preserves deadlineEntityTypes in conditions on create', () => {
    const result = parseCreateNotificationRuleRequest({
      ruleCode: 'deadline-expired-order',
      eventType: 'DEADLINE_EXPIRED',
      conditions: { deadlineEntityTypes: ['order'] },
      recipients: { resolvers: ['order_manager'] },
    });

    expect(result.conditions).toEqual({ deadlineEntityTypes: ['order'] });
  });

  it('preserves requireCurrentDeadlineEvent in conditions on create', () => {
    const result = parseCreateNotificationRuleRequest({
      ruleCode: 'deadline-expired-current-only',
      eventType: 'DEADLINE_EXPIRED',
      conditions: { requireCurrentDeadlineEvent: true },
      recipients: { resolvers: ['order_manager'] },
    });

    expect(result.conditions).toEqual({ requireCurrentDeadlineEvent: true });
  });

  it('rejects unsupported deadlineEntityTypes values on create', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'deadline-expired-client',
        eventType: 'DEADLINE_EXPIRED',
        conditions: { deadlineEntityTypes: ['client'] },
        recipients: { resolvers: ['order_manager'] },
      }),
    );
  });

  it('rejects empty deadlineEntityTypes on create', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'deadline-expired-empty',
        eventType: 'DEADLINE_EXPIRED',
        conditions: { deadlineEntityTypes: [] },
        recipients: { resolvers: ['order_manager'] },
      }),
    );
  });

  it('rejects a missing ruleCode', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        eventType: 'order.production_status_changed',
      }),
    );
  });

  it('rejects an empty ruleCode', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: '   ',
        eventType: 'order.production_status_changed',
      }),
    );
  });

  it('rejects a missing eventType', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
      }),
    );
  });

  it('rejects an unsupported level value', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        level: 'critical',
      }),
    );
  });

  it('rejects a non-integer priority', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        priority: 50.5,
      }),
    );
  });

  it('rejects a non-boolean isEnabled', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        isEnabled: 'yes',
      }),
    );
  });

  it('rejects empty or unsupported notification channels', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'empty-channels',
        eventType: 'order.status_changed',
        channels: [],
      }),
    );
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'unknown-channel',
        eventType: 'order.status_changed',
        channels: ['email'],
      }),
    );
  });

  it('rejects conditions that is not an object', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        conditions: 'not-an-object',
      }),
    );
  });

  it('rejects non-array allowedFromOrderStatusIds in conditions', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        conditions: { allowedFromOrderStatusIds: 'not-an-array' },
      }),
    );
  });

  it('rejects non-integer entries in excludeOrderStatusIds', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        conditions: { excludeOrderStatusIds: [1, 2.5] },
      }),
    );
  });

  it('rejects a non-boolean excludeCompletedOrders in conditions', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        conditions: { excludeCompletedOrders: 'true' },
      }),
    );
  });

  it('rejects recipients that is not an object', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        recipients: ['order_manager'],
      }),
    );
  });

  it('rejects non-array resolvers in recipients', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        recipients: { resolvers: 'order_manager' },
      }),
    );
  });

  it('rejects non-string entries in resolvers', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        recipients: { resolvers: ['order_manager', 42] },
      }),
    );
  });

  it('rejects non-string entries in roleCodes', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        recipients: { roleCodes: [1, 2] },
      }),
    );
  });

  it('rejects userIds with a non-integer entry', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        recipients: { userIds: [1, 2.5] },
      }),
    );
  });

  it('rejects a non-string titleTemplate', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'notify-order-overdue-manager',
        eventType: 'order.production_status_changed',
        titleTemplate: 123,
      }),
    );
  });

  it('rejects malformed groupId', () => {
    expectInvalidPayloadError(() =>
      parseCreateNotificationRuleRequest({
        ruleCode: 'bad-group',
        eventType: 'DEADLINE_EXPIRED',
        groupId: 'not-a-uuid',
        recipients: { resolvers: ['group_participants'] },
      }),
    );
  });

  it('rejects a non-object body', () => {
    expectInvalidPayloadError(() => parseCreateNotificationRuleRequest('not-an-object'));
  });

  it('rejects a null body', () => {
    expectInvalidPayloadError(() => parseCreateNotificationRuleRequest(null));
  });
});

describe('parseUpdateNotificationRuleRequest', () => {
  it('parses a valid compatibility update without expectedUpdatedAt', () => {
    const result = parseUpdateNotificationRuleRequest({
      level: 'error',
      priority: 10,
      reason: 'Escalate overdue notifications',
    });

    expect(result).toEqual({
      patch: { level: 'error', priority: 10 },
      reason: 'Escalate overdue notifications',
    });
  });

  it('parses a valid partial update with isEnabled and expectedUpdatedAt', () => {
    const result = parseUpdateNotificationRuleRequest({
      isEnabled: false,
      expectedUpdatedAt: '2026-06-01T10:00:00.000Z',
    });

    expect(result).toEqual({
      patch: { isEnabled: false },
      expectedUpdatedAt: '2026-06-01T10:00:00.000Z',
    });
  });

  it('parses Telegram channel selection on update', () => {
    expect(parseUpdateNotificationRuleRequest({ channels: ['telegram'] })).toEqual({
      patch: { channels: ['telegram'] },
    });
  });

  it('parses null groupId on update as explicit clear', () => {
    const result = parseUpdateNotificationRuleRequest({
      groupId: null,
      reason: 'make rule global',
      expectedUpdatedAt: '2026-06-14T00:00:00.000Z',
    });

    expect(result.patch).toEqual({ groupId: null });
  });

  it('parses an update touching conditions and recipients', () => {
    const result = parseUpdateNotificationRuleRequest({
      conditions: { excludeCompletedOrders: true },
      recipients: { roleCodes: ['admin'] },
    });

    expect(result).toEqual({
      patch: {
        conditions: { excludeCompletedOrders: true },
        recipients: { roleCodes: ['admin'] },
      },
    });
  });

  it('preserves deadlineEntityTypes in conditions on update', () => {
    const result = parseUpdateNotificationRuleRequest({
      conditions: { deadlineEntityTypes: ['order'] },
    });

    expect(result.patch.conditions).toEqual({ deadlineEntityTypes: ['order'] });
  });

  it('preserves requireCurrentDeadlineEvent in conditions on update', () => {
    const result = parseUpdateNotificationRuleRequest({
      conditions: { requireCurrentDeadlineEvent: false },
    });

    expect(result.patch.conditions).toEqual({ requireCurrentDeadlineEvent: false });
  });

  it('rejects unsupported deadlineEntityTypes values on update', () => {
    expectInvalidPayloadError(() =>
      parseUpdateNotificationRuleRequest({
        conditions: { deadlineEntityTypes: ['client'] },
      }),
    );
  });

  it('rejects empty deadlineEntityTypes on update', () => {
    expectInvalidPayloadError(() =>
      parseUpdateNotificationRuleRequest({
        conditions: { deadlineEntityTypes: [] },
      }),
    );
  });

  it('rejects an empty update body', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({}));
  });

  it('rejects an update body with only an unrecognized field', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({ reason: 'no-op change' }));
  });

  it('rejects an unsupported level value', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({ level: 'critical' }));
  });

  it('rejects a non-integer priority', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({ priority: 1.5 }));
  });

  it('rejects a non-boolean isEnabled', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({ isEnabled: 'no' }));
  });

  it('rejects conditions that is not an object', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({ conditions: 'nope' }));
  });

  it('rejects malformed conditions field types', () => {
    expectInvalidPayloadError(() =>
      parseUpdateNotificationRuleRequest({ conditions: { allowedFromOrderStatusIds: ['x'] } }),
    );
  });

  it('rejects recipients that is not an object', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({ recipients: 'nope' }));
  });

  it('rejects malformed recipients field types', () => {
    expectInvalidPayloadError(() =>
      parseUpdateNotificationRuleRequest({ recipients: { userIds: ['x'] } }),
    );
  });

  it('rejects a non-string reason', () => {
    expectInvalidPayloadError(() =>
      parseUpdateNotificationRuleRequest({ isEnabled: true, reason: 123 }),
    );
  });

  it('rejects a non-string expectedUpdatedAt', () => {
    expectInvalidPayloadError(() =>
      parseUpdateNotificationRuleRequest({ isEnabled: true, expectedUpdatedAt: 123 }),
    );
  });

  it('rejects a non-string/non-null titleTemplate', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest({ titleTemplate: 123 }));
  });

  it('accepts an explicit null titleTemplate and messageTemplate', () => {
    const result = parseUpdateNotificationRuleRequest({
      titleTemplate: null,
      messageTemplate: null,
    });

    expect(result).toEqual({
      patch: { titleTemplate: null, messageTemplate: null },
    });
  });

  it('rejects a non-object body', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest('not-an-object'));
  });

  it('rejects a null body', () => {
    expectInvalidPayloadError(() => parseUpdateNotificationRuleRequest(null));
  });
});
