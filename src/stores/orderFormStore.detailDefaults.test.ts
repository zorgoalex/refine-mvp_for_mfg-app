import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapOrderFormToSaveOrderDto } from '../api/mappers/orderMapper';
import { newDetailDefaults } from '../pages/orders/detailDefaults';
import type { OrderDetail } from '../types/orders';
import {
  clearOrderDetailTailRowValues,
  collectNewEmptyTailDetailKeys,
  getOrderImportPlaceholderIds,
  isPristineOrderDetailPlaceholder,
} from '../utils/orderDetailRows';

const defaults = { sheetMaterialTypeId: 12, filmId: 40, millingTypeId: 3, edgeTypeId: 2, pricePerSqm: 9500 };

const saved = (): OrderDetail => ({
  temp_id: 1, detail_number: 1, height: 500, width: 300, quantity: 1, area: 0.15, material_id: null,
  sheet_material_type_id: 7, milling_type_id: 1, edge_type_id: 1, priority: 100, milling_cost_per_sqm: 100, detail_cost: 15,
});
const pristine = (temp_id = 2): OrderDetail => ({
  temp_id, detail_number: temp_id, height: 0, width: 0, quantity: 0, area: 0, material_id: null,
  milling_type_id: 1, edge_type_id: 1, priority: 100, is_placeholder: true,
});

describe('«Параметры деталей по умолчанию» in the details grid', () => {
  it('the grid rows stay pristine: an import still reuses them', () => {
    expect(isPristineOrderDetailPlaceholder(pristine())).toBe(true);
    expect(getOrderImportPlaceholderIds([saved(), pristine(2), pristine(3)])).toEqual([2, 3]);
  });

  it('a pristine row opened with the defaults and left unfilled is an empty tail (the save is not blocked)', () => {
    // what the inline editor holds for the row: the record plus the form values it opened with
    const opened = { ...pristine(), ...newDetailDefaults(defaults, undefined) } as OrderDetail;
    expect(collectNewEmptyTailDetailKeys([saved(), opened]).size).toBe(1);
    // a price typed by hand is an entry
    expect(collectNewEmptyTailDetailKeys([saved(), { ...opened, milling_cost_per_sqm: 9000 }]).size).toBe(0);
  });

  it('an unfilled row cleared on save is pristine again: an import reuses it, opening it applies the defaults', () => {
    const opened = { ...pristine(), ...newDetailDefaults(defaults, undefined) } as OrderDetail;
    const cleared = clearOrderDetailTailRowValues(opened);
    expect(cleared.prefilled_milling_cost_per_sqm ?? null).toBeNull();
    expect(isPristineOrderDetailPlaceholder(cleared)).toBe(true);
    expect(getOrderImportPlaceholderIds([saved(), cleared])).toEqual([2]);
  });

  it('the price marker never reaches the save request', () => {
    const dto = mapOrderFormToSaveOrderDto({
      header: { order_name: 'Тест', client_id: 1, order_date: '2026-10-29', order_status_id: 1, priority: 100 },
      details: [{ ...saved(), milling_cost_per_sqm: 9500, prefilled_milling_cost_per_sqm: 9500 }],
      payments: [],
    } as never);
    expect(JSON.stringify(dto)).not.toContain('prefilled');
  });

  it('the table puts the defaults into a pristine row only when it is opened (no background sync of the grid)', () => {
    const table = readFileSync(join(__dirname, '../pages/orders/components/tables/OrderDetailTable.tsx'), 'utf8');
    expect(table).toContain('if (newRowDefaults && isPristineOrderDetailPlaceholder(record)) {');
    const tab = readFileSync(join(__dirname, '../pages/orders/components/tabs/OrderDetailsTab.tsx'), 'utf8');
    expect(tab).toContain('newRowDefaults={detailDefaults}');
    expect(tab).not.toContain('patchPlaceholderDetails');
  });
});
