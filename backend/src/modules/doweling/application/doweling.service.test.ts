import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { DowelingService } from './doweling.service';

const user = (role: 'manager' | 'worker'): CurrentUser => ({
  id: '1',
  username: role,
  role,
  roleId: 1,
  permissions: getPermissionsForRole(role),
});

const repo = () =>
  ({
    createDowelingOrder: vi.fn().mockResolvedValue({ dowelingOrder: { dowelingOrderId: 1, dowelingOrderName: 'x', version: 0 }, requestId: 'r' }),
  }) as any;

describe('DowelingService.createDowelingOrder', () => {
  it('allows a user whose role carries doweling.create (manager)', async () => {
    const r = repo();
    await new DowelingService({ doweling: r }).createDowelingOrder({ currentUser: user('manager'), dto: {} as any });
    expect(r.createDowelingOrder).toHaveBeenCalledOnce();
  });

  it('denies a user whose role lacks doweling.create (worker → 403)', async () => {
    const r = repo();
    await expect(
      new DowelingService({ doweling: r }).createDowelingOrder({ currentUser: user('worker'), dto: {} as any }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(r.createDowelingOrder).not.toHaveBeenCalled();
  });
});
