import { describe, expect, it } from 'vitest';
import { ProjectNotificationService } from './project-notification.service';
import type { ProjectNotificationDelivery, ProjectNotificationRecipient } from './project-notification.types';

describe('ProjectNotificationService', () => {
  it('creates PROJECT_ORDER_LINKS_CHANGED notifications for current visible participants only', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')] });
    await new ProjectNotificationService(deps).handleProjectOrderLinksChanged(orderInput());

    expect(deps.notifications.calls[0]).toMatchObject({
      eventType: 'PROJECT_ORDER_LINKS_CHANGED',
      projectId: projectId('1'),
      deliveries: [{ recipientUserId: '1' }],
    });
  });

  it('groups one order-link command by each changed projectId before recipient lookup', async () => {
    const deps = fakeDeps({
      participantsByProject: {
        [projectId('1')]: [recipient('1')],
        [projectId('2')]: [recipient('2')],
      },
      visibleByProject: {
        [projectId('1')]: [recipient('1')],
        [projectId('2')]: [recipient('2')],
      },
    });

    await new ProjectNotificationService(deps).handleProjectOrderLinksChanged({
      ...orderInput(),
      facts: [
        { orderId: '15', projectId: projectId('1'), action: 'added' },
        { orderId: '15', projectId: projectId('2'), action: 'removed' },
      ],
    });

    expect(deps.recipients.projectsLookedUp).toEqual([projectId('1'), projectId('2')]);
    expect(deps.notifications.calls.map((call) => call.deliveries.map((delivery) => delivery.recipientUserId))).toEqual([['1'], ['2']]);
  });

  it('handles one order-link command changing multiple projects without cross-notifying participants', async () => {
    const deps = fakeDeps({
      visibleByProject: {
        [projectId('1')]: [recipient('1')],
        [projectId('2')]: [recipient('2')],
      },
    });

    await new ProjectNotificationService(deps).handleProjectOrderLinksChanged({
      ...orderInput(),
      facts: [
        { orderId: '15', projectId: projectId('1'), action: 'added' },
        { orderId: '15', projectId: projectId('2'), action: 'added' },
      ],
    });

    expect(deps.notifications.calls[0].deliveries).toMatchObject([{ recipientUserId: '1' }]);
    expect(deps.notifications.calls[1].deliveries).toMatchObject([{ recipientUserId: '2' }]);
  });

  it('maps participant added facts to PROJECT_MEMBER_ADDED', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], identityVisibility: true });
    await new ProjectNotificationService(deps).handleProjectMembersChanged(memberInput({
      added: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    }));

    expect(deps.notifications.calls[0]).toMatchObject({
      eventType: 'PROJECT_MEMBER_ADDED',
      fact: { factKey: 'participant:user:158:role:manager:added' },
    });
  });

  it('maps participant removed facts to PROJECT_MEMBER_REMOVED', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], identityVisibility: true });
    await new ProjectNotificationService(deps).handleProjectMembersChanged(memberInput({
      removed: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
    }));

    expect(deps.notifications.calls[0]).toMatchObject({
      eventType: 'PROJECT_MEMBER_REMOVED',
      fact: { factKey: 'participant:employee:77:role:observer:removed' },
    });
  });

  it('creates no notification for employee-only participants without login', async () => {
    const deps = fakeDeps({ participantsByProject: { [projectId('1')]: [] }, visibleRecipients: [] });
    await new ProjectNotificationService(deps).handleProjectOrderLinksChanged(orderInput());
    expect(deps.notifications.calls[0].deliveries).toEqual([]);
  });

  it('uses distinct factKey values so one command with multiple added members creates distinct notifications', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], identityVisibility: true });
    await new ProjectNotificationService(deps).handleProjectMembersChanged(memberInput({
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
    await new ProjectNotificationService(deps).handleProjectMembersChanged(memberInput({
      added: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    }));

    expect(deps.notifications.calls[0].deliveries[0]).toEqual({
      recipientUserId: '1',
      title: 'Project participant changed',
      message: 'Project participant changed.',
    });
  });

  it('creates no notification when base order visibility denies the recipient', async () => {
    const deps = fakeDeps({ visibleRecipients: [] });
    await new ProjectNotificationService(deps).handleProjectOrderLinksChanged(orderInput());
    expect(deps.notifications.calls[0].deliveries).toEqual([]);
  });

  it('replay with same source id and same fact keys does not duplicate persisted notifications', async () => {
    const deps = fakeDeps({ visibleRecipients: [recipient('1')], created: 0 });
    await expect(new ProjectNotificationService(deps).handleProjectOrderLinksChanged(orderInput()))
      .resolves.toMatchObject([{ created: 0 }]);
  });
});

function fakeDeps({
  participantsByProject = {},
  visibleByProject = {},
  visibleRecipients = [recipient('1')],
  identityVisibility = true,
  created = 1,
}: {
  participantsByProject?: Record<string, ProjectNotificationRecipient[]>;
  visibleByProject?: Record<string, ProjectNotificationRecipient[]>;
  visibleRecipients?: ProjectNotificationRecipient[];
  identityVisibility?: boolean;
  created?: number;
} = {}) {
  const recipients = {
    projectsLookedUp: [] as string[],
    async listCurrentUserParticipants(project: string) {
      this.projectsLookedUp.push(project);
      return participantsByProject[project] ?? visibleByProject[project] ?? visibleRecipients;
    },
    async filterRecipientsByBaseVisibility(input: { recipients: ProjectNotificationRecipient[] }) {
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
      projectId: string;
      fact: { factKey: string };
      deliveries: ProjectNotificationDelivery[];
    }>,
    async createNotifications(input: {
      eventType: string;
      projectId: string;
      fact: { factKey: string };
      deliveries: ProjectNotificationDelivery[];
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
    facts: [{ orderId: '15', projectId: projectId('1'), action: 'added' as const }],
  };
}

function memberInput(input: {
  added?: Array<{ participantType: string; participantId: string; roleCode: string }>;
  removed?: Array<{ participantType: string; participantId: string; roleCode: string }>;
}) {
  return {
    projectId: projectId('1'),
    sourceId: 'command-1',
    actorUserId: '1',
    requestId: 'request-1',
    added: input.added ?? [],
    removed: input.removed ?? [],
  };
}

function recipient(userId: string): ProjectNotificationRecipient {
  return { userId, username: `user-${userId}`, roleCode: projectId(userId) };
}

function projectId(suffix: string = '1'): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}
