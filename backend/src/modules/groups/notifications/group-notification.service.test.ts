import { describe, expect, it } from 'vitest';
import { GroupNotificationService } from './group-notification.service';
import type { GroupNotificationDelivery, GroupNotificationRecipient } from './group-notification.types';

describe('GroupNotificationService', () => {
  it('creates GROUP_ORDER_LINKS_CHANGED notifications for current visible participants only', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')] });
    await new GroupNotificationService(deps).handleGroupOrderLinksChanged(orderInput());

    expect(deps.notifications.calls[0]).toMatchObject({
      eventType: 'GROUP_ORDER_LINKS_CHANGED',
      groupId: groupId('1'),
      deliveries: [{ recipientUserId: '1' }],
    });
  });

  it('groups one order-link command by each changed groupId before recipient lookup', async () => {
    const deps = fakeDeps({
      participantsByGroup: {
        [groupId('1')]: [recipient('1')],
        [groupId('2')]: [recipient('2')],
      },
      visibleByGroup: {
        [groupId('1')]: [recipient('1')],
        [groupId('2')]: [recipient('2')],
      },
    });

    await new GroupNotificationService(deps).handleGroupOrderLinksChanged({
      ...orderInput(),
      facts: [
        { orderId: '15', groupId: groupId('1'), action: 'added' },
        { orderId: '15', groupId: groupId('2'), action: 'removed' },
      ],
    });

    expect(deps.recipients.groupsLookedUp).toEqual([groupId('1'), groupId('2')]);
    expect(deps.notifications.calls.map((call) => call.deliveries.map((delivery) => delivery.recipientUserId))).toEqual([['1'], ['2']]);
  });

  it('handles one order-link command changing multiple groups without cross-notifying participants', async () => {
    const deps = fakeDeps({
      visibleByGroup: {
        [groupId('1')]: [recipient('1')],
        [groupId('2')]: [recipient('2')],
      },
    });

    await new GroupNotificationService(deps).handleGroupOrderLinksChanged({
      ...orderInput(),
      facts: [
        { orderId: '15', groupId: groupId('1'), action: 'added' },
        { orderId: '15', groupId: groupId('2'), action: 'added' },
      ],
    });

    expect(deps.notifications.calls[0].deliveries).toMatchObject([{ recipientUserId: '1' }]);
    expect(deps.notifications.calls[1].deliveries).toMatchObject([{ recipientUserId: '2' }]);
  });

  it('maps participant added facts to GROUP_MEMBER_ADDED', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], identityVisibility: true });
    await new GroupNotificationService(deps).handleGroupMembersChanged(memberInput({
      added: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    }));

    expect(deps.notifications.calls[0]).toMatchObject({
      eventType: 'GROUP_MEMBER_ADDED',
      fact: { factKey: 'participant:user:158:role:manager:added' },
    });
  });

  it('maps participant removed facts to GROUP_MEMBER_REMOVED', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], identityVisibility: true });
    await new GroupNotificationService(deps).handleGroupMembersChanged(memberInput({
      removed: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
    }));

    expect(deps.notifications.calls[0]).toMatchObject({
      eventType: 'GROUP_MEMBER_REMOVED',
      fact: { factKey: 'participant:employee:77:role:observer:removed' },
    });
  });

  it('creates no notification for employee-only participants without login', async () => {
    const deps = fakeDeps({ participantsByGroup: { [groupId('1')]: [] }, visibleRecipients: [] });
    await new GroupNotificationService(deps).handleGroupOrderLinksChanged(orderInput());
    expect(deps.notifications.calls[0].deliveries).toEqual([]);
  });

  it('uses distinct factKey values so one command with multiple added members creates distinct notifications', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], identityVisibility: true });
    await new GroupNotificationService(deps).handleGroupMembersChanged(memberInput({
      added: [
        { participantType: 'user', participantId: '158', roleCode: 'manager' },
        { participantType: 'user', participantId: '159', roleCode: 'observer' },
      ],
    }));

    expect(deps.notifications.calls.map((call) => call.fact.factKey)).toEqual([
      'participant:user:158:role:manager:added',
      'participant:user:159:role:observer:added',
    ]);
  });

  it('redacts added/removed member identity for recipients without users.view or employees.view', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], identityVisibility: false });
    await new GroupNotificationService(deps).handleGroupMembersChanged(memberInput({
      added: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    }));

    expect(deps.notifications.calls[0].deliveries[0]).toEqual({
      recipientUserId: '1',
      title: 'Group participant changed',
      message: 'Group participant changed.',
    });
  });

  it('creates no notification when base order visibility denies the recipient', async () => {
    const deps = fakeDeps({ visibleRecipients: [] });
    await new GroupNotificationService(deps).handleGroupOrderLinksChanged(orderInput());
    expect(deps.notifications.calls[0].deliveries).toEqual([]);
  });

  it('replay with same source id and same fact keys does not duplicate persisted notifications', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], created: 0 });
    await expect(new GroupNotificationService(deps).handleGroupOrderLinksChanged(orderInput()))
      .resolves.toMatchObject([{ created: 0 }]);
  });

  it('filters overdue deadline recipients through deadline anchor visibility', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')] });

    await new GroupNotificationService(deps).handleGroupDeadlineOverdue({
      groupId: groupId('1'),
      sourceId: 'event-1',
      actorUserId: null,
      requestId: 'req-deadline-overdue',
      deadlineInstanceId: deadlineId('1'),
      orderId: '15',
    });

    expect(deps.recipients.visibilityChecks).toEqual([
      {
        recipients: [recipient('1')],
        linkedEntity: { entityType: 'deadline_instance', entityId: deadlineId('1') },
      },
    ]);
    expect(deps.notifications.calls[0]).toMatchObject({
      eventType: 'GROUP_DEADLINE_OVERDUE',
      fact: {
        factKey: `deadline_instance:${deadlineId('1')}:event:event-1`,
      },
      deliveries: [{ recipientUserId: '1' }],
    });
  });

  it('does not create overdue deadline notification without an order anchor', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')] });

    await expect(new GroupNotificationService(deps).handleGroupDeadlineOverdue({
      groupId: groupId('1'),
      sourceId: 'event-1',
      actorUserId: null,
      requestId: 'req-deadline-overdue',
      deadlineInstanceId: deadlineId('1'),
      orderId: null,
    })).resolves.toEqual({ attempted: 0, created: 0 });

    expect(deps.notifications.calls).toEqual([]);
  });
});

function fakeDeps({
  participantsByGroup = {},
  visibleByGroup = {},
  visibleRecipients = [recipient('1')],
  identityVisibility = true,
  created = 1,
}: {
  participantsByGroup?: Record<string, GroupNotificationRecipient[]>;
  visibleByGroup?: Record<string, GroupNotificationRecipient[]>;
  visibleRecipients?: GroupNotificationRecipient[];
  identityVisibility?: boolean;
  created?: number;
} = {}) {
  const recipients = {
    groupsLookedUp: [] as string[],
    visibilityChecks: [] as Array<{
      recipients: GroupNotificationRecipient[];
      linkedEntity: { entityType: string; entityId: string };
    }>,
    async listCurrentUserParticipants(group: string) {
      this.groupsLookedUp.push(group);
      return participantsByGroup[group] ?? visibleByGroup[group] ?? visibleRecipients;
    },
    async filterRecipientsByBaseVisibility(input: {
      recipients: GroupNotificationRecipient[];
      linkedEntity: { entityType: string; entityId: string };
    }) {
      this.visibilityChecks.push(input);
      if (visibleRecipients.length === 0) return [];
      return input.recipients;
    },
    async canRecipientViewMemberIdentity() {
      return identityVisibility;
    },
  };
  const notifications = {
    calls: [] as Array<{
      eventType: string;
      groupId: string;
      fact: { factKey: string };
      deliveries: GroupNotificationDelivery[];
    }>,
    async createNotifications(input: {
      eventType: string;
      groupId: string;
      fact: { factKey: string };
      deliveries: GroupNotificationDelivery[];
    }) {
      this.calls.push(input);
      return { attempted: input.deliveries.length, created, notificationIds: created ? ['n-1'] : [] };
    },
  };
  return { recipients, notifications };
}

function orderInput() {
  return {
    sourceId: 'command-1',
    actorUserId: '1',
    requestId: 'request-1',
    facts: [{ orderId: '15', groupId: groupId('1'), action: 'added' as const }],
  };
}

function memberInput(input: {
  added?: Array<{ participantType: string; participantId: string; roleCode: string }>;
  removed?: Array<{ participantType: string; participantId: string; roleCode: string }>;
}) {
  return {
    groupId: groupId('1'),
    sourceId: 'command-1',
    actorUserId: '1',
    requestId: 'request-1',
    added: input.added ?? [],
    removed: input.removed ?? [],
  };
}

function recipient(userId: string): GroupNotificationRecipient {
  return { userId, username: `user-${userId}`, roleCode: groupId(userId) };
}

function groupId(suffix: string = '1'): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}

function deadlineId(suffix: string = '1'): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}
