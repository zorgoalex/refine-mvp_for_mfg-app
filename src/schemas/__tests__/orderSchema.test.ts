// Task 8 (Variant B): Zod save gate — sheet_material_type_id required,
// material_id must be null/absent (positive material_id = stale pre-034 payload).
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
