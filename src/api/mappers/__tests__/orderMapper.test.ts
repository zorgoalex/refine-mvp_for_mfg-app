// Task 11 (SP3): orderMapper must carry sheetMaterialTypeId both directions and
// allow a sheet-only detail (no legacy material_id) through the outbound mapping.
import { describe, it, expect } from 'vitest';
import { mapOrderFormToSaveOrderDto, mapOrderDtoToFormValues } from '../orderMapper';
import type { OrderDto } from '../../types/orderApi.types';

const baseDetail = {
  detail_number: 1,
  height: 10,
  width: 20,
  quantity: 1,
  area: 200,
  material_id: 5,
  milling_type_id: 1,
  edge_type_id: 1,
  detail_cost: 100,
  priority: 100,
};

const baseHeader = {
  order_name: 'Тест заказ',
  client_id: 1,
  order_date: '2026-06-20',
  priority: 100,
  order_status_id: 1,
  payment_status_id: 1,
  discount: 0,
  surcharge: 0,
  paid_amount: 0,
};

function form(overrides: any = {}) {
  return {
    header: { ...baseHeader, ...(overrides.header || {}) },
    details: overrides.details ?? [{ ...baseDetail }],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
  } as any;
}

describe('orderMapper outbound (draft -> SaveOrderDto)', () => {
  it('emits sheetMaterialTypeId on header + detail', () => {
    const dto = mapOrderFormToSaveOrderDto(
      form({
        header: { sheet_material_type_id: 9 },
        details: [{ ...baseDetail, sheet_material_type_id: 7 }],
      }),
    );
    expect(dto.header.sheetMaterialTypeId).toBe(9);
    expect(dto.details[0].sheetMaterialTypeId).toBe(7);
  });

  it('allows a sheet-only detail with no legacy material_id', () => {
    const { material_id, ...sheetOnly } = baseDetail;
    const dto = mapOrderFormToSaveOrderDto(
      form({ details: [{ ...sheetOnly, sheet_material_type_id: 7 }] }),
    );
    expect(dto.details[0].sheetMaterialTypeId).toBe(7);
    // Variant B: mapper always emits null for materialId on sheet details (0-sentinel removed)
    expect(dto.details[0].materialId).toBeNull();
  });

  it('keeps a legacy detail unchanged (sheet id null/undefined)', () => {
    const dto = mapOrderFormToSaveOrderDto(form());
    expect(dto.details[0].materialId).toBe(5);
    expect(dto.details[0].sheetMaterialTypeId ?? null).toBeNull();
    expect(dto.header.sheetMaterialTypeId ?? null).toBeNull();
  });
});

describe('orderMapper inbound (OrderDto -> form values)', () => {
  const dto: OrderDto = {
    header: {
      orderId: 1,
      orderName: 'Тест',
      clientId: 1,
      orderDate: '2026-06-20',
      orderStatusId: 1,
      sheetMaterialTypeId: 9,
    } as any,
    details: [
      // Variant B: server returns materialId: null for sheet details (0-sentinel removed)
      { id: 10, detailNumber: 1, height: 1, width: 1, quantity: 1, materialId: null, millingTypeId: 1, edgeTypeId: 1, detailCost: 1, sheetMaterialTypeId: 7 } as any,
    ],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    primaryProject: null,
    projects: [],
    totals: { totalAmount: 0, finalAmount: 0, paidAmount: 0, partsCount: 1, totalArea: 1 } as any,
    version: 0,
  } as any;

  it('hydrates sheet_material_type_id onto header + detail', () => {
    const values = mapOrderDtoToFormValues(dto);
    expect(values.header.sheet_material_type_id).toBe(9);
    expect(values.details[0].sheet_material_type_id).toBe(7);
  });

  it('carries server-resolved materialName (COALESCE) onto header + detail for display', () => {
    const dtoWithNames: OrderDto = {
      ...dto,
      header: { ...(dto.header as any), materialName: 'МДФ 16мм' } as any,
      details: [{ ...(dto.details[0] as any), materialName: 'МДФ 16мм' } as any],
    } as any;
    const values = mapOrderDtoToFormValues(dtoWithNames);
    // backend-read surfaces (show/edit via __backendOrder) must display the sheet name, not "—"
    expect((values.header as any).material_name_resolved).toBe('МДФ 16мм');
    expect((values.details[0] as any).material_name_resolved).toBe('МДФ 16мм');
  });
});
