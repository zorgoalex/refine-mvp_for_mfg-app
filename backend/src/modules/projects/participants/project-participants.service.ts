import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ProjectNotificationService } from '../notifications/project-notification.service';
import type { ProjectParticipantDto } from './project-participants.dto';
import type {
  ListProjectParticipantsCommand,
  ProjectParticipantRolesCommand,
  ProjectParticipantsRepositoryPort,
  ReplaceProjectParticipantsCommand,
} from './project-participants.repository';

export interface ProjectParticipantsPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface ProjectParticipantsServicePorts {
  participants: ProjectParticipantsRepositoryPort;
  permissions?: ProjectParticipantsPermissionsPort;
  notifications?: ProjectNotificationService;
  projectP8NotificationsEnabled?: boolean;
}

export class ProjectParticipantsService {
  private readonly permissions: ProjectParticipantsPermissionsPort;

  constructor(private readonly ports: ProjectParticipantsServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListProjectParticipantsCommand) {
    this.requirePermission(command.currentUser, 'projects.participants.view');
    return this.ports.participants.list(command);
  }

  async replace(command: ReplaceProjectParticipantsCommand) {
    this.requirePermission(command.currentUser, 'projects.participants.manage');
    const before = this.ports.projectP8NotificationsEnabled
      ? await this.ports.participants.list({
          ...command,
          canViewUsers: true,
          canViewEmployees: true,
        })
      : null;
    const response = await this.ports.participants.replace(command);

    if (before && response.changed) {
      await this.notifyParticipantChanges(command, before.participants, internalMemberEvents(response));
    }

    return publicParticipantResponse(response);
  }

  async roles(command: ProjectParticipantRolesCommand) {
    this.requirePermission(command.currentUser, 'projects.view');
    return this.ports.participants.roles(command);
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private async notifyParticipantChanges(
    command: ReplaceProjectParticipantsCommand,
    before: ProjectParticipantDto[],
    persistedEvents: Array<{ eventType: string; participantType: string; participantId: string; roleCode: string }>,
  ): Promise<void> {
    if (!this.ports.notifications) return;

    const beforeByIdentity = new Map(before.map((participant) => [participantIdentity(participant), participant]));
    const afterByIdentity = new Map(command.dto.participants.map((participant) => [inputParticipantIdentity(participant), participant]));
    const fallbackAdded = command.dto.participants
      .filter((participant) => !beforeByIdentity.has(inputParticipantIdentity(participant)))
      .map((participant) => ({
        participantType: participant.participantType,
        participantId: participant.participantId,
        roleCode: participant.roleCode,
      }));
    const fallbackRemoved = before
      .filter((participant) => !afterByIdentity.has(participantIdentity(participant)))
      .flatMap(notificationParticipant);
    const added = persistedEvents.length > 0
      ? persistedEvents.filter((event) => event.eventType === 'PROJECT_MEMBER_ADDED')
      : fallbackAdded;
    const removed = persistedEvents.length > 0
      ? persistedEvents.filter((event) => event.eventType === 'PROJECT_MEMBER_REMOVED')
      : fallbackRemoved;

    if (added.length === 0 && removed.length === 0) return;

    await this.ports.notifications.handleProjectMembersChanged({
      projectId: command.projectId,
      sourceId: command.dto.idempotencyKey,
      actorUserId: command.currentUser.id,
      requestId: command.requestId ?? command.dto.idempotencyKey,
      added,
      removed,
    });
  }
}

function participantIdentity(participant: ProjectParticipantDto): string {
  return `${participant.participantType}:${participant.participantId ?? ''}`;
}

function inputParticipantIdentity(participant: { participantType: string; participantId: string }): string {
  return `${participant.participantType}:${participant.participantId}`;
}

function notificationParticipant(participant: ProjectParticipantDto) {
  if (!participant.participantId) return [];
  return [{
    participantType: participant.participantType,
    participantId: participant.participantId,
    roleCode: participant.role.code,
  }];
}

function internalMemberEvents(response: unknown): Array<{ eventType: string; participantType: string; participantId: string; roleCode: string }> {
  const events = (response as { p8MemberEvents?: unknown }).p8MemberEvents;
  if (!Array.isArray(events)) return [];
  return events.filter(isMemberEvent);
}

function isMemberEvent(value: unknown): value is { eventType: string; participantType: string; participantId: string; roleCode: string } {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.eventType === 'string'
    && typeof event.participantType === 'string'
    && typeof event.participantId === 'string'
    && typeof event.roleCode === 'string';
}

function publicParticipantResponse<T extends object>(response: T): T {
  const { p8MemberEvents: _p8MemberEvents, ...publicResponse } = response as T & { p8MemberEvents?: unknown };
  return publicResponse as T;
}
