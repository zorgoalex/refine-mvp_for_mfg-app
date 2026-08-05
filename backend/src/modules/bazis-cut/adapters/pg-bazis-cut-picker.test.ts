import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { BazisCutPickerCriteria } from '../dto/bazis-cut.dto';
import {
  hashBazisCutPickerCriteria,
  normalizeBazisCutPickerCriteria,
  PgBazisCutPicker,
} from './pg-bazis-cut-picker';

const user = {
  id: '42', username: 'manager', role: 'manager', permissions: ['cut.view', 'orders.view'],
} as CurrentUser;

const criteria: BazisCutPickerCriteria = {
  dateFrom: '2026-08-01', dateTo: '2026-08-05', orderIds: [], clientIds: [],
  sheetMaterialTypeIds: [], millingTypeIds: [], bazisKeys: [], designEngineerIds: [],
  dowelingOrderIds: [], excludedDetailIds: [],
};

describe('PgBazisCutPicker', () => {
  it('builds period-first scoped facets for every requested filter', async () => {
    const query = vi.fn(async () => result([
      { facet_key: 'orders', id_value: 7, key_value: null, label: '101', type_value: null },
      { facet_key: 'bazis_sources', id_value: null, key_value: 'project:2', label: 'Базис-проект: БП-2', type_value: 'project' },
      { facet_key: 'design_engineers', id_value: 5, key_value: null, label: 'Иванов', type_value: null },
    ]));
    const picker = new PgBazisCutPicker({ query } as unknown as DatabaseClient);

    const facets = await picker.listFacets(user, criteria);

    expect(facets.orders).toEqual([{ id: 7, label: '101' }]);
    expect(facets.bazisSources).toEqual([{ key: 'project:2', label: 'Базис-проект: БП-2', type: 'project' }]);
    expect(facets.designEngineers).toEqual([{ id: 5, label: 'Иванов' }]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('o.order_date BETWEEN $1::date AND $2::date');
    expect(sql).toContain('(o.created_by = $3 OR o.manager_id = $3)');
    expect(sql).toContain("'doweling_orders'");
    expect(query.mock.calls[0][1]).toEqual(['2026-08-01', '2026-08-05', 42]);
  });

  it('normalizes criteria, returns totals, memberships, and SHA-256 stale tokens', async () => {
    const query = vi.fn(async () => result([{
      total_count: 1, total_quantity: 2, total_area_m2: '0.62', items: [pickerRow()],
    }]));
    const picker = new PgBazisCutPicker({ query } as unknown as DatabaseClient);
    const unordered = { ...criteria, orderIds: [9, 7, 9], bazisKeys: [' order:2 ', 'project:1'] };

    const response = await picker.search(user, unordered, 1, 25);

    expect(response).toMatchObject({ total: 1, totalQuantity: 2, totalAreaM2: 0.62, pageSize: 25 });
    expect(response.criteriaHash).toHaveLength(64);
    expect(response.items[0]).toMatchObject({
      detailId: 11, orderNumber: '101', bazisCutSets: [{ bazisCutSetId: 8, name: 'БР-8' }],
    });
    expect(response.items[0].selectionToken).toHaveLength(64);
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).toContainEqual([7, 9]);
    expect(params).toContainEqual(['order:2', 'project:1']);
  });

  it('hashes canonically equivalent filter arrays identically', () => {
    const left = normalizeBazisCutPickerCriteria({ ...criteria, orderIds: [2, 1, 2] });
    const right = normalizeBazisCutPickerCriteria({ ...criteria, orderIds: [1, 2] });
    expect(hashBazisCutPickerCriteria(left)).toBe(hashBazisCutPickerCriteria(right));
  });
});

function pickerRow() {
  return {
    detail_id: 11, detail_number: 3, detail_version: 2, detail_updated_at: '2026-08-05T10:00:00.000Z',
    order_id: 7, order_version: 4, order_name: '101', order_date: '2026-08-05',
    client_id: 3, client_name: 'Клиент', project_id: 5, quantity: 2, height_mm: 1000,
    width_mm: 310, area_m2: '0.62', detail_name: 'Фасад', note: '', doweling: true,
    sheet_material_type_id: 9, material_name: 'МДФ 16', material_thickness_mm: 16,
    milling_type_id: 2, milling_name: 'Фрезеровка', film_id: null,
    basis_designation: '', basis_data: '', basis_project: 'БП-2', basis_product: 'Кухня',
    bazis_key: 'project:2', bazis_label: 'Базис-проект: БП-2', bazis_type: 'project',
    doweling_order_id: 6, doweling_order_name: 'Присадка-6', design_engineer_id: 5,
    design_engineer_name: 'Иванов', bazis_cut_sets: [{ bazisCutSetId: 8, name: 'БР-8' }],
  };
}

function result<T extends object>(rows: T[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}
