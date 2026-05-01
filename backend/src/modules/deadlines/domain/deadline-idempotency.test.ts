import { describe, expect, it } from 'vitest';
import { buildDeadlineActionIdempotencyKey } from './deadline-idempotency';

describe('deadline action idempotency', () => {
  it('builds a stable event/action/target key', () => {
    expect(
      buildDeadlineActionIdempotencyKey({
        deadlineEventId: 'event-1',
        actionType: 'notify_assignee',
        targetType: 'user',
        targetId: 15,
      }),
    ).toBe('event-1:notify_assignee:user:15');
  });

  it('normalizes missing target to none', () => {
    expect(
      buildDeadlineActionIdempotencyKey({
        deadlineEventId: 'event-1',
        actionType: 'write_audit',
      }),
    ).toBe('event-1:write_audit:none:none');
  });
});
