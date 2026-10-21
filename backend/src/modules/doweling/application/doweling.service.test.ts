import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { DowelingService } from './doweling.service';

const user = (role: 'manager' | 'worker' | 'operator'): CurrentUser => ({
  id: '1',
  username: role,
  role,
  roleId: 1,
  permissions: getPermissionsForRole(role),
});
const money = { paymentStatusId: 1, paymentDate: null, totalAmount: 100, finalAmount: 100, discount: 0, surcharge: 0, paidAmount: 0 };

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

describe('DowelingService.updateDowelingOrder', () => {
  const updateRepo = () => ({ ...repo(), updateDowelingOrder: vi.fn().mockResolvedValue({ changed: true }) }) as any;

  it('requires doweling.update before the repository is reached', async () => {
    const r = updateRepo();
    await expect(
      new DowelingService({ doweling: r }).updateDowelingOrder({ currentUser: user('worker'), dowelingOrderId: 1, dto: {} as any }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED', details: { requiredPermissions: ['doweling.update'] } });
    expect(r.updateDowelingOrder).not.toHaveBeenCalled();
  });

  it('passes a manager (doweling.update) to the repository, which checks the order scope', async () => {
    const r = updateRepo();
    await new DowelingService({ doweling: r }).updateDowelingOrder({ currentUser: user('manager'), dowelingOrderId: 1, dto: {} as any });
    expect(r.updateDowelingOrder).toHaveBeenCalledOnce();
  });
});

describe('DowelingService: the money right is checked by the repository (audited refusal)', () => {
  it('passes money from a user without orders.view_financials on to the repository, which refuses and audits', async () => {
    const r = { ...repo(), updateDowelingOrder: vi.fn().mockResolvedValue({ changed: true }) } as any;
    await new DowelingService({ doweling: r }).updateDowelingOrder({ currentUser: user('operator'), dowelingOrderId: 1, dto: { ...money } as any });
    expect(r.updateDowelingOrder).toHaveBeenCalledOnce();
  });
});
