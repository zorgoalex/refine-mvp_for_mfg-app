import { describe, expect, it } from 'vitest';
import { PgGroupDeadlineOverdueNotificationPort } from './pg-group-deadline-overdue-notification-port';

describe('PgGroupDeadlineOverdueNotificationPort', () => {
  it('notifies groups with current generic deadline links and typed order links', async () => {
    const database = fakeDatabase([
      { group_id: projectId('1') },
      { group_id: projectId('2') },
    ]);
    const notifications = fakeNotifications();
    const port = new PgGroupDeadlineOverdueNotificationPort(database, notifications, true);

    await port.notifyDeadlineOverdue({
      deadlineEventId: 'event-1',
      deadlineInstanceId: deadlineId('1'),
      orderId: '42',
      actorUserId: '7',
      requestId: 'req-1',
    });

    expect(database.queries[0]).toMatchObject({
      params: [deadlineId('1'), '42'],
    });
    expect(database.queries[0]?.text).toContain('FROM public.group_entity_links');
    expect(database.queries[0]?.text).toContain("pel.entity_type_code = 'deadline_instance'");
    expect(database.queries[0]?.text).toContain('pel.valid_to IS NULL');
    expect(database.queries[0]?.text).toContain('FROM public.group_order_groups');
    expect(database.queries[0]?.text).toContain('pop.valid_to IS NULL');
    expect(notifications.calls).toEqual([
      {
        groupId: projectId('1'),
        sourceId: 'event-1',
        actorUserId: '7',
        requestId: 'req-1',
        deadlineInstanceId: deadlineId('1'),
        orderId: '42',
      },
      {
        groupId: projectId('2'),
        sourceId: 'event-1',
        actorUserId: '7',
        requestId: 'req-1',
        deadlineInstanceId: deadlineId('1'),
        orderId: '42',
      },
    ]);
  });

  it('does not notify when no approved deadline_instance link exists', async () => {
    const database = fakeDatabase([]);
    const notifications = fakeNotifications();
    const port = new PgGroupDeadlineOverdueNotificationPort(database, notifications, true);

    await port.notifyDeadlineOverdue({
      deadlineEventId: 'event-1',
      deadlineInstanceId: deadlineId('1'),
      orderId: '42',
      actorUserId: null,
      requestId: 'req-1',
    });

    expect(notifications.calls).toEqual([]);
    expect(database.queries[1]?.text).toContain('GROUP_DEADLINE_OVERDUE_SKIPPED');
    expect(database.queries[1]?.params?.[2]).toBe('groups:p8:deadline-overdue-skipped:event-1:no_group_link');
  });

  it('records skipped evidence when the group P8 gate is disabled', async () => {
    const database = fakeDatabase([{ group_id: projectId('1') }]);
    const notifications = fakeNotifications();
    const port = new PgGroupDeadlineOverdueNotificationPort(database, notifications, false);

    await port.notifyDeadlineOverdue({
      deadlineEventId: 'event-1',
      deadlineInstanceId: deadlineId('1'),
      orderId: '42',
      actorUserId: null,
      requestId: 'req-1',
    });

    expect(notifications.calls).toEqual([]);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.text).toContain('GROUP_DEADLINE_OVERDUE_SKIPPED');
    expect(database.queries[0]?.params?.[2]).toBe(
      'groups:p8:deadline-overdue-skipped:event-1:group_p8_notifications_disabled',
    );
  });

  it('records skipped evidence when there is no order visibility anchor', async () => {
    const database = fakeDatabase([{ group_id: projectId('1') }]);
    const notifications = fakeNotifications();
    const port = new PgGroupDeadlineOverdueNotificationPort(database, notifications, true);

    await port.notifyDeadlineOverdue({
      deadlineEventId: 'event-1',
      deadlineInstanceId: deadlineId('1'),
      orderId: null,
      actorUserId: null,
      requestId: 'req-1',
    });

    expect(notifications.calls).toEqual([]);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.params?.[2]).toBe(
      'groups:p8:deadline-overdue-skipped:event-1:no_order_visibility_anchor',
    );
  });
});

function fakeDatabase(rows: Array<{ group_id: string }>) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] | undefined }>,
    async query(text: string, params?: readonly unknown[]) {
      this.queries.push({ text, params });
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
  };
}

function fakeNotifications() {
  return {
    calls: [] as Array<{
      groupId: string;
      sourceId: string;
      actorUserId: string | null;
      requestId: string;
      deadlineInstanceId: string;
      orderId: string | null;
    }>,
    async handleGroupDeadlineOverdue(input: {
      groupId: string;
      sourceId: string;
      actorUserId: string | null;
      requestId: string;
      deadlineInstanceId: string;
      orderId: string | null;
    }) {
      this.calls.push(input);
      return { attempted: 1, created: 1 };
    },
  };
}

function projectId(suffix: string = '1'): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}

function deadlineId(suffix: string = '1'): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}
