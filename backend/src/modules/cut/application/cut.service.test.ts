import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { CutService } from './cut.service';
import type { CutRepositoryPort } from './cut-command.types';

function user(permissions: PermissionName[]): CurrentUser {
  return {
    id: '7',
    username: 'u',
    role: 'operator',
    roleId: 6,
    permissions,
  };
}

function repo(overrides: Partial<CutRepositoryPort> = {}): CutRepositoryPort {
  const reject = () => Promise.reject(new Error('not implemented'));
  return {
    recordPermissionDenied: () => Promise.resolve(),
    createJob: reject,
    addItems: reject,
    removeItem: reject,
    calculate: reject,
    archive: reject,
    getJob: reject,
    listJobs: reject,
    listEligibleDetails: reject,
    renderSheetPng: reject,
    ...overrides,
  } as CutRepositoryPort;
}

describe('CutService RBAC (§8 principle 8)', () => {
  it('denies create without cut.manage', async () => {
    const service = new CutService({ cut: repo() });
    await expect(
      service.createJob({ currentUser: user(['cut.view']), dto: { name: 'Тест' } }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows create with cut.manage and delegates', async () => {
    const createJob = vi.fn(async () => ({ cutJobId: 1 }) as never);
    const service = new CutService({ cut: repo({ createJob }) });
    await service.createJob({ currentUser: user(['cut.manage']), dto: { name: 'Тест' } });
    expect(createJob).toHaveBeenCalledOnce();
  });

  it('records an audited RBAC denial (carrying the entity + required permission)', async () => {
    const recordPermissionDenied = vi.fn(async () => undefined);
    const service = new CutService({ cut: repo({ recordPermissionDenied }) });
    await expect(
      service.calculate({ currentUser: user(['cut.view']), cutJobId: 42, version: 0, requestId: 'rq' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // fire-and-forget — allow the microtask to run
    await Promise.resolve();
    expect(recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ cutJobId: 42, requiredPermissions: ['cut.manage'], requestId: 'rq' }),
    );
  });

  it('denies eligible-details read without cut.view', async () => {
    const service = new CutService({ cut: repo() });
    await expect(
      service.listEligibleDetails({ currentUser: user([]), criteria: {} }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows eligible-details read with cut.view and delegates', async () => {
    const listEligibleDetails = vi.fn(async () => ({ details: [], noSheetSpecCount: 0 }));
    const service = new CutService({ cut: repo({ listEligibleDetails }) });
    await service.listEligibleDetails({ currentUser: user(['cut.view']), criteria: {} });
    expect(listEligibleDetails).toHaveBeenCalledOnce();
  });

  it('requires cut.manage for calculate/addItems/removeItem/archive', async () => {
    const service = new CutService({ cut: repo() });
    const viewer = user(['cut.view']);
    await expect(
      service.addItems({ currentUser: viewer, cutJobId: 1, version: 0, dto: { detailIds: [1] } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.calculate({ currentUser: viewer, cutJobId: 1, version: 0 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.removeItem({ currentUser: viewer, cutJobId: 1, cutJobItemId: 2, version: 0 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.archive({ currentUser: viewer, cutJobId: 1, version: 0 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws a 403 ApiError carrying the required permission', async () => {
    const service = new CutService({ cut: repo() });
    try {
      await service.getJob({ currentUser: user([]), cutJobId: 1 });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).details).toMatchObject({ requiredPermissions: ['cut.view'] });
    }
  });
});
