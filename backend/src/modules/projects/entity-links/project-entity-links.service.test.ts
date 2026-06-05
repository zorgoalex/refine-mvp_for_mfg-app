import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ProjectEntityLinksService } from './project-entity-links.service';
import type { ProjectEntityLinksRepositoryPort } from './project-entity-links.repository';

describe('ProjectEntityLinksService', () => {
  it('requires projects.view plus entity permission for filtered list', async () => {
    const service = new ProjectEntityLinksService({ links: fakeRepository() });

    await expect(
      service.list({ currentUser: user(['projects.view']), projectId: projectId(), entityType: 'client' }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['clients.view'] },
    });
  });

  it('requires manage_links and every submitted entity permission for writes', async () => {
    const repo = fakeRepository();
    const service = new ProjectEntityLinksService({ links: repo });

    await expect(
      service.replace({
        currentUser: user(['projects.manage_links']),
        projectId: projectId(),
        dto: { idempotencyKey: 'k1', links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }] },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['clients.view'] },
    });

    await expect(
      service.append({
        currentUser: user(['projects.manage_links', 'clients.view']),
        projectId: projectId(),
        dto: { idempotencyKey: 'k1', links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }] },
      }),
    ).resolves.toMatchObject({ projectId: projectId() });
    expect(repo.calls).toEqual(['append']);
  });
});

function fakeRepository(): ProjectEntityLinksRepositoryPort & { calls: string[] } {
  return {
    calls: [],
    async list(command) {
      this.calls.push('list');
      return { projectId: command.projectId, links: [], requestId: 'request-id' };
    },
    async replace(command) {
      this.calls.push('replace');
      return { projectId: command.projectId, links: [], requestId: 'request-id' };
    },
    async append(command) {
      this.calls.push('append');
      return { projectId: command.projectId, links: [], requestId: 'request-id' };
    },
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions };
}

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
