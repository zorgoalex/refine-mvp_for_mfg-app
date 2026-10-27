import { describe, expect, it } from 'vitest';
import { buildOrderProductionFlow } from './orderProductionFlow';

const statuses = [
  { production_status_id: 3, production_status_name: 'Распилен', sort_order: 30, is_active: true },
  { production_status_id: 1, production_status_name: 'Новый', sort_order: 10, is_active: true },
  { production_status_id: 2, production_status_name: 'Отрисован', sort_order: 20, is_active: true },
  { production_status_id: 9, production_status_name: 'Старый этап', sort_order: 15, is_active: false },
];

describe('buildOrderProductionFlow', () => {
  it('counts positions and pieces per current stage in workflow order', () => {
    const flow = buildOrderProductionFlow([
      { production_status_id: 3, quantity: 2 },
      { production_status_id: 1, quantity: '3' },
      { production_status_id: 3, quantity: 1 },
      { production_status_id: 1, quantity: 5, delete_flag: true },
    ], statuses);

    expect(flow.totalPositions).toBe(3);
    expect(flow.totalQuantity).toBe(6);
    expect(flow.stages.map((stage) => [stage.name, stage.positions, stage.quantity])).toEqual([
      ['Новый', 1, 3],
      ['Отрисован', 0, 0],
      ['Распилен', 2, 3],
    ]);
    expect(flow.stages[2].share).toBeCloseTo(2 / 3);
  });

  it('keeps every active stage visible for an order without details', () => {
    const flow = buildOrderProductionFlow([], statuses);

    expect(flow.totalPositions).toBe(0);
    expect(flow.stages.map((stage) => stage.name)).toEqual(['Новый', 'Отрисован', 'Распилен']);
    expect(flow.stages.every((stage) => stage.share === 0)).toBe(true);
  });

  it('never hides details: unassigned, inactive and unknown stages are listed', () => {
    const flow = buildOrderProductionFlow([
      { production_status_id: null, quantity: 4 },
      { production_status_id: 9, quantity: 1 },
      { production_status_id: 77, production_status_name: 'Новый этап из БД', quantity: 2 },
      { production_status_id: 78, quantity: 'x' },
    ], statuses);

    expect(flow.stages.map((stage) => [stage.key, stage.name, stage.positions, stage.quantity])).toEqual([
      ['unassigned', 'Не назначен', 1, 4],
      ['1', 'Новый', 0, 0],
      ['9', 'Старый этап', 1, 1],
      ['2', 'Отрисован', 0, 0],
      ['3', 'Распилен', 0, 0],
      ['77', 'Новый этап из БД', 1, 2],
      ['78', 'Этап №78', 1, 0],
    ]);
    expect(flow.stages.reduce((sum, stage) => sum + stage.positions, 0)).toBe(flow.totalPositions);
  });

  it('works without the statuses reference (no production.view permission)', () => {
    const flow = buildOrderProductionFlow([
      { production_status_id: 3, production_status_name: 'Распилен', quantity: 2 },
    ], []);

    expect(flow.stages).toEqual([
      { key: '3', statusId: 3, code: null, name: 'Распилен', positions: 1, quantity: 2, share: 1 },
    ]);
  });

  it('carries the stage code for the compact letter summary', () => {
    const flow = buildOrderProductionFlow(
      [{ production_status_id: 3, quantity: 2 }],
      [{ production_status_id: 3, production_status_name: 'Распилен', production_status_code: ' cut ', sort_order: 30, is_active: true }],
    );

    expect(flow.stages[0].code).toBe('cut');
  });
});
