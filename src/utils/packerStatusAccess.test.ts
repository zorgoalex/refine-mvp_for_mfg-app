import { describe, expect, it } from 'vitest';
import {
  filterOrderStatusesForPacker,
  isPackerAllowedOrderStatusName,
  isPackerUser,
} from './packerStatusAccess';

describe('packerStatusAccess', () => {
  it('recognizes packer by canonical role or role id', () => {
    expect(isPackerUser({ role: 'packer' })).toBe(true);
    expect(isPackerUser({ role_id: 30 })).toBe(true);
    expect(isPackerUser({ roleId: '30' })).toBe(true);
    expect(isPackerUser({ role: 'worker', role_id: 20 })).toBe(false);
  });

  it('allows only issue-ready order status names for packer', () => {
    expect(isPackerAllowedOrderStatusName('Готов к выдаче')).toBe(true);
    expect(isPackerAllowedOrderStatusName('  выдан  ')).toBe(true);
    expect(isPackerAllowedOrderStatusName('В производстве')).toBe(false);

    const statuses = [
      { id: 4, name: 'В производстве' },
      { id: 6, name: 'Готов к выдаче' },
      { id: 7, name: 'Выдан' },
    ];

    expect(filterOrderStatusesForPacker(statuses, { role: 'packer' }).map((status) => status.id))
      .toEqual([6, 7]);
    expect(filterOrderStatusesForPacker(statuses, { role: 'manager' }).map((status) => status.id))
      .toEqual([4, 6, 7]);
  });
});
