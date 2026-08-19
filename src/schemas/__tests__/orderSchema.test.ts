// Task 8 (Variant B): Zod save gate — sheet_material_type_id required,
// material_id must be null/absent (positive material_id = stale pre-034 payload).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { orderHeaderSchema, orderDetailSchema } from '../orderSchema';

// Valid Variant B sheet detail: sheet id present, material_id null/omitted.
const validSheetDetail = {
  detail_number: 1,
  height: 10,
  width: 20,
  quantity: 1,
  area: 200,
  sheet_material_type_id: 5,
  milling_type_id: 1,
  edge_type_id: 1,
  milling_cost_per_sqm: 100,
  detail_cost: 100,
};

const validHeader = {
  order_name: 'Тест заказ',
  client_id: 1,
  order_date: '2026-06-20',
  order_status_id: 1,
  payment_status_id: 1,
};

describe('orderDetailSchema Variant B — sheet_material_type_id required', () => {
  it('parses a sheet detail with sheet id and no material_id', () => {
    const out = orderDetailSchema.parse({ ...validSheetDetail });
    expect(out.sheet_material_type_id).toBe(5);
    expect(out.material_id ?? null).toBeNull();
  });

  it('parses a sheet detail with sheet id and explicit null material_id', () => {
    const out = orderDetailSchema.parse({ ...validSheetDetail, material_id: null });
    expect(out.sheet_material_type_id).toBe(5);
    expect(out.material_id).toBeNull();
  });

  it('rejects a detail with missing sheet_material_type_id', () => {
    const { sheet_material_type_id, ...noSheet } = validSheetDetail;
    const res = orderDetailSchema.safeParse({ ...noSheet });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('sheet_material_type_id');
    }
  });

  it('rejects a detail with null sheet_material_type_id', () => {
    const res = orderDetailSchema.safeParse({ ...validSheetDetail, sheet_material_type_id: null });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('sheet_material_type_id');
    }
  });

  it('rejects a detail with a positive material_id (stale pre-034 payload)', () => {
    const res = orderDetailSchema.safeParse({ ...validSheetDetail, material_id: 7 });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('material_id');
    }
  });

  it('rejects a detail with material_id: 0 (0-sentinel is not a valid bypass, Critic R2)', () => {
    const res = orderDetailSchema.safeParse({ ...validSheetDetail, material_id: 0 });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('material_id');
    }
  });
});

describe('orderHeaderSchema Variant B — material_id must be null/absent', () => {
  it('parses a header with sheet_material_type_id and no material_id', () => {
    const out = orderHeaderSchema.parse({ ...validHeader, sheet_material_type_id: 9 });
    expect(out.sheet_material_type_id).toBe(9);
    expect(out.material_id ?? null).toBeNull();
  });

  it('parses a header with material_id: null', () => {
    const out = orderHeaderSchema.parse({ ...validHeader, material_id: null });
    expect(out.material_id).toBeNull();
  });

  it('rejects a header with a positive material_id (stale pre-034 payload)', () => {
    const res = orderHeaderSchema.safeParse({ ...validHeader, material_id: 4 });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('material_id');
    }
  });

  it('rejects a header with material_id: 0 (0-sentinel is not a valid bypass, Critic R2)', () => {
    const res = orderHeaderSchema.safeParse({ ...validHeader, material_id: 0 });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('material_id');
    }
  });

  it('still parses a legacy header with the material fields omitted', () => {
    const out = orderHeaderSchema.parse({ ...validHeader });
    expect(out.sheet_material_type_id ?? null).toBeNull();
    expect(out.material_id ?? null).toBeNull();
  });
});

describe('order detail required numeric validation', () => {
  it('reports every empty or zero dimension, quantity, and cost field', () => {
    const result = orderDetailSchema.safeParse({
      ...validSheetDetail,
      height: null,
      width: 0,
      quantity: null,
      milling_cost_per_sqm: null,
      detail_cost: 0,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(new Set(result.error.issues.map((issue) => issue.path.join('.')))).toEqual(new Set([
      'height',
      'width',
      'quantity',
      'milling_cost_per_sqm',
      'detail_cost',
    ]));
  });

  it('keeps non-tail invalid rows for validation and skips only empty tail rows on save', () => {
    const orderFormSource = readFileSync(
      new URL('../../pages/orders/components/OrderForm.tsx', import.meta.url),
      'utf8',
    );
    const tableSource = readFileSync(
      new URL('../../pages/orders/components/tables/OrderDetailTable.tsx', import.meta.url),
      'utf8',
    );
    const appCss = readFileSync(new URL('../../styles/app.css', import.meta.url), 'utf8');

    expect(orderFormSource).not.toContain('filtered out ${skippedCount} unfilled detail(s)');
    expect(tableSource).not.toContain('empty detail detected, removing from store');
    expect(orderFormSource).toContain('businessOrderDetails(formValues.details ?? [])');
    expect(orderFormSource).toContain('prepareOrderDetailsForSave(businessFormDetails)');
    expect(orderFormSource).toContain('collectOrderDetailEmptyTailRowsForDisplay(formValues.details ?? [])');
    expect(orderFormSource).toContain('appendOrderDetailEmptyTailRowsForDisplay(');
    expect(tableSource).toContain('saveCurrentRow({ allowEmptyTailRow: true })');
    expect(tableSource).toContain('clearOrderDetailTailRowValues(currentRecord)');
    expect(tableSource).toContain('countOrderDetailsWithRequiredEntryValues(details)');
    expect(tableSource).toContain('scroll={{ x: tableScrollWidth, y: tableBodyScrollY }}');
    expect(tableSource).toContain("classes.push('order-detail-validation-error')");
    expect(tableSource).toContain('setValidationScrollTargetKey(firstInvalidRowKey)');
    expect(tableSource).toContain("row?.scrollIntoView({ behavior: 'smooth', block: 'center' })");
    expect(appCss).toContain('tr.order-detail-validation-error > td');

    const validationCss = appCss.slice(
      appCss.indexOf('/* Save validation:'),
      appCss.indexOf(':root', appCss.indexOf('/* Save validation:')),
    );
    expect(validationCss).toContain('box-shadow:');
    expect(validationCss).not.toContain('background-color:');
    expect(validationCss).not.toContain('border-top:');
    expect(validationCss).not.toContain('border-bottom:');
    expect((tableSource.match(/help=\{null\}/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(validationCss).toContain('.order-details-table .ant-form-item-explain');
    expect(validationCss).toContain('display: none !important;');
    expect(tableSource).toContain('validateSheetDimensions(');
    expect(tableSource).not.toContain('disabled={!!dimensionValidationError}');
  });
});
