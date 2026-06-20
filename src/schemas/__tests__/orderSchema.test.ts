// Task 7 (SP3): sheet_material_type_id on order header/detail Zod schemas.
import { describe, it, expect } from 'vitest';
import { orderHeaderSchema, orderDetailSchema } from '../orderSchema';

const validDetail = {
  detail_number: 1,
  height: 10,
  width: 20,
  quantity: 1,
  area: 200,
  material_id: 5,
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

describe('orderDetailSchema sheet_material_type_id', () => {
  it('keeps sheet_material_type_id when provided', () => {
    const out = orderDetailSchema.parse({ ...validDetail, sheet_material_type_id: 7 });
    expect(out.sheet_material_type_id).toBe(7);
  });

  it('still parses a legacy detail with the field omitted', () => {
    const out = orderDetailSchema.parse({ ...validDetail });
    expect(out.material_id).toBe(5);
    expect(out.sheet_material_type_id ?? null).toBeNull();
  });

  it('parses a sheet-only detail (material_id omitted, sheet id set)', () => {
    const { material_id, ...sheetOnly } = validDetail;
    const out = orderDetailSchema.parse({ ...sheetOnly, sheet_material_type_id: 7 });
    expect(out.sheet_material_type_id).toBe(7);
  });

  it('rejects a detail with neither material nor sheet material', () => {
    const { material_id, ...neither } = validDetail;
    const res = orderDetailSchema.safeParse({ ...neither });
    expect(res.success).toBe(false);
  });
});

describe('orderHeaderSchema sheet_material_type_id', () => {
  it('accepts header sheet_material_type_id', () => {
    const out = orderHeaderSchema.parse({ ...validHeader, sheet_material_type_id: 9 });
    expect(out.sheet_material_type_id).toBe(9);
  });

  it('still parses a legacy header with the field omitted', () => {
    const out = orderHeaderSchema.parse({ ...validHeader });
    expect(out.sheet_material_type_id ?? null).toBeNull();
  });
});
