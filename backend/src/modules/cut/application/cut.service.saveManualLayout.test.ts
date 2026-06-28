/**
 * Task 5: CutService.saveManualLayout — RBAC + delegation tests.
 *
 * Service is a thin permission gate; ALL business logic lives in the repo.
 * The critical design difference from other service methods:
 *   - Uses explicit `permissions.canUser` NOT the private `require()`.
 *   - On denial: AWAITS `recordPermissionDenied` (with cutGroupId/metadata for
 *     bridge rows) before throwing 403 — NOT fire-and-forget.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { CutService } from './cut.service';
import type { CutRepositoryPort, SaveManualLayoutCommand } from './cut-command.types';

function user(permissions: PermissionName[]): CurrentUser {
  return {
    id: '7',
    username: 'u',
    role: 'operator',
    roleId: 6,
    permissions,
  };
}

const viewerOnly = user(['cut.view']);
const manager = user(['cut.manage', 'cut.view']);

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
    listDetailLastReady: () => Promise.resolve({ details: [] }),
    saveManualLayout: reject,
    ...overrides,
  } as CutRepositoryPort;
}

const validArgs: Omit<SaveManualLayoutCommand, 'currentUser'> = {
  cutJobId: 10,
  cutGroupId: 5,
  jobVersion: 3,
  placements: [{ itemId: 'det-1', instance: 1, sheetIndex: 0, xMm: 0, yMm: 0, rotated: false }],
  active: true,
  requestId: 'req-1',
};

describe('CutService.saveManualLayout (Task 5)', () => {
  it('rejects when caller lacks cut.manage — throws 403, does NOT call repo.saveManualLayout', async () => {
    const saveManualLayout = vi.fn(async () => ({ cutJobId: 10 }) as never);
    const service = new CutService({ cut: repo({ saveManualLayout }) });
    await expect(
      service.saveManualLayout({ currentUser: viewerOnly, ...validArgs }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(saveManualLayout).not.toHaveBeenCalled();
  });

  it('delegates to repo.saveManualLayout when caller has cut.manage', async () => {
    const saveManualLayout = vi.fn(async () => ({ cutJobId: 10, version: 4 }) as never);
    const service = new CutService({ cut: repo({ saveManualLayout }) });
    await service.saveManualLayout({ currentUser: manager, ...validArgs });
    expect(saveManualLayout).toHaveBeenCalledWith(
      expect.objectContaining({ cutJobId: 10, cutGroupId: 5, placements: validArgs.placements }),
    );
  });

  it('calls recordPermissionDenied with cutGroupId + metadata action before throwing 403', async () => {
    const recordPermissionDenied = vi.fn(async () => undefined);
    const service = new CutService({ cut: repo({ recordPermissionDenied }) });
    await expect(
      service.saveManualLayout({ currentUser: viewerOnly, ...validArgs }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // Allow microtasks (catch-swallowed promise) to settle
    await Promise.resolve();
    expect(recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        cutJobId: 10,
        cutGroupId: 5,
        requiredPermissions: ['cut.manage'],
        requestId: 'req-1',
        metadata: expect.objectContaining({ action: 'manual_layout_save' }),
      }),
    );
  });

  it('throws a 403 ApiError with PERMISSION_DENIED code and requiredPermissions detail', async () => {
    const service = new CutService({ cut: repo() });
    try {
      await service.saveManualLayout({ currentUser: viewerOnly, ...validArgs });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(403);
      expect(apiErr.code).toBe('PERMISSION_DENIED');
      expect(apiErr.details).toMatchObject({ requiredPermissions: ['cut.manage'] });
    }
  });

  it('does NOT call repo.saveManualLayout if permission check fails', async () => {
    const saveManualLayout = vi.fn(async () => ({ cutJobId: 10 }) as never);
    const service = new CutService({ cut: repo({ saveManualLayout }) });
    await expect(
      service.saveManualLayout({ currentUser: viewerOnly, ...validArgs }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(saveManualLayout).not.toHaveBeenCalled();
  });
});
