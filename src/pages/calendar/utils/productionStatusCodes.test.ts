import { describe, expect, it } from 'vitest';
import type { ProductionStatusRef } from '../../../types/productionWorkflow';
import type { CalendarOrder } from '../types/calendar';
import {
  buildProductionStatusCodeLookup,
  resolveCalendarProductionStatusCodes,
} from './productionStatusCodes';

const statuses: ProductionStatusRef[] = [
  { production_status_id: 1, production_status_code: 'drawn', production_status_name: 'Отрисован', sort_order: 10, is_active: true },
  { production_status_id: 2, production_status_code: 'cut', production_status_name: 'Распилено', sort_order: 20, is_active: true },
];

const order = (overrides: Partial<CalendarOrder> = {}): CalendarOrder => ({
  order_id: 1,
  order_name: '1',
  order_date: '2026-08-24',
  planned_completion_date: '2026-08-24',
  version: 1,
  parts_count: 1,
  total_area: 1,
  paid_amount: 0,
  production_status_id: 2,
  production_status_name: 'Распилено',
  ...overrides,
});

describe('calendar production status resolver', () => {
  it('maps ids to codes', () => {
    expect(buildProductionStatusCodeLookup(statuses).idToCode.get(2)).toBe('cut');
  });

  it('shows only the loaded order marks, not the order or detail stage', () => {
    expect(resolveCalendarProductionStatusCodes({
      order: order({ passed_production_status_codes: ['drawn', 'cut'] }),
      eventCodes: ['drawn'],
    })).toEqual(['drawn']);
  });

  it('shows nothing when the loaded events have no marks for the order', () => {
    expect(resolveCalendarProductionStatusCodes({ order: order(), eventCodes: [] })).toEqual([]);
  });

  it('falls back to the backend marks before events load', () => {
    expect(resolveCalendarProductionStatusCodes({
      order: order({ passed_production_status_codes: ['cut', ' cut '] }),
    })).toEqual(['cut']);
  });
});
