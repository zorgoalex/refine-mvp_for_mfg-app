import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { DeadlineDefaultScheduleDto } from '../dto/deadline-default-schedule.dto';
import { DeadlineDefaultScheduleService } from './deadline-default-schedule.service';

const schedule: DeadlineDefaultScheduleDto = {
  configured: true,
  hasStoredConfiguration: true,
  version: 2,
  reserveDays: 1,
  totalProductionDays: 5,
  plannedOrderDays: 6,
  updatedAt: null,
  stages: [],
};

describe('DeadlineDefaultScheduleService', () => {
  it('allows deadline viewers to read defaults', async () => {
    const getSchedule = vi.fn().mockResolvedValue(schedule);
    const service = new DeadlineDefaultScheduleService({
      getSchedule,
      replaceSchedule: vi.fn(),
    });

    await expect(service.get({ currentUser: user(['deadlines.view']) })).resolves.toEqual(schedule);
    expect(getSchedule).toHaveBeenCalledOnce();
  });

  it('allows settings managers and rejects order creators without deadline access', async () => {
    const service = new DeadlineDefaultScheduleService({
      getSchedule: vi.fn().mockResolvedValue(schedule),
      replaceSchedule: vi.fn(),
    });

    await expect(service.get({ currentUser: user(['settings.manage']) })).resolves.toEqual(schedule);
    await expect(service.get({ currentUser: user(['orders.create']) })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('requires settings.manage to replace defaults', async () => {
    const service = new DeadlineDefaultScheduleService({
      getSchedule: vi.fn(),
      replaceSchedule: vi.fn(),
    });

    await expect(
      service.replace({
        currentUser: user(['settings.view']),
        dto: {
          expectedVersion: 1,
          reserveDays: 0,
          reason: 'test reason',
          stages: [
            {
              productionStatusId: 1,
              durationDays: 1,
              parallelWithPrevious: false,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });
});

function user(permissions: CurrentUser['permissions']): CurrentUser {
  return {
    id: '3',
    username: 'tester',
    role: 'admin',
    roleId: 1,
    permissions,
  };
}
