import { describe, expect, it } from 'vitest';
import { buildNotificationDeliveryKey } from './notification-idempotency';

describe('buildNotificationDeliveryKey', () => {
  it('builds the expected key shape', () => {
    expect(buildNotificationDeliveryKey({ outboxEventId: 'evt-1', ruleId: 'rule-1', userId: 7 }))
      .toBe('notif-rule:evt-1:rule-1:7');
  });
  it('is deterministic for the same input', () => {
    const input = { outboxEventId: 'evt-2', ruleId: 'rule-2', userId: 9 };
    expect(buildNotificationDeliveryKey(input)).toBe(buildNotificationDeliveryKey({ ...input }));
  });
  it('produces different keys for different inputs', () => {
    const base = { outboxEventId: 'evt-3', ruleId: 'rule-3', userId: 1 };
    expect(buildNotificationDeliveryKey(base)).not.toBe(buildNotificationDeliveryKey({ ...base, userId: 2 }));
    expect(buildNotificationDeliveryKey(base)).not.toBe(buildNotificationDeliveryKey({ ...base, ruleId: 'rule-4' }));
    expect(buildNotificationDeliveryKey(base)).not.toBe(buildNotificationDeliveryKey({ ...base, outboxEventId: 'evt-4' }));
  });
});
