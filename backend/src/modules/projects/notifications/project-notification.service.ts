import type {
  ProjectNotificationDelivery,
  ProjectNotificationEventType,
  ProjectNotificationFact,
  ProjectNotificationRecipient,
} from './project-notification.types';
import type {
  PgProjectNotificationRecipientRepository,
  UnavailableProjectNotificationRecipientRepository,
} from './project-notification-recipient.repository';
import type {
  PgProjectNotificationRepository,
  UnavailableProjectNotificationRepository,
} from './project-notification.repository';

type RecipientRepository = PgProjectNotificationRecipientRepository | UnavailableProjectNotificationRecipientRepository;
type NotificationRepository = PgProjectNotificationRepository | UnavailableProjectNotificationRepository;

export class ProjectNotificationService {
  constructor(private readonly deps: {
    recipients: RecipientRepository;
    notifications: NotificationRepository;
  }) {}

  async handleProjectOrderLinksChanged(input: {
    sourceId: string;
    actorUserId: string | null;
    requestId: string;
    facts: Array<{ orderId: string; projectId: string; action: 'added' | 'removed' }>;
  }): Promise<Array<{ projectId: string; factKey: string; attempted: number; created: number }>> {
    const results: Array<{ projectId: string; factKey: string; attempted: number; created: number }> = [];

    for (const eventFact of input.facts) {
      const fact: ProjectNotificationFact = {
        factKey: `order:${eventFact.orderId}:project:${eventFact.projectId}:${eventFact.action}`,
        projectId: eventFact.projectId,
        linkedEntity: { entityType: 'order', entityId: eventFact.orderId },
        auditRelated: { orderId: eventFact.orderId },
      };
      const recipients = await this.visibleProjectRecipients(eventFact.projectId, fact);
      const persisted = await this.deps.notifications.createNotifications({
        eventType: 'PROJECT_ORDER_LINKS_CHANGED',
        projectId: eventFact.projectId,
        sourceId: input.sourceId,
        fact,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        deliveries: recipients.map((recipient) => ({
          recipientUserId: recipient.userId,
          title: 'Project order links changed',
          message: `Order ${eventFact.orderId} was ${eventFact.action === 'added' ? 'linked to' : 'removed from'} this project.`,
        })),
        auditMetadata: { action: eventFact.action },
      });
      results.push({ projectId: eventFact.projectId, factKey: fact.factKey, attempted: persisted.attempted, created: persisted.created });
    }

    return results;
  }

  async handleProjectMembersChanged(input: {
    projectId: string;
    sourceId: string;
    actorUserId: string | null;
    requestId: string;
    added: Array<{ participantType: string; participantId: string; roleCode: string }>;
    removed: Array<{ participantType: string; participantId: string; roleCode: string }>;
  }): Promise<Array<{ eventType: ProjectNotificationEventType; factKey: string; attempted: number; created: number }>> {
    const facts = [
      ...input.added.map((participant) => ({ ...participant, eventType: 'PROJECT_MEMBER_ADDED' as const, action: 'added' as const })),
      ...input.removed.map((participant) => ({ ...participant, eventType: 'PROJECT_MEMBER_REMOVED' as const, action: 'removed' as const })),
    ].filter((participant) => participant.participantType === 'user' || participant.participantType === 'employee');

    const results: Array<{ eventType: ProjectNotificationEventType; factKey: string; attempted: number; created: number }> = [];

    for (const member of facts) {
      const participantType = member.participantType as 'user' | 'employee';
      const fact: ProjectNotificationFact = {
        factKey: `participant:${participantType}:${member.participantId}:role:${member.roleCode}:${member.action}`,
        projectId: input.projectId,
        linkedEntity: { entityType: participantType, entityId: member.participantId },
        auditRelated: participantType === 'user'
          ? { userId: member.participantId }
          : { employeeId: member.participantId },
      };
      const recipients = await this.deps.recipients.listCurrentUserParticipants(input.projectId);
      const deliveries: ProjectNotificationDelivery[] = [];

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
        projectId: input.projectId,
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

  async handleProjectDeadlineOverdue(input: {
    projectId: string;
    sourceId: string;
    actorUserId: string | null;
    requestId: string;
    deadlineInstanceId: string;
    orderId: string | null;
  }): Promise<{ attempted: number; created: number }> {
    if (!input.orderId) return { attempted: 0, created: 0 };

    const fact: ProjectNotificationFact = {
      factKey: `deadline_instance:${input.deadlineInstanceId}:event:${input.sourceId}`,
      projectId: input.projectId,
      linkedEntity: { entityType: 'order', entityId: input.orderId },
      auditRelated: { deadlineId: input.deadlineInstanceId, orderId: input.orderId },
    };
    const recipients = await this.visibleProjectRecipients(input.projectId, fact);
    const persisted = await this.deps.notifications.createNotifications({
      eventType: 'PROJECT_DEADLINE_OVERDUE',
      projectId: input.projectId,
      sourceId: input.sourceId,
      fact,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      deliveries: recipients.map((recipient) => ({
        recipientUserId: recipient.userId,
        title: 'Project deadline overdue',
        message: `Deadline ${input.deadlineInstanceId} is overdue.`,
      })),
      auditMetadata: { deadlineInstanceId: input.deadlineInstanceId },
    });

    return { attempted: persisted.attempted, created: persisted.created };
  }

  private async visibleProjectRecipients(
    projectId: string,
    fact: ProjectNotificationFact,
  ): Promise<ProjectNotificationRecipient[]> {
    const participants = await this.deps.recipients.listCurrentUserParticipants(projectId);
    return this.deps.recipients.filterRecipientsByBaseVisibility({
      recipients: participants,
      linkedEntity: fact.linkedEntity,
    });
  }
}

function renderMemberDelivery(input: {
  recipient: ProjectNotificationRecipient;
  canViewIdentity: boolean;
  eventType: 'PROJECT_MEMBER_ADDED' | 'PROJECT_MEMBER_REMOVED';
  participantType: 'user' | 'employee';
  participantId: string;
  roleCode: string;
}): ProjectNotificationDelivery {
  if (!input.canViewIdentity) {
    return {
      recipientUserId: input.recipient.userId,
      title: 'Project participant changed',
      message: 'Project participant changed.',
    };
  }

  const action = input.eventType === 'PROJECT_MEMBER_ADDED' ? 'added' : 'removed';
  return {
    recipientUserId: input.recipient.userId,
    title: `Project member ${action}`,
    message: `${input.participantType} ${input.participantId} was ${action} with role ${input.roleCode}.`,
  };
}
