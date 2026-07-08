import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ProjectsService } from './projects.service';

const user = (permissions: readonly PermissionName[]): CurrentUser => ({
  id: '7',
  username: 'tester',
  role: 'manager',
  roleId: 10,
  permissions,
});

const repo = () => ({
  list: vi.fn().mockResolvedValue([]),
  getById: vi.fn(),
  update: vi.fn(),
  moveOrder: vi.fn(),
  merge: vi.fn(),
});

describe('ProjectsService', () => {
  it('list requires projects.view', async () => {
    const projects = repo();
    const svc = new ProjectsService({
      projects,
      permissions: { canUser: () => false } as never,
    });

    await expect(svc.list({ currentUser: user([]), query: {} })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(projects.list).not.toHaveBeenCalled();
  });

  it('update requires projects.manage and delegates', async () => {
    const projects = repo();
    projects.update.mockResolvedValue({
      projectId: 1,
      code: 'ФК26',
      name: 'Кухня',
      clientId: 2,
      notes: null,
      version: 1,
    });
    const svc = new ProjectsService({
      projects,
      permissions: {
        canUser: (_user: CurrentUser, permission: string) =>
          permission === 'projects.manage' || permission === 'projects.view',
      } as never,
    });

    const result = await svc.update({
      currentUser: user(['projects.manage']),
      projectId: 1,
      dto: { code: 'ФК26' },
      expectedVersion: 0,
      requestId: 'r1',
    });

    expect(result.code).toBe('ФК26');
    expect(projects.update).toHaveBeenCalledOnce();
  });

  it('moveOrder and merge require BOTH projects.manage and orders.update', async () => {
    const projects = repo();
    // projects.manage alone is not enough — move/merge rewrite orders rows.
    const svc = new ProjectsService({
      projects,
      permissions: {
        canUser: (_user: CurrentUser, permission: string) => permission !== 'orders.update',
      } as never,
    });

    await expect(
      svc.moveOrder({
        currentUser: user(['projects.manage']),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'k1234567',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(projects.moveOrder).not.toHaveBeenCalled();

    await expect(
      svc.merge({
        currentUser: user(['projects.manage']),
        targetProjectId: 200,
        sourceProjectId: 100,
        idempotencyKey: 'k1234567',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(projects.merge).not.toHaveBeenCalled();
  });

  it('moveOrder delegates when both permissions present', async () => {
    const projects = repo();
    projects.moveOrder.mockResolvedValue({ orderId: 10, projectId: 200 });
    const svc = new ProjectsService({
      projects,
      permissions: { canUser: () => true } as never,
    });

    await svc.moveOrder({
      currentUser: user(['projects.manage', 'orders.update']),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'k1234567',
      requestId: 'r1',
    });
    expect(projects.moveOrder).toHaveBeenCalledOnce();
  });
});
