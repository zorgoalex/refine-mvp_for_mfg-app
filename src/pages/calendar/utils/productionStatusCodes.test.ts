import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProductionStatusRef } from '../../../types/productionWorkflow';
import type { CalendarOrder } from '../types/calendar';
import {
  buildProductionStatusCodeLookup,
  resolveCalendarManualProductionStatusCodes,
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

  it('shows the backend projection, not the order or detail stage', () => {
    expect(resolveCalendarProductionStatusCodes({
      order: order({ passed_production_status_codes: ['drawn', ' drawn ', 'cut'] }),
    })).toEqual(['drawn', 'cut']);
  });

  it('shows nothing when the projection is empty or absent', () => {
    expect(resolveCalendarProductionStatusCodes({ order: order() })).toEqual([]);
    expect(resolveCalendarProductionStatusCodes({ order: order({ passed_production_status_codes: [] }) })).toEqual([]);
  });

  it('exposes the manual subset separately', () => {
    expect(resolveCalendarManualProductionStatusCodes({
      order: order({ passed_production_status_codes: ['drawn', 'cut'], manual_production_status_codes: ['cut'] }),
    })).toEqual(['cut']);
    expect(resolveCalendarManualProductionStatusCodes({ order: order() })).toEqual([]);
  });
});

describe('calendar letters never read Hasura events', () => {
  it('useCalendarData has no production_status_events list', () => {
    const source = readFileSync(resolve(__dirname, '../hooks/useCalendarData.ts'), 'utf8');
    expect(source).not.toContain('production_status_events');
    expect(source).toContain('manualProductionCodes');
  });
});
