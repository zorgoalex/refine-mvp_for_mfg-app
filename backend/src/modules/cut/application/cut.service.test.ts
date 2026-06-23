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

  // Variant B Task 11: cut.view-gated sheet-type lookup for the /cut filter.
  it('denies listSheetTypesForCut without cut.view (worker-without-cut scenario)', async () => {
    const service = new CutService({ cut: repo() });
    await expect(
      service.listSheetTypesForCut({ currentUser: user([]) }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows listSheetTypesForCut with cut.view only (worker has cut.view, not sheet_materials.view)', async () => {
    const sheetTypes = [
      { sheetMaterialTypeId: 1, name: 'МДФ 18мм', widthMm: 2800, heightMm: 2070, isCuttable: true },
    ];
    const listSheetTypesForCut = vi.fn(async () => sheetTypes);
    const service = new CutService({ cut: repo({ listSheetTypesForCut }) });
    const result = await service.listSheetTypesForCut({ currentUser: user(['cut.view']), requestId: 'rq' });
    expect(result).toEqual(sheetTypes);
    expect(listSheetTypesForCut).toHaveBeenCalledOnce();
  });

  it('denies listSheetTypesForCut for roles with sheet_materials.view but no cut.view (viewer has sheet_materials.view)', async () => {
    // viewer has sheet_materials.view but also cut.view per ROLE_PERMISSIONS — this test
    // verifies the service gates on cut.view specifically, not sheet_materials.view.
    // So we simulate a hypothetical role that has sheet_materials.view but not cut.view.
    const service = new CutService({ cut: repo() });
    await expect(
      service.listSheetTypesForCut({ currentUser: user(['sheet_materials.view']) }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('setProfile requires cut.manage and delegates to the repo', async () => {
    const setProfile = vi.fn(async () => ({ cutJobId: 42 }) as never);
    const service = new CutService({ cut: repo({ setProfile }) });
    await service.setProfile({ currentUser: user(['cut.manage']), cutJobId: 42, paramProfileId: 5, version: 1 });
    expect(setProfile).toHaveBeenCalledWith(expect.objectContaining({ cutJobId: 42, paramProfileId: 5 }));
  });

  it('setProfile denies a user without cut.manage (403 + denied audit, no repo call)', async () => {
    const setProfile = vi.fn(async () => ({ cutJobId: 42 }) as never);
    const recordPermissionDenied = vi.fn(async () => undefined);
    const service = new CutService({ cut: repo({ setProfile, recordPermissionDenied }) });
    await expect(service.setProfile({ currentUser: user(['cut.view']), cutJobId: 42, paramProfileId: 5, version: 1 }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(setProfile).not.toHaveBeenCalled();
    // fire-and-forget — allow the microtask to run
    await Promise.resolve();
    expect(recordPermissionDenied).toHaveBeenCalled();
  });
});
