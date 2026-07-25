import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgDeadlineDefaultScheduleRepository } from './pg-deadline-default-schedule-repository';

describe('PgDeadlineDefaultScheduleRepository', () => {
  it('loads order transitions from the active workflow setting', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [configRow()] })
      .mockResolvedValueOnce({
        rows: [
          {
            is_active: true,
            value_json: {
              transitions_order: {
                drawn: ['cut'],
              },
            },
          },
        ],
      });
    const repository = new PgDeadlineDefaultScheduleRepository({
      query,
    } as unknown as DatabaseService);

    const schedule = await repository.getSchedule();

    expect(schedule.transitionsOrder).toEqual({ drawn: ['cut'] });
    expect(schedule.totalProductionDays).toBe(5);
    expect(
      schedule.stages.map((stage) => stage.cumulativeDeadlineDays),
    ).toEqual([2, 5]);
  });

  it('does not use transitions from an inactive workflow setting', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [configRow()] })
      .mockResolvedValueOnce({
        rows: [
          {
            is_active: false,
            value_json: {
              value: {
                transitions_order: {
                  drawn: ['cut'],
                },
              },
            },
          },
        ],
      });
    const repository = new PgDeadlineDefaultScheduleRepository({
      query,
    } as unknown as DatabaseService);

    const schedule = await repository.getSchedule();

    expect(schedule.transitionsOrder).toEqual({});
    expect(schedule.totalProductionDays).toBe(3);
  });
});

function configRow() {
  return {
    reserve_days: 0,
    version: 1,
    updated_at: null,
    configured_row_count: 2,
    active_status_count: 2,
    active_configured_count: 2,
    stages: [
      {
        productionStatusId: 1,
        productionStatusName: 'Отрисован',
        productionStatusCode: 'drawn',
        sortOrder: 1,
        durationDays: 2,
        parallelWithPrevious: false,
      },
      {
        productionStatusId: 2,
        productionStatusName: 'Распилен',
        productionStatusCode: 'cut',
        sortOrder: 2,
        durationDays: 3,
        parallelWithPrevious: false,
      },
    ],
  };
}
