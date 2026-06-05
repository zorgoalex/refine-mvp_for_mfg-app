import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ProjectParticipantsService } from './project-participants.service';
import type { ProjectParticipantsRepositoryPort } from './project-participants.repository';

describe('ProjectParticipantsService', () => {
  it('does not accept legacy member permissions for typed participant list or replace', async () => {
    const service = new ProjectParticipantsService({ participants: fakeRepository() });

    await expect(
      service.list({
        currentUser: user(['projects.members.view']),
        projectId: projectId(),
        canViewUsers: true,
        canViewEmployees: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions: ['projects.participants.view'] },
    });

    await expect(
      service.replace({
        currentUser: user(['projects.members.manage']),
        projectId: projectId(),
        dto: { idempotencyKey: 'k1', participants: [] },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions: ['projects.participants.manage'] },
    });
  });

  it('delegates roles through projects.view and replace through participant manage', async () => {
    const repo = fakeRepository();
    const service = new ProjectParticipantsService({ participants: repo });

    await expect(service.roles({ currentUser: user(['projects.view']) })).resolves.toMatchObject({ roles: [] });
    await expect(
      service.replace({
        currentUser: user(['projects.participants.manage']),
        projectId: projectId(),
        dto: { idempotencyKey: 'k1', participants: [] },
      }),
    ).resolves.toMatchObject({ projectId: projectId() });
    expect(repo.calls).toEqual(['roles', 'replace']);
  });

  it('notifies P8 member facts after a changed replace when gate is enabled', async () => {
    const repo = fakeRepository({
      before: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
      after: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
    });
    const notifications = fakeNotifications();
    const service = new ProjectParticipantsService({
      participants: repo,
      notifications,
      projectP8NotificationsEnabled: true,
    });

    await service.replace({
      currentUser: user(['projects.participants.manage']),
      projectId: projectId(),
      dto: {
        idempotencyKey: 'participants-command-1',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'observer', metadata: {} }],
      },
      requestId: 'request-1',
    });

    expect(notifications.memberCalls).toEqual([{
      projectId: projectId(),
      sourceId: 'participants-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      added: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
      removed: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    }]);
  });

  it('does not notify member facts when P8 gate is disabled', async () => {
    const notifications = fakeNotifications();
    const service = new ProjectParticipantsService({
      participants: fakeRepository({
        before: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
        after: [],
      }),
      notifications,
      projectP8NotificationsEnabled: false,
    });

    await service.replace({
      currentUser: user(['projects.participants.manage']),
      projectId: projectId(),
      dto: { idempotencyKey: 'k1', participants: [] },
    });

    expect(notifications.memberCalls).toEqual([]);
  });

  it('uses persisted member events from an idempotent response and strips them from public output', async () => {
    const notifications = fakeNotifications();
    const service = new ProjectParticipantsService({
      participants: fakeRepository({
        before: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
        after: [{ participantType: 'employee', participantId: '77', roleCode: 'observer' }],
        p8MemberEvents: [{
          eventType: 'PROJECT_MEMBER_ADDED',
          participantType: 'employee',
          participantId: '77',
          roleCode: 'observer',
        }],
      }),
      notifications,
      projectP8NotificationsEnabled: true,
    });

    const response = await service.replace({
      currentUser: user(['projects.participants.manage']),
      projectId: projectId(),
      dto: {
        idempotencyKey: 'participants-command-1',
        participants: [{ participantType: 'employee', participantId: '77', roleCode: 'observer', metadata: {} }],
      },
      requestId: 'request-1',
    });

    expect(notifications.memberCalls).toEqual([{
      projectId: projectId(),
      sourceId: 'participants-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      added: [{ eventType: 'PROJECT_MEMBER_ADDED', participantType: 'employee', participantId: '77', roleCode: 'observer' }],
      removed: [],
    }]);
    expect(response).not.toHaveProperty('p8MemberEvents');
  });
});

function fakeRepository(input: {
  before?: Array<{ participantType: 'user' | 'employee'; participantId: string; roleCode: string }>;
  after?: Array<{ participantType: 'user' | 'employee'; participantId: string; roleCode: string }>;
  p8MemberEvents?: Array<{ eventType: string; participantType: string; participantId: string; roleCode: string }>;
} = {}): ProjectParticipantsRepositoryPort & { calls: string[] } {
  return {
    calls: [],
    async list(command) {
      this.calls.push('list');
      return {
        projectId: command.projectId,
        participants: (input.before ?? []).map(participantDto),
        requestId: 'request-id',
      };
    },
    async replace(command) {
      this.calls.push('replace');
      return {
        projectId: command.projectId,
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
    async handleProjectMembersChanged(input: unknown) {
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

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
