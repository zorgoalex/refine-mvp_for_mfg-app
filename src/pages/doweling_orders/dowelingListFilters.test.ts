import { describe, expect, it } from 'vitest';
import { applyDowelingFilters, dowelingFilterConfig } from './dowelingListFilters';

const rows = [
  { doweling_order_id: 1, doweling_order_name: '1289', order_name: '2269', client_name: 'Иванов', delete_flag: false, design_engineer: 'Петров', bazis_xml_count: 2, parts_count: 12, payment_status_name: 'Оплачен' },
  { doweling_order_id: 2, doweling_order_name: '1368', order_name: '2409', client_name: 'Сидоров', delete_flag: false, design_engineer: 'Кузнецов', bazis_xml_count: 0, parts_count: 40 },
  { doweling_order_id: 3, doweling_order_name: '1400', order_name: null, client_name: 'нд', delete_flag: true, design_engineer: 'Петров', bazis_xml_count: 0, parts_count: null },
];
const ids = (filters: unknown[]) => applyDowelingFilters(rows, filters as any).map((row) => row.doweling_order_id);

describe('Bazis projects list filters (applied to the loaded rows)', () => {
  it('shows only active cards unless «Показывать неактивные»', () => {
    expect(ids([])).toEqual([1, 2]);
    expect(ids([{ field: 'is_active', operator: 'in', value: [true, false] }])).toEqual([1, 2, 3]);
    expect(ids([{ field: 'is_active', operator: 'in', value: ['true', 'false'] }])).toEqual([1, 2, 3]);
  });

  it('the search looks in the Bazis project, the order and the client, case-insensitively', () => {
    expect(ids([{ field: 'q', operator: 'contains', value: '1368' }])).toEqual([2]);
    expect(ids([{ field: 'q', operator: 'contains', value: '2269' }])).toEqual([1]);
    expect(ids([{ field: 'q', operator: 'contains', value: 'СИДОР' }])).toEqual([2]);
  });

  it('applies text, select, «XML Базиса» and the parts range together', () => {
    expect(ids([{ field: 'client_name', operator: 'contains', value: 'иван' }])).toEqual([1]);
    expect(ids([{ field: 'design_engineer', operator: 'eq', value: 'Петров' }])).toEqual([1]);
    expect(ids([{ field: 'has_xml', operator: 'eq', value: 'false' }])).toEqual([2]);
    expect(ids([{ field: 'parts_count', operator: 'gte', value: '20' }])).toEqual([2]);
    expect(ids([{ field: 'parts_count', operator: 'lte', value: 20 }, { field: 'has_xml', operator: 'eq', value: true }])).toEqual([1]);
  });

  it('offers the values present in the list; payment status only with the financial right', () => {
    const config = dowelingFilterConfig(rows, false);
    const engineer = config.fields.find((field) => field.field === 'design_engineer') as any;
    expect(engineer.options.map((option: any) => option.value)).toEqual(['Кузнецов', 'Петров']);
    expect(config.fields.some((field) => field.field === 'payment_status_name')).toBe(false);
    expect(dowelingFilterConfig(rows, true).fields.some((field) => field.field === 'payment_status_name')).toBe(true);
    expect(config.search?.field).toBe('q');
  });
});
