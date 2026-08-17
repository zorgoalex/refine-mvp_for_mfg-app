// Task 11 (SP3): orderMapper must carry sheetMaterialTypeId both directions and
// allow a sheet-only detail (no legacy material_id) through the outbound mapping.
import { describe, it, expect } from 'vitest';
import { mapOrderFormToSaveOrderDto, mapOrderDtoToFormValues, mapOrderListItemToLegacyRow } from '../orderMapper';
import type { OrderDto, OrderListItemDto } from '../../types/orderApi.types';

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
    primaryGroup: null,
    groups: [],
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

  it('carries embedded cut refs onto legacy details for order-card columns', () => {
    const dtoWithCutRefs: OrderDto = {
      ...dto,
      details: [
        {
          ...(dto.details[0] as any),
          cutJob: { cutJobId: 41, resultNo: 2, cutNumber: '41', name: 'Раскрой заказа', paramProfileId: null, profileName: null, profileIsActive: null },
          bathCutJob: { cutJobId: 42, resultNo: 3, cutNumber: 'В-42', name: 'Ванна заказа', paramProfileId: 7, profileName: 'Вакуум', profileIsActive: true },
        } as any,
      ],
    } as any;
    const values = mapOrderDtoToFormValues(dtoWithCutRefs);
    expect((values.details[0] as any).cut_job?.cutJobId).toBe(41);
    expect((values.details[0] as any).bath_cut_job?.name).toBe('Ванна заказа');
  });

  it('carries linked Basis-cut sets onto legacy details for the view card', () => {
    const dtoWithBazisCutSets: OrderDto = {
      ...dto,
      details: [{
        ...(dto.details[0] as any),
        bazisCutSets: [{ bazisCutSetId: 8, name: 'БР-8' }],
      } as any],
    } as any;
    const values = mapOrderDtoToFormValues(dtoWithBazisCutSets);
    expect((values.details[0] as any).bazis_cut_sets).toEqual([
      { bazisCutSetId: 8, name: 'БР-8' },
    ]);
  });

  it('carries linked Basis-project id onto legacy details for view and edit links', () => {
    const dtoWithBazisProject: OrderDto = {
      ...dto,
      details: [{
        ...(dto.details[0] as any),
        basisProject: '1491',
        bazisProjectId: 41,
      } as any],
    } as any;
    const values = mapOrderDtoToFormValues(dtoWithBazisProject);
    expect((values.details[0] as any).bazis_project_id).toBe(41);
  });
});

// ---------------------------------------------------------------------------
// Critic R8 fix: mapOrderListItemToLegacyRow header-material fallback
// A header-only order (no details, empty materialNames/sheetMaterialTypeIds)
// must display the header material in the orders list via the fallback.
// ---------------------------------------------------------------------------
function makeListItem(overrides: Partial<OrderListItemDto> = {}): OrderListItemDto {
  return {
    orderId: 1,
    orderName: 'Тест R8',
    clientId: 1,
    orderDate: '2026-06-22',
    orderStatusId: 1,
    updatedAt: '2026-06-22T10:00:00.000Z',
    version: 1,
    ...overrides,
  } as OrderListItemDto;
}

describe('mapOrderListItemToLegacyRow — header-material fallback (critic R8)', () => {
  it('maps backend Basis-project aggregates for the orders list fallback', () => {
    const item = makeListItem({
      basisProjects: ['1491', '1492'],
    });
    const row = mapOrderListItemToLegacyRow(item);
    expect(row.basis_projects).toEqual(['1491', '1492']);
  });

  it('maps backend production-number aggregates for orders-list columns', () => {
    const item = makeListItem({
      bazisCutNumbers: ['БР-8', 'БР-12'],
      cutNumbers: ['42', '51'],
      bathCutNumbers: ['В-70'],
    });
    const row = mapOrderListItemToLegacyRow(item);
    expect(row.bazis_cut_numbers).toEqual(['БР-8', 'БР-12']);
    expect(row.cut_numbers).toEqual(['42', '51']);
    expect(row.bath_cut_numbers).toEqual(['В-70']);
  });

  it('maps backend detail filmNames for the orders list film column', () => {
    const item = makeListItem({
      filmNames: ['Пленка A', 'Пленка B'],
    });
    const row = mapOrderListItemToLegacyRow(item);
    expect(row.film_names).toEqual(['Пленка A', 'Пленка B']);
    expect(row.film_name).toBe('Пленка A, Пленка B');
  });

  it('header-only order: uses headerMaterialName when materialNames is empty', () => {
    const item = makeListItem({
      materialNames: [],
      sheetMaterialTypeIds: [],
      headerMaterialName: 'МДФ 16мм',
      headerSheetMaterialTypeId: 42,
    });
    const row = mapOrderListItemToLegacyRow(item);
    expect(row.material_names).toEqual(['МДФ 16мм']);
    expect(row.material_name).toBe('МДФ 16мм');
    expect(row.sheet_material_type_ids).toEqual([42]);
  });

  it('header-only order: empty result when both materialNames and headerMaterialName are absent', () => {
    const item = makeListItem({
      materialNames: [],
      sheetMaterialTypeIds: [],
      headerMaterialName: null,
      headerSheetMaterialTypeId: null,
    });
    const row = mapOrderListItemToLegacyRow(item);
    expect(row.material_names).toEqual([]);
    expect(row.material_name).toBeNull();
    expect(row.sheet_material_type_ids).toEqual([]);
  });

  it('order with details: keeps detail materialNames (no fallback override)', () => {
    const item = makeListItem({
      materialNames: ['МДФ 16мм', 'ДСП 18мм'],
      sheetMaterialTypeIds: [7, 8],
      headerMaterialName: 'МДФ 25мм',
      headerSheetMaterialTypeId: 99,
    });
    const row = mapOrderListItemToLegacyRow(item);
    // Detail aggregates win; header fallback must NOT override
    expect(row.material_names).toEqual(['МДФ 16мм', 'ДСП 18мм']);
    expect(row.material_name).toBe('МДФ 16мм, ДСП 18мм');
    expect(row.sheet_material_type_ids).toEqual([7, 8]);
  });

  it('header-only order: header sheet type fallback when materialNames absent but sheetMaterialTypeIds also empty', () => {
    const item = makeListItem({
      materialNames: undefined,
      sheetMaterialTypeIds: undefined,
      headerMaterialName: 'Фанера 12мм',
      headerSheetMaterialTypeId: 55,
    });
    const row = mapOrderListItemToLegacyRow(item);
    expect(row.material_names).toEqual(['Фанера 12мм']);
    expect(row.material_name).toBe('Фанера 12мм');
    expect(row.sheet_material_type_ids).toEqual([55]);
  });
});
