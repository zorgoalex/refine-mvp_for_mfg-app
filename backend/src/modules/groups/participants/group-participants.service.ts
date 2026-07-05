import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { GroupNotificationService } from '../notifications/group-notification.service';
import type { GroupParticipantDto } from './group-participants.dto';
import type {
  ListGroupParticipantsCommand,
  GroupParticipantRolesCommand,
  GroupParticipantsRepositoryPort,
  ReplaceGroupParticipantsCommand,
} from './group-participants.repository';

export interface GroupParticipantsPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface GroupParticipantsServicePorts {
  participants: GroupParticipantsRepositoryPort;
  permissions?: GroupParticipantsPermissionsPort;
  notifications?: GroupNotificationService;
  groupP8NotificationsEnabled?: boolean;
}

export class GroupParticipantsService {
  private readonly permissions: GroupParticipantsPermissionsPort;

  constructor(private readonly ports: GroupParticipantsServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListGroupParticipantsCommand) {
    this.requirePermission(command.currentUser, 'groups.participants.view');
    return this.ports.participants.list(command);
  }

  async replace(command: ReplaceGroupParticipantsCommand) {
    this.requirePermission(command.currentUser, 'groups.participants.manage');
    const before = this.ports.groupP8NotificationsEnabled
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

  async roles(command: GroupParticipantRolesCommand) {
    this.requirePermission(command.currentUser, 'groups.view');
    return this.ports.participants.roles(command);
  }

  private requirePermission(currentUser: CurrentUser, permission: string): void {
    const typedPermission = permission as PermissionName;
    if (!this.permissions.canUser(currentUser, typedPermission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private async notifyParticipantChanges(
    command: ReplaceGroupParticipantsCommand,
    before: GroupParticipantDto[],
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
      ? persistedEvents.filter((event) => event.eventType === 'GROUP_MEMBER_ADDED')
      : fallbackAdded;
    const removed = persistedEvents.length > 0
      ? persistedEvents.filter((event) => event.eventType === 'GROUP_MEMBER_REMOVED')
      : fallbackRemoved;

    if (added.length === 0 && removed.length === 0) return;

    await this.ports.notifications.handleGroupMembersChanged({
      groupId: command.groupId,
      sourceId: command.dto.idempotencyKey,
      actorUserId: command.currentUser.id,
      requestId: command.requestId ?? command.dto.idempotencyKey,
      added,
      removed,
    });
  }
}

function participantIdentity(participant: GroupParticipantDto): string {
  return `${participant.participantType}:${participant.participantId ?? ''}`;
}

function inputParticipantIdentity(participant: { participantType: string; participantId: string }): string {
  return `${participant.participantType}:${participant.participantId}`;
}

function notificationParticipant(participant: GroupParticipantDto) {
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
