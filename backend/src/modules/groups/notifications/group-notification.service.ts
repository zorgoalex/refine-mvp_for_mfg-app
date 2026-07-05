import type {
  GroupNotificationDelivery,
  GroupNotificationEventType,
  GroupNotificationFact,
  GroupNotificationRecipient,
} from './group-notification.types';
import type {
  PgGroupNotificationRecipientRepository,
  UnavailableGroupNotificationRecipientRepository,
} from './group-notification-recipient.repository';
import type {
  PgGroupNotificationRepository,
  UnavailableGroupNotificationRepository,
} from './group-notification.repository';

type RecipientRepository = PgGroupNotificationRecipientRepository | UnavailableGroupNotificationRecipientRepository;
type NotificationRepository = PgGroupNotificationRepository | UnavailableGroupNotificationRepository;

export class GroupNotificationService {
  constructor(private readonly deps: {
    recipients: RecipientRepository;
    notifications: NotificationRepository;
  }) {}

  async handleGroupOrderLinksChanged(input: {
    sourceId: string;
    actorUserId: string | null;
    requestId: string;
    facts: Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }>;
  }): Promise<Array<{ groupId: string; factKey: string; attempted: number; created: number }>> {
    const results: Array<{ groupId: string; factKey: string; attempted: number; created: number }> = [];

    for (const eventFact of input.facts) {
      const fact: GroupNotificationFact = {
        factKey: `order:${eventFact.orderId}:group:${eventFact.groupId}:${eventFact.action}`,
        groupId: eventFact.groupId,
        linkedEntity: { entityType: 'order', entityId: eventFact.orderId },
        auditRelated: { orderId: eventFact.orderId },
      };
      const recipients = await this.visibleGroupRecipients(eventFact.groupId, fact);
      const persisted = await this.deps.notifications.createNotifications({
        eventType: 'GROUP_ORDER_LINKS_CHANGED',
        groupId: eventFact.groupId,
        sourceId: input.sourceId,
        fact,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        deliveries: recipients.map((recipient) => ({
          recipientUserId: recipient.userId,
          title: 'Group order links changed',
          message: `Order ${eventFact.orderId} was ${eventFact.action === 'added' ? 'linked to' : 'removed from'} this group.`,
        })),
        auditMetadata: { action: eventFact.action },
      });
      results.push({ groupId: eventFact.groupId, factKey: fact.factKey, attempted: persisted.attempted, created: persisted.created });
    }

    return results;
  }

  async handleGroupMembersChanged(input: {
    groupId: string;
    sourceId: string;
    actorUserId: string | null;
    requestId: string;
    added: Array<{ participantType: string; participantId: string; roleCode: string }>;
    removed: Array<{ participantType: string; participantId: string; roleCode: string }>;
  }): Promise<Array<{ eventType: GroupNotificationEventType; factKey: string; attempted: number; created: number }>> {
    const facts = [
      ...input.added.map((participant) => ({ ...participant, eventType: 'GROUP_MEMBER_ADDED' as const, action: 'added' as const })),
      ...input.removed.map((participant) => ({ ...participant, eventType: 'GROUP_MEMBER_REMOVED' as const, action: 'removed' as const })),
    ].filter((participant) => participant.participantType === 'user' || participant.participantType === 'employee');

    const results: Array<{ eventType: GroupNotificationEventType; factKey: string; attempted: number; created: number }> = [];

    for (const member of facts) {
      const participantType = member.participantType as 'user' | 'employee';
      const fact: GroupNotificationFact = {
        factKey: `participant:${participantType}:${member.participantId}:role:${member.roleCode}:${member.action}`,
        groupId: input.groupId,
        linkedEntity: { entityType: participantType, entityId: member.participantId },
        auditRelated: participantType === 'user'
          ? { userId: member.participantId }
          : { employeeId: member.participantId },
      };
      const recipients = await this.deps.recipients.listCurrentUserParticipants(input.groupId);
      const deliveries: GroupNotificationDelivery[] = [];

      for (const recipient of recipients) {
        const canViewIdentity = await this.deps.recipients.canRecipientViewMemberIdentity({
          recipient,
          participantType,
        });
        deliveries.push(renderMemberDelivery({
          recipient,
          canViewIdentity,
          eventType: member.eventType,
          participantType,
          participantId: member.participantId,
          roleCode: member.roleCode,
        }));
      }

      const persisted = await this.deps.notifications.createNotifications({
        eventType: member.eventType,
        groupId: input.groupId,
        sourceId: input.sourceId,
        fact,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        deliveries,
        auditMetadata: {
          participantType,
          participantRoleCode: member.roleCode,
          redactionPolicy: 'member_identity_requires_base_permission',
        },
      });
      results.push({ eventType: member.eventType, factKey: fact.factKey, attempted: persisted.attempted, created: persisted.created });
    }

    return results;
  }

  async handleGroupDeadlineOverdue(input: {
    groupId: string;
    sourceId: string;
    actorUserId: string | null;
    requestId: string;
    deadlineInstanceId: string;
    orderId: string | null;
  }): Promise<{ attempted: number; created: number }> {
    if (!input.orderId) return { attempted: 0, created: 0 };

    const fact: GroupNotificationFact = {
      factKey: `deadline_instance:${input.deadlineInstanceId}:event:${input.sourceId}`,
      groupId: input.groupId,
      linkedEntity: { entityType: 'deadline_instance', entityId: input.deadlineInstanceId },
      auditRelated: { deadlineId: input.deadlineInstanceId, orderId: input.orderId },
    };
    const recipients = await this.visibleGroupRecipients(input.groupId, fact);
    const persisted = await this.deps.notifications.createNotifications({
      eventType: 'GROUP_DEADLINE_OVERDUE',
      groupId: input.groupId,
      sourceId: input.sourceId,
      fact,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      deliveries: recipients.map((recipient) => ({
        recipientUserId: recipient.userId,
        title: 'Group deadline overdue',
        message: `Deadline ${input.deadlineInstanceId} is overdue.`,
      })),
      auditMetadata: { deadlineInstanceId: input.deadlineInstanceId },
    });

    return { attempted: persisted.attempted, created: persisted.created };
  }

  private async visibleGroupRecipients(
    groupId: string,
    fact: GroupNotificationFact,
  ): Promise<GroupNotificationRecipient[]> {
    const participants = await this.deps.recipients.listCurrentUserParticipants(groupId);
    return this.deps.recipients.filterRecipientsByBaseVisibility({
      recipients: participants,
      linkedEntity: fact.linkedEntity,
    });
  }
}

function renderMemberDelivery(input: {
  recipient: GroupNotificationRecipient;
  canViewIdentity: boolean;
  eventType: 'GROUP_MEMBER_ADDED' | 'GROUP_MEMBER_REMOVED';
  participantType: 'user' | 'employee';
  participantId: string;
  roleCode: string;
}): GroupNotificationDelivery {
  if (!input.canViewIdentity) {
    return {
      recipientUserId: input.recipient.userId,
      title: 'Group participant changed',
      message: 'Group participant changed.',
    };
  }

  const action = input.eventType === 'GROUP_MEMBER_ADDED' ? 'added' : 'removed';
  return {
    recipientUserId: input.recipient.userId,
    title: `Group member ${action}`,
    message: `${input.participantType} ${input.participantId} was ${action} with role ${input.roleCode}.`,
  };
}
