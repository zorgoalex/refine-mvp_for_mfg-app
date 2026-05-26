import { describe, expect, it } from 'vitest';
import { buildDeadlineActionIdempotencyKey } from './deadline-idempotency';

describe('deadline action idempotency', () => {
  it('builds a stable event/action/target/rule key', () => {
    expect(
      buildDeadlineActionIdempotencyKey({
        deadlineEventId: 'event-1',
        actionType: 'notify_assignee',
        targetType: 'user',
        targetId: 15,
        orderId: 42,
        actionRuleId: 'rule-1',
        snapshotHash: 'sha256:abc',
      }),
    ).toBe('event-1:notify_assignee:user:15:order:42:rule-1:none:sha256:abc');
  });

  it('normalizes missing target and rule material to none', () => {
    expect(
      buildDeadlineActionIdempotencyKey({
        deadlineEventId: 'event-1',
        actionType: 'write_audit',
      }),
    ).toBe('event-1:write_audit:none:none:order:none:none:none:none');
  });
});
