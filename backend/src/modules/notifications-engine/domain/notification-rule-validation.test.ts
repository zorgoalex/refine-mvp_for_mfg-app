import { describe, expect, it } from 'vitest';
import { validateNotificationRuleInput } from './notification-rule-validation';

const base = {
  ruleCode: 'notify-order-overdue-manager',
  eventType: 'order.production_status_changed',
  level: 'warning' as const,
  priority: 100,
  conditions: { excludeCompletedOrders: true },
  recipients: { resolvers: ['order_manager' as const] },
};

describe('validateNotificationRuleInput', () => {
  it('accepts a valid notify rule', () => {
    expect(validateNotificationRuleInput(base, { knownRoleCodes: ['admin'] })).toEqual({ ok: true });
  });
  it('rejects unknown event types', () => {
    expect(validateNotificationRuleInput({ ...base, eventType: 'nope' }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'UNKNOWN_EVENT_TYPE' });
  });
  it('rejects empty recipients', () => {
    expect(validateNotificationRuleInput({ ...base, recipients: {} }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'EMPTY_RECIPIENTS' });
  });
  it('accepts Telegram and rejects empty, duplicate, or unsupported channels', () => {
    expect(
      validateNotificationRuleInput({ ...base, channels: ['telegram'] }, { knownRoleCodes: [] }),
    ).toEqual({ ok: true });
    expect(
      validateNotificationRuleInput({ ...base, channels: [] }, { knownRoleCodes: [] }),
    ).toEqual({ ok: false, code: 'EMPTY_CHANNELS' });
    expect(
      validateNotificationRuleInput(
        { ...base, channels: ['in_app', 'in_app'] },
        { knownRoleCodes: [] },
      ),
    ).toEqual({ ok: false, code: 'DUPLICATE_CHANNEL' });
    expect(
      validateNotificationRuleInput(
        { ...base, channels: ['email' as never] },
        { knownRoleCodes: [] },
      ),
    ).toEqual({ ok: false, code: 'UNSUPPORTED_CHANNEL', detail: 'email' });
  });
  it('rejects an unsupported resolver', () => {
    expect(validateNotificationRuleInput({ ...base, recipients: { resolvers: ['nonexistent' as never] } }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'UNSUPPORTED_RESOLVER', detail: 'nonexistent' });
  });
  it('accepts stage_assignee for order events', () => {
    expect(validateNotificationRuleInput({ ...base, recipients: { resolvers: ['stage_assignee' as const] } }, { knownRoleCodes: [] }))
      .toEqual({ ok: true });
  });
  it('rejects unknown role codes', () => {
    expect(validateNotificationRuleInput({ ...base, recipients: { roleCodes: ['ghost'] } }, { knownRoleCodes: ['admin'] }))
      .toEqual({ ok: false, code: 'UNKNOWN_ROLE_CODE', detail: 'ghost' });
  });
  it('accepts workshop_head and direction_head for order events', () => {
    expect(
      validateNotificationRuleInput(
        { ...base, recipients: { resolvers: ['workshop_head' as const] } },
        { knownRoleCodes: [] },
      ),
    ).toEqual({ ok: true });
    expect(
      validateNotificationRuleInput(
        { ...base, recipients: { resolvers: ['direction_head' as const] } },
        { knownRoleCodes: [] },
      ),
    ).toEqual({ ok: true });
  });

  it('rejects head resolvers for the group-only GROUP_DEADLINE_OVERDUE event', () => {
    expect(
      validateNotificationRuleInput(
        {
          ...base,
          eventType: 'GROUP_DEADLINE_OVERDUE',
          conditions: {},
          recipients: { resolvers: ['workshop_head' as const] },
        },
        { knownRoleCodes: [] },
      ),
    ).toEqual({ ok: false, code: 'UNSUPPORTED_RESOLVER', detail: 'workshop_head' });
  });

  it('rejects order-status conditions on an event without order context', () => {
    expect(validateNotificationRuleInput(
      { ...base, eventType: 'GROUP_DEADLINE_OVERDUE', conditions: { allowedFromOrderStatusIds: [1] }, recipients: { resolvers: ['group_participants'] } },
      { knownRoleCodes: [] },
    )).toEqual({ ok: false, code: 'ORDER_CONDITION_UNSUPPORTED' });
  });

  it('accepts deadlineEntityTypes for deadline events', () => {
    expect(validateNotificationRuleInput(
      {
        ...base,
        eventType: 'DEADLINE_EXPIRED',
        conditions: { deadlineEntityTypes: ['order'] },
      },
      { knownRoleCodes: [] },
    )).toEqual({ ok: true });
  });

  it('rejects deadlineEntityTypes for non-deadline events', () => {
    expect(validateNotificationRuleInput(
      {
        ...base,
        eventType: 'order.status_changed',
        conditions: { deadlineEntityTypes: ['order'] },
      },
      { knownRoleCodes: [] },
    )).toEqual({ ok: false, code: 'DEADLINE_CONDITION_UNSUPPORTED' });
  });
});
