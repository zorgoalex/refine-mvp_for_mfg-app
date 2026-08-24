import { describe, expect, it } from 'vitest';
import type { ProductionStatusRef } from '../../../types/productionWorkflow';
import {
  buildProductionStatusCodeLookup,
  resolveCalendarProductionStatusCodes,
} from './productionStatusCodes';

const statuses: ProductionStatusRef[] = [
  { production_status_id: 1, production_status_code: 'drawn', production_status_name: 'Отрисован', sort_order: 10, is_active: true },
  { production_status_id: 2, production_status_code: 'cut', production_status_name: 'Распилено', sort_order: 20, is_active: true },
  { production_status_id: 3, production_status_code: 'issued', production_status_name: 'Выдан', sort_order: 30, is_active: true },
];

describe('calendar production status resolver', () => {
  it('merges event, backend, parent and ordinary-detail codes', () => {
    const lookup = buildProductionStatusCodeLookup(statuses);
    expect(resolveCalendarProductionStatusCodes({
      order: {
        order_id: 1,
        order_name: '1',
        order_date: '2026-08-24',
        planned_completion_date: '2026-08-24',
        version: 1,
        parts_count: 1,
        total_area: 1,
        paid_amount: 0,
        production_status_name: 'Распилено',
        passed_production_status_codes: ['drawn'],
      },
      details: [{ production_status_id: 3 }],
      eventCodes: ['drawn'],
      lookup,
    })).toEqual(['drawn', 'cut', 'issued']);
  });

  it('supports a Hasura-shaped order using the unique status name and detail ids', () => {
    const lookup = buildProductionStatusCodeLookup(statuses);
    expect(resolveCalendarProductionStatusCodes({
      order: {
        order_id: 2,
        order_name: '2',
        order_date: '2026-08-24',
        planned_completion_date: '2026-08-24',
        version: 1,
        parts_count: 1,
        total_area: 1,
        paid_amount: 0,
        production_status_name: '  РАСПИЛЕНО ',
      },
      details: [{ production_status_id: 3 }],
      lookup,
    })).toEqual(['cut', 'issued']);
  });

  it('fails closed when normalized names map to different codes', () => {
    const lookup = buildProductionStatusCodeLookup([
      ...statuses,
      { production_status_id: 4, production_status_code: 'custom_cut', production_status_name: ' распилено ', sort_order: 40, is_active: true },
    ]);
    expect(resolveCalendarProductionStatusCodes({
      order: {
        order_id: 3,
        order_name: '3',
        order_date: '2026-08-24',
        planned_completion_date: '2026-08-24',
        version: 1,
        parts_count: 0,
        total_area: 0,
        paid_amount: 0,
        production_status_name: 'Распилено',
      },
      details: [],
      lookup,
    })).toEqual([]);
  });
});
