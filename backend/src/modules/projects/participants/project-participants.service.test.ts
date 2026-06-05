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
});

function fakeRepository(): ProjectParticipantsRepositoryPort & { calls: string[] } {
  return {
    calls: [],
    async list(command) {
      this.calls.push('list');
      return { projectId: command.projectId, participants: [], requestId: 'request-id' };
    },
    async replace(command) {
      this.calls.push('replace');
      return { projectId: command.projectId, participants: [], requestId: 'request-id' };
    },
    async roles(command) {
      this.calls.push('roles');
      return { roles: [], requestId: command.requestId ?? 'request-id' };
    },
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions };
}

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
