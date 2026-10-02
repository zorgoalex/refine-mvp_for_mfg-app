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
  it('procurement event: in_app only, change types required, procurement conditions only there', () => {
    const procurement = {
      ...base, eventType: 'order.resource_procurement_changed', conditions: { procurementChangeTypes: ['allocation_added' as const], allocationRoles: ['receipt' as const] },
    };
    expect(validateNotificationRuleInput(procurement, { knownRoleCodes: [] })).toEqual({ ok: true });
    expect(validateNotificationRuleInput({ ...procurement, channels: ['telegram'] }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'UNSUPPORTED_CHANNEL', detail: 'telegram' });
    expect(validateNotificationRuleInput({ ...procurement, conditions: {} }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'PROCUREMENT_CHANGE_TYPES_REQUIRED' });
    expect(validateNotificationRuleInput({ ...base, conditions: { allocationRoles: ['receipt'] } }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'PROCUREMENT_CONDITION_UNSUPPORTED' });
  });
  it('service events (procurement digest): no own recipients, in_app only', () => {
    const digest = { ...base, eventType: 'procurement.deficit_digest', level: 'info' as const, conditions: {}, recipients: {} };
    expect(validateNotificationRuleInput(digest, { knownRoleCodes: [] })).toEqual({ ok: true });
    expect(validateNotificationRuleInput({ ...digest, recipients: { userIds: [1] } }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'SERVICE_EVENT_RECIPIENTS_FIXED' });
    expect(validateNotificationRuleInput({ ...digest, channels: ['telegram'] }, { knownRoleCodes: [] }))
      .toEqual({ ok: false, code: 'UNSUPPORTED_CHANNEL', detail: 'telegram' });
    for (const patch of [{ level: 'warning' as const }, { titleTemplate: 'x' }, { messageTemplate: 'y' }, { groupId: '22222222-2222-4222-8222-222222222222' }]) {
      expect(validateNotificationRuleInput({ ...digest, level: 'info' as const, ...patch }, { knownRoleCodes: [] }))
        .toEqual({ ok: false, code: 'SERVICE_EVENT_FIELDS_FIXED' });
    }
    expect(validateNotificationRuleInput({ ...base, eventType: 'order.resource_demand_changed_after_mark', conditions: {} }, { knownRoleCodes: [] }))
      .toEqual({ ok: true });
  });
});

