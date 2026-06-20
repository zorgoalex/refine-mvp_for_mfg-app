/**
 * Unit tests for SP3 sheet-material support in the snapshot path.
 * Covers:
 *  - mapOrderHeaderSnapshot includes sheetMaterialTypeId on export
 *  - mapDetailSnapshot includes sheetMaterialTypeId on export
 *  - orderHeaderInsertParams / orderHeaderUpdateParams include sheet_material_type_id
 *    and enforce the header invariant (force material_id NULL when sheetMaterialTypeId set)
 *  - detailValues includes sheetMaterialTypeId as the last param
 *  - OrderSnapshotService.importOrderSnapshot gates on sheet_materials.view when
 *    the incoming snapshot payload contains a sheetMaterialTypeId
 */
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedSaveOrderHeaderDto, OrderTotalsDto, CalculatedOrderDetailDto } from '../dto/save-order.dto';
import type { OrderSnapshotPort } from '../application/order-snapshot.types';
import { OrderSnapshotService } from '../application/order-snapshot.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { ApiError } from '../../../common/errors/api-error';
import { ORDER_SNAPSHOT_FORMAT_VERSION, ORDER_SNAPSHOT_SCHEMA } from '../dto/order-snapshot.dto';
import {
  _testOnlyMapOrderHeaderSnapshot as mapHeaderSnapshot,
  _testOnlyMapDetailSnapshot as mapDetailSnapshot,
  _testOnlyOrderHeaderInsertParams as insertParams,
  _testOnlyOrderHeaderUpdateParams as updateParams,
  _testOnlyDetailValues as detailValues,
} from './pg-order-snapshot';

// ── Helper builders ────────────────────────────────────────────────────────

function makeHeaderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: 42,
    order_name: 'Test-42',
    client_id: 10,
    order_date: '2026-06-01',
    priority: 100,
    manager_id: 5,
    order_status_id: 1,
    payment_status_id: 2,
    production_status_id: null,
    production_status_from_details_enabled: true,
    planned_completion_date: null,
    completion_date: null,
    issue_date: null,
    payment_date: null,
    discount: 0,
    surcharge: 0,
    link_cutting_file: null,
    link_cutting_image_file: null,
    link_cad_file: null,
    link_pdf_file: null,
    notes: null,
    ref_key_1c: null,
    material_id: null,
    sheet_material_type_id: null,
    milling_type_id: null,
    edge_type_id: null,
    film_id: null,
    ...overrides,
  };
}

function makeDetailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detail_id: 1,
    detail_number: 1,
    detail_name: 'Полка',
    height: 400,
    width: 800,
    quantity: 2,
    material_id: 3,
    sheet_material_type_id: null,
    milling_type_id: 1,
    edge_type_id: 1,
    film_id: null,
    area: 0.64,
    milling_cost_per_sqm: null,
    detail_cost: null,
    priority: 100,
    production_status_id: null,
    joint_order_id: null,
    note: null,
    link_cutting_file: null,
    link_cutting_image_file: null,
    link_cad_file: null,
    link_pdf_file: null,
    ref_key_1c: null,
    ...overrides,
  };
}

function makeNormalizedHeader(overrides: Partial<NormalizedSaveOrderHeaderDto> = {}): NormalizedSaveOrderHeaderDto {
  return {
    orderName: 'Test-42',
    clientId: 10,
    orderDate: '2026-06-01',
    priority: 100,
    managerId: 5,
    orderStatusId: 1,
    paymentStatusId: 2,
    productionStatusId: null,
    productionStatusFromDetailsEnabled: true,
    plannedCompletionDate: null,
    completionDate: null,
    issueDate: null,
    paymentDate: null,
    discount: 0,
    surcharge: 0,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    notes: null,
    refKey1c: null,
    materialId: null,
    sheetMaterialTypeId: null,
    millingTypeId: null,
    edgeTypeId: null,
    filmId: null,
    ...overrides,
  };
}

function makeTotals(overrides: Partial<OrderTotalsDto> = {}): OrderTotalsDto {
  return {
    positionsCount: 1,
    partsCount: 2,
    totalArea: 1.28,
    totalAmount: 500,
    discount: 0,
    surcharge: 0,
    finalAmount: 500,
    paidAmount: 0,
    debtAmount: 500,
    paymentDate: null,
    paymentStatusId: 1,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<CalculatedOrderDetailDto> = {}): CalculatedOrderDetailDto {
  return {
    detailNumber: 1,
    detailName: 'Полка',
    height: 400,
    width: 800,
    quantity: 2,
    materialId: 3,
    sheetMaterialTypeId: null,
    millingTypeId: 1,
    edgeTypeId: 1,
    filmId: null,
    area: 0.64,
    millingCostPerSqm: null,
    detailCost: 0,
    priority: 100,
    productionStatusId: null,
    jointOrderId: null,
    note: null,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    refKey1c: null,
    ...overrides,
  };
}

// ── mapOrderHeaderSnapshot tests ───────────────────────────────────────────

describe('mapOrderHeaderSnapshot — SP3 sheetMaterialTypeId export', () => {
  it('includes sheetMaterialTypeId=null when column is null', () => {
    const result = mapHeaderSnapshot(makeHeaderRow({ sheet_material_type_id: null }));
    expect(result).toHaveProperty('sheetMaterialTypeId', null);
  });

  it('includes sheetMaterialTypeId=42 when column is set', () => {
    const result = mapHeaderSnapshot(makeHeaderRow({ sheet_material_type_id: 42 }));
    expect(result).toHaveProperty('sheetMaterialTypeId', 42);
  });

  it('coerces numeric string to number', () => {
    const result = mapHeaderSnapshot(makeHeaderRow({ sheet_material_type_id: '7' }));
    expect(result).toHaveProperty('sheetMaterialTypeId', 7);
  });
});

// ── mapDetailSnapshot tests ────────────────────────────────────────────────

describe('mapDetailSnapshot — SP3 sheetMaterialTypeId export', () => {
  it('includes sheetMaterialTypeId=null when column is null', () => {
    const result = mapDetailSnapshot(makeDetailRow({ sheet_material_type_id: null }));
    expect(result).toHaveProperty('sheetMaterialTypeId', null);
  });

  it('includes sheetMaterialTypeId=5 when column is set', () => {
    const result = mapDetailSnapshot(makeDetailRow({ sheet_material_type_id: 5 }));
    expect(result).toHaveProperty('sheetMaterialTypeId', 5);
  });

  it('still exports materialId (shadow material_id carried through)', () => {
    const result = mapDetailSnapshot(makeDetailRow({ material_id: 99, sheet_material_type_id: 5 }));
    expect(result.materialId).toBe(99);
    expect(result.sheetMaterialTypeId).toBe(5);
  });
});

// ── orderHeaderInsertParams (SP3) ─────────────────────────────────────────

describe('orderHeaderInsertParams — sheet_material_type_id', () => {
  it('includes sheetMaterialTypeId=null at index 30 (placeholder $31)', () => {
    const params = insertParams(makeNormalizedHeader({ sheetMaterialTypeId: null }), makeTotals());
    expect(params).toHaveLength(31);
    expect(params[30]).toBeNull();
  });

  it('includes sheetMaterialTypeId=42 at index 30', () => {
    const params = insertParams(makeNormalizedHeader({ sheetMaterialTypeId: 42 }), makeTotals());
    expect(params[30]).toBe(42);
  });

  it('forces materialId to null when sheetMaterialTypeId is set (header invariant)', () => {
    // materialId is at index 25 in insertParams (after refKey1c shifted by sheetMaterialTypeId).
    // Position: $26 in SQL = index 25.
    const params = insertParams(makeNormalizedHeader({ materialId: 7, sheetMaterialTypeId: 42 }), makeTotals());
    expect(params[25]).toBeNull();  // materialId forced null
    expect(params[30]).toBe(42);   // sheetMaterialTypeId
  });

  it('preserves materialId when sheetMaterialTypeId is null', () => {
    const params = insertParams(makeNormalizedHeader({ materialId: 3, sheetMaterialTypeId: null }), makeTotals());
    expect(params[25]).toBe(3);    // materialId preserved
    expect(params[30]).toBeNull(); // sheetMaterialTypeId null
  });
});

// ── orderHeaderUpdateParams (SP3) ─────────────────────────────────────────

describe('orderHeaderUpdateParams — sheet_material_type_id', () => {
  it('includes sheetMaterialTypeId=null at index 29 (placeholder $31 with $1=orderId)', () => {
    const params = updateParams(makeNormalizedHeader({ sheetMaterialTypeId: null }), makeTotals());
    expect(params).toHaveLength(30);
    expect(params[29]).toBeNull();
  });

  it('includes sheetMaterialTypeId=99 at index 29', () => {
    const params = updateParams(makeNormalizedHeader({ sheetMaterialTypeId: 99 }), makeTotals());
    expect(params[29]).toBe(99);
  });

  it('forces materialId to null when sheetMaterialTypeId is set (update header invariant)', () => {
    // materialId position in updateParams: index 24 (same column, one less than insert due to missing flag).
    const params = updateParams(makeNormalizedHeader({ materialId: 8, sheetMaterialTypeId: 33 }), makeTotals());
    expect(params[24]).toBeNull(); // materialId forced null
    expect(params[29]).toBe(33);  // sheetMaterialTypeId
  });
});

// ── detailValues (SP3) ────────────────────────────────────────────────────

describe('detailValues — sheet_material_type_id', () => {
  it('places sheetMaterialTypeId=null as last value (index 21)', () => {
    const vals = detailValues(makeDetail({ sheetMaterialTypeId: null }));
    expect(vals[21]).toBeNull();
  });

  it('places sheetMaterialTypeId=5 as last value (index 21)', () => {
    const vals = detailValues(makeDetail({ sheetMaterialTypeId: 5 }));
    expect(vals[21]).toBe(5);
  });

  it('still places materialId at index 6 (not forced null — shadow resolution happens before detailValues call)', () => {
    // The shadow resolution is done BEFORE calling detailValues in upsertDetail.
    // detailValues receives the already-resolved effective detail, so materialId is the shadow id.
    const vals = detailValues(makeDetail({ materialId: 999, sheetMaterialTypeId: 5 }));
    expect(vals[6]).toBe(999);
    expect(vals[21]).toBe(5);
  });
});

// ── OrderSnapshotService — sheet_materials.view gate ──────────────────────

// Use a real CurrentUser shape but with mock permissions injected via the service port
function makeUser(permissions: Record<string, boolean>): CurrentUser {
  return {
    id: '1',
    username: 'test',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'), // shape only; actual checks use mock checker below
  };
}

/** Build a mock OrderPermissionCheckerPort from a flat allow-map. */
function mockPermissions(allow: Record<string, boolean>) {
  return {
    canUser: (_user: CurrentUser, permission: string) => allow[permission] ?? false,
  };
}

/** All permissions needed to pass finance-import gates + optional sheet perm. */
function financeImportAllow(sheetView: boolean): Record<string, boolean> {
  return {
    'orders.import': true,
    'orders.view_financials': true,
    'payments.create': true,
    'payments.update': true,
    'payments.delete': true,
    'sheet_materials.view': sheetView,
  };
}

function fakeSnapshots(): OrderSnapshotPort {
  return {
    exportOrderSnapshot: vi.fn(async () => ({ fileName: 'x.json', content: '{}' })),
    exportOrderSnapshotBatch: vi.fn(async () => ({ fileName: 'x.zip', content: Buffer.from([]), orderCount: 0 })),
    importOrderSnapshot: vi.fn(async () => ({
      success: true as const,
      status: 'created' as const,
      orderId: 1,
      orderName: 'T',
      payloadHash: 'h',
      importRunId: 'r',
      summary: { details: 0, payments: 0, workshops: 0, requirements: 0, dowelingLinks: 0, productionStatusEvents: 0, clientPhones: 0, deadlineInstances: 0, deadlineEvents: 0 },
    })),
    importOrderSnapshotBatch: vi.fn(async () => ({ success: true as const, total: 0, imported: 0, failed: 0, results: [] })),
  };
}

function minimalSnapshotWithSheet(sheetMaterialTypeId: number | null = null) {
  return {
    schema: ORDER_SNAPSHOT_SCHEMA,
    formatVersion: ORDER_SNAPSHOT_FORMAT_VERSION,
    exporterService: { name: 'erp-order-snapshot' as const, version: '1.0.0', compatibleImportVersions: ['1.0.0'] },
    source: { sourceInstanceId: 'test', exportedAt: '2026-06-20T00:00:00.000Z', payloadHash: '' },
    identity: { order: { sourceId: '1', refKey1c: null }, client: { sourceId: '2', refKey1c: null } },
    data: {
      client: { sourceId: '2', clientName: 'C', refKey1c: null, notes: null, isActive: true },
      clientPhones: [],
      order: { sourceId: '1', orderName: 'T-1', clientId: 2, orderDate: '2026-06-20', orderStatusId: 1, sheetMaterialTypeId },
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingOrders: [],
      dowelingLinks: [],
      productionStatusEvents: [],
      deadlineInstances: [],
      deadlineEvents: [],
    },
    references: {},
  };
}

describe('OrderSnapshotService — sheet_materials.view gate on import', () => {
  it('allows import of non-sheet snapshot even without sheet_materials.view', async () => {
    const snapshots = fakeSnapshots();
    const user = makeUser({});
    const service = new OrderSnapshotService({
      snapshots,
      permissions: mockPermissions(financeImportAllow(false)), // no sheet_materials.view
    });
    await expect(
      service.importOrderSnapshot({ currentUser: user, snapshot: minimalSnapshotWithSheet(null) }),
    ).resolves.toMatchObject({ success: true });
    expect(snapshots.importOrderSnapshot).toHaveBeenCalled();
  });

  it('denies import of sheet-bearing snapshot for user without sheet_materials.view', async () => {
    const snapshots = fakeSnapshots();
    const user = makeUser({});
    const service = new OrderSnapshotService({
      snapshots,
      permissions: mockPermissions(financeImportAllow(false)), // no sheet_materials.view
    });
    let caught: unknown;
    try {
      await service.importOrderSnapshot({ currentUser: user, snapshot: minimalSnapshotWithSheet(5) });
    } catch (err) {
      caught = err;
    }
    expect((caught as ApiError)?.code).toBe('PERMISSION_DENIED');
    expect((caught as ApiError)?.statusCode).toBe(403);
    expect((caught as ApiError)?.details).toMatchObject({ requiredPermissions: ['sheet_materials.view'] });
    expect(snapshots.importOrderSnapshot).not.toHaveBeenCalled();
  });

  it('allows import of sheet-bearing snapshot for user with sheet_materials.view', async () => {
    const snapshots = fakeSnapshots();
    const user = makeUser({});
    const service = new OrderSnapshotService({
      snapshots,
      permissions: mockPermissions(financeImportAllow(true)), // has sheet_materials.view
    });
    await expect(
      service.importOrderSnapshot({ currentUser: user, snapshot: minimalSnapshotWithSheet(5) }),
    ).resolves.toMatchObject({ success: true });
    expect(snapshots.importOrderSnapshot).toHaveBeenCalled();
  });

  it('gate checks header sheetMaterialTypeId in snapshot.data.order', async () => {
    const snapshots = fakeSnapshots();
    const user = makeUser({});
    const service = new OrderSnapshotService({
      snapshots,
      permissions: mockPermissions(financeImportAllow(false)),
    });
    // Sheet id on the ORDER HEADER should trigger the gate
    const snapshot = minimalSnapshotWithSheet(99); // header has sheet id
    let caught: unknown;
    try { await service.importOrderSnapshot({ currentUser: user, snapshot }); } catch (e) { caught = e; }
    expect((caught as ApiError)?.code).toBe('PERMISSION_DENIED');
  });
});
