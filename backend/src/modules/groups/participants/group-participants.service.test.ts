import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { GroupParticipantsService } from './group-participants.service';
import type { GroupParticipantsRepositoryPort } from './group-participants.repository';

describe('GroupParticipantsService', () => {
  it('does not accept legacy member permissions for typed participant list or replace', async () => {
    const service = new GroupParticipantsService({ participants: fakeRepository() });

    await expect(
      service.list({
        currentUser: user(['groups.members.view']),
        groupId: groupId(),
        canViewUsers: true,
        canViewEmployees: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions: ['groups.participants.view'] },
    });

    await expect(
      service.replace({
        currentUser: user(['groups.members.manage']),
        groupId: groupId(),
        dto: { idempotencyKey: 'k1', participants: [] },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions: ['groups.participants.manage'] },
    });
  });

  it('delegates roles through groups.view and replace through participant manage', async () => {
    const repo = fakeRepository();
    const service = new GroupParticipantsService({ participants: repo });

    await expect(service.roles({ currentUser: user(['groups.view']) })).resolves.toMatchObject({ roles: [] });
    await expect(
      service.replace({
        currentUser: user(['groups.participants.manage']),
        groupId: groupId(),
        dto: { idempotencyKey: 'k1', participants: [] },
      }),
    ).resolves.toMatchObject({ groupId: groupId() });
    expect(repo.calls).toEqual(['roles', 'replace']);
  });

  it('notifies P8 member facts after a changed replace when gate is enabled', async () => {
    const repo = fakeRepository({
      before: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
      after: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
    });
    const notifications = fakeNotifications();
    const service = new GroupParticipantsService({
      participants: repo,
      notifications,
      groupP8NotificationsEnabled: true,
    });

    await service.replace({
      currentUser: user(['groups.participants.manage']),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'participants-command-1',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'observer', metadata: {} }],
      },
      requestId: 'request-1',
    });

    expect(notifications.memberCalls).toEqual([{
      groupId: groupId(),
      sourceId: 'participants-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      added: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
      removed: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    }]);
  });

  it('does not notify member facts when P8 gate is disabled', async () => {
    const notifications = fakeNotifications();
    const service = new GroupParticipantsService({
      participants: fakeRepository({
        before: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
        after: [],
      }),
      notifications,
      groupP8NotificationsEnabled: false,
    });

    await service.replace({
      currentUser: user(['groups.participants.manage']),
      groupId: groupId(),
      dto: { idempotencyKey: 'k1', participants: [] },
    });

    expect(notifications.memberCalls).toEqual([]);
  });

  it('uses persisted member events from an idempotent response and strips them from public output', async () => {
    const notifications = fakeNotifications();
    const service = new GroupParticipantsService({
      participants: fakeRepository({
        before: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
        after: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
        p8MemberEvents: [{
          eventType: 'GROUP_MEMBER_ADDED',
          participantType: 'employee',
          participantId: '77',
          roleCode: 'observer',
        }],
      }),
      notifications,
      groupP8NotificationsEnabled: true,
    });

    const response = await service.replace({
      currentUser: user(['groups.participants.manage']),
      groupId: groupId(),
      dto: {
        idempotencyKey: 'participants-command-1',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'observer', metadata: {} }],
      },
      requestId: 'request-1',
    });

    expect(notifications.memberCalls).toEqual([{
      groupId: groupId(),
      sourceId: 'participants-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      added: [{ eventType: 'GROUP_MEMBER_ADDED', participantType: 'employee', participantId: '77', roleCode: 'observer' }],
      removed: [],
    }]);
    expect(response).not.toHaveProperty('p8MemberEvents');
  });
});

function fakeRepository(input: {
  before?: Array<{ participantType: 'user' | 'employee'; participantId: string; roleCode: string }>;
  after?: Array<{ participantType: 'user' | 'employee'; participantId: string; roleCode: string }>;
  p8MemberEvents?: Array<{ eventType: string; participantType: string; participantId: string; roleCode: string }>;
} = {}): GroupParticipantsRepositoryPort & { calls: string[] } {
  return {
    calls: [],
    async list(command) {
      this.calls.push('list');
      return {
        groupId: command.groupId,
        participants: (input.before ?? []).map(participantDto),
        requestId: 'request-id',
      };
    },
    async replace(command) {
      this.calls.push('replace');
      return {
        groupId: command.groupId,
        participants: (input.after ?? []).map(participantDto),
        requestId: 'request-id',
        changed: true,
        ...(input.p8MemberEvents ? { p8MemberEvents: input.p8MemberEvents } : {}),
      };
    },
    async roles(command) {
      this.calls.push('roles');
      return { roles: [], requestId: command.requestId ?? 'request-id' };
    },
  };
}

function fakeNotifications() {
  return {
    memberCalls: [] as unknown[],
    async handleGroupMembersChanged(input: unknown) {
      this.memberCalls.push(input);
      return [];
    },
  } as never;
}

function participantDto(input: { participantType: 'user' | 'employee'; participantId: string; roleCode: string }) {
  return {
    id: `${input.participantType}-${input.participantId}`,
    participantType: input.participantType,
    participantId: input.participantId,
    displayName: null,
    role: { code: input.roleCode, label: input.roleCode },
    validFrom: '2026-06-05T00:00:00.000Z',
    validTo: null,
    metadata: {},
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions };
}

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
