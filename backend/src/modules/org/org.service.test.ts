import { describe, expect, it, vi } from 'vitest';
import { OrgService } from './org.service';

const admin = { id: '3', username: 'admin', role: 'admin', roleId: 1, permissions: ['org.view', 'org.manage'] } as any;
const viewer = { id: '4', username: 'v', role: 'top_manager', roleId: 15, permissions: ['org.view'] } as any;

function build() {
  const repo = {
    listDirections: vi.fn().mockResolvedValue([]),
    createDirection: vi.fn().mockResolvedValue({ directionId: 1 }),
    replaceDirectionHeads: vi.fn().mockResolvedValue({ directionId: 1 }),
  } as any;
  return { repo, service: new OrgService({ repository: repo }) };
}

describe('OrgService RBAC', () => {
  it('allows org.view to list directions', async () => {
    const { service, repo } = build();
    await service.listDirections({ currentUser: viewer });
    expect(repo.listDirections).toHaveBeenCalled();
  });

  it('denies a viewer from creating a direction', async () => {
    const { service } = build();
    await expect(
      service.createDirection({ currentUser: viewer, name: 'X', description: null, isActive: true }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('allows org.manage to replace heads', async () => {
    const { service, repo } = build();
    await service.replaceDirectionHeads({
      currentUser: admin,
      directionId: 1,
      idempotencyKey: 'k',
      ids: [10],
      reason: null,
    });
    expect(repo.replaceDirectionHeads).toHaveBeenCalled();
  });
});
