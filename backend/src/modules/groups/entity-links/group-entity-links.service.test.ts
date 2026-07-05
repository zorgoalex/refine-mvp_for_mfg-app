import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { GroupEntityLinksService } from './group-entity-links.service';
import type { GroupEntityLinksRepositoryPort } from './group-entity-links.repository';

describe('GroupEntityLinksService', () => {
  it('requires groups.view plus entity permission for filtered list', async () => {
    const service = new GroupEntityLinksService({ links: fakeRepository() });

    await expect(
      service.list({ currentUser: user(['groups.view']), groupId: groupId(), entityType: 'client' }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['clients.view'] },
    });
  });

  it('requires manage_links and every submitted entity permission for writes', async () => {
    const repo = fakeRepository();
    const service = new GroupEntityLinksService({ links: repo });

    await expect(
      service.replace({
        currentUser: user(['groups.manage_links']),
        groupId: groupId(),
        dto: { idempotencyKey: 'k1', links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }] },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['clients.view'] },
    });

    await expect(
      service.append({
        currentUser: user(['groups.manage_links', 'clients.view']),
        groupId: groupId(),
        dto: { idempotencyKey: 'k1', links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }] },
      }),
    ).resolves.toMatchObject({ groupId: groupId() });
    expect(repo.calls).toEqual(['append']);
  });
});

function fakeRepository(): GroupEntityLinksRepositoryPort & { calls: string[] } {
  return {
    calls: [],
    async list(command) {
      this.calls.push('list');
      return { groupId: command.groupId, links: [], requestId: 'request-id' };
    },
    async replace(command) {
      this.calls.push('replace');
      return { groupId: command.groupId, links: [], requestId: 'request-id' };
    },
    async append(command) {
      this.calls.push('append');
      return { groupId: command.groupId, links: [], requestId: 'request-id' };
    },
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions };
}

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
