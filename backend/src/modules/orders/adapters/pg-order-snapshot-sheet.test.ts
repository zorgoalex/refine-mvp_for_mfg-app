/**
 * Unit tests for SP3 sheet-material support in the snapshot path.
 * Covers:
 *  - mapOrderHeaderSnapshot includes sheetMaterialTypeId on export
 *  - mapDetailSnapshot includes sheetMaterialTypeId on export (and materialId is null-safe)
 *  - orderHeaderInsertParams / orderHeaderUpdateParams include sheet_material_type_id
 *    and enforce the header invariant (force material_id NULL when sheetMaterialTypeId set)
 *  - detailValues includes sheetMaterialTypeId as the last param
 *  - OrderSnapshotService.importOrderSnapshot gates on sheet_materials.view when
 *    the incoming snapshot payload contains a sheetMaterialTypeId
 *  - Variant B (Task 4): export materialId is null when DB material_id is NULL (post-034)
 *  - Variant B (Task 4): import sanitization strips materialId from legacy Variant-A payloads
 *    when sheetMaterialTypeId is present, before prepareOrderSave/validation
 */
import JSZip from 'jszip';
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
  _testOnlyNullifyMaterialIdForSheetEntries as nullifyMaterialIdForSheetEntries,
  _testOnlySnapshotToSaveOrderDto as snapshotToSaveOrderDto,
  buildSheetValidationDetails,
} from './pg-order-snapshot';
import { assertSheetEligibilityAndNoClear } from '../domain/sheet-order-validation';

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

// ── buildSheetValidationDetails (SP3 no-flip on import, tier2 R2 finding 3) ──
// The import no-flip/no-clear guard must resolve each snapshot detail's LOCAL detail_id
// through the import map (sourceId → localId), NOT by assuming source id == local id. With a
// remapped/cross-instance sourceId the old code left detailId undefined → an existing legacy
// detail was treated as new and could flip NULL→sheet on import.
describe('buildSheetValidationDetails — import detail identity resolution', () => {
  it('resolves detailId from the import map even when sourceId != local detail_id', () => {
    const map = new Map<string, number>([['SRC-9', 1]]); // source "SRC-9" maps to local detail 1
    const result = buildSheetValidationDetails(
      [{ sourceId: 'SRC-9', sheetMaterialTypeId: 7, materialId: null, height: 100, width: 100 }],
      map,
    );
    expect(result[0].detailId).toBe(1);
  });

  it('leaves detailId undefined for an unmapped (brand-new) source detail', () => {
    const result = buildSheetValidationDetails(
      [{ sourceId: 'NEW-1', sheetMaterialTypeId: 7, materialId: null, height: 100, width: 100 }],
      new Map(),
    );
    expect(result[0].detailId).toBeUndefined();
  });

  it('BLOCKS a NULL→sheet flip on import for a remapped existing legacy detail', () => {
    // Local detail 1 is stored legacy (sheet id NULL). The snapshot detail has a DIFFERENT
    // source id "SRC-9" that maps to local 1. With correct resolution the flip is caught.
    const map = new Map<string, number>([['SRC-9', 1]]);
    const details = buildSheetValidationDetails(
      [{ sourceId: 'SRC-9', sheetMaterialTypeId: 7, materialId: null, height: 100, width: 100 }],
      map,
    );
    let caught: unknown;
    try {
      assertSheetEligibilityAndNoClear({
        eligible: true,
        storedHeaderSheetId: null,
        storedDetailSheetIds: [{ detailId: 1, sheetMaterialTypeId: null }],
        header: { sheetMaterialTypeId: null, materialId: 5 },
        details,
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as ApiError | undefined) ?? null).not.toBeNull();
    const fields = (((caught as { details?: { errors?: Array<{ field: string }> } })?.details?.errors) ?? []).map(
      (x) => x.field,
    );
    expect(fields).toContain('details[0].sheetMaterialTypeId');
  });
});

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

  it('gate checks header sheetMaterialTypeId in snapshot.data.order (single)', async () => {
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

// ── OrderSnapshotService — BATCH sheet_materials.view gate (tier2 R3 finding 1) ──
// The batch path must enforce sheet_materials.view exactly like single-file import; the
// adapter batch loops to its own internal import and never re-applies the service gate.
async function zipBase64Of(...snapshots: unknown[]): Promise<string> {
  const zip = new JSZip();
  snapshots.forEach((s, i) => zip.file(`order-${i}.erp-order.json`, JSON.stringify(s)));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf.toString('base64');
}

describe('OrderSnapshotService — sheet_materials.view gate on BATCH import', () => {
  it('denies a batch containing a sheet-bearing snapshot without sheet_materials.view', async () => {
    const snapshots = fakeSnapshots();
    const service = new OrderSnapshotService({
      snapshots,
      permissions: mockPermissions(financeImportAllow(false)),
    });
    const zipBase64 = await zipBase64Of(minimalSnapshotWithSheet(null), minimalSnapshotWithSheet(5));
    let caught: unknown;
    try {
      await service.importOrderSnapshotBatch({ currentUser: makeUser({}), zipBase64 });
    } catch (e) {
      caught = e;
    }
    expect((caught as ApiError)?.code).toBe('PERMISSION_DENIED');
    expect((caught as ApiError)?.details).toMatchObject({ requiredPermissions: ['sheet_materials.view'] });
    expect(snapshots.importOrderSnapshotBatch).not.toHaveBeenCalled();
  });

  it('allows a sheet-bearing batch when the user has sheet_materials.view', async () => {
    const snapshots = fakeSnapshots();
    const service = new OrderSnapshotService({
      snapshots,
      permissions: mockPermissions(financeImportAllow(true)),
    });
    const zipBase64 = await zipBase64Of(minimalSnapshotWithSheet(5));
    await expect(
      service.importOrderSnapshotBatch({ currentUser: makeUser({}), zipBase64 }),
    ).resolves.toMatchObject({ success: true });
    expect(snapshots.importOrderSnapshotBatch).toHaveBeenCalled();
  });

  it('allows a non-sheet batch without sheet_materials.view', async () => {
    const snapshots = fakeSnapshots();
    const service = new OrderSnapshotService({
      snapshots,
      permissions: mockPermissions(financeImportAllow(false)),
    });
    const zipBase64 = await zipBase64Of(minimalSnapshotWithSheet(null), minimalSnapshotWithSheet(null));
    await expect(
      service.importOrderSnapshotBatch({ currentUser: makeUser({}), zipBase64 }),
    ).resolves.toMatchObject({ success: true });
    expect(snapshots.importOrderSnapshotBatch).toHaveBeenCalled();
  });
});

// ── Variant B (Task 4): export null-safe materialId ───────────────────────
// Post-034 migration, material_id IS NULL in the DB for all order_details.
// The export serializer must emit materialId: null, not NaN or 0.

describe('mapDetailSnapshot — Variant B: null-safe materialId export', () => {
  it('exports a sheet detail with materialId null when DB material_id is NULL', () => {
    const result = mapDetailSnapshot(makeDetailRow({ material_id: null, sheet_material_type_id: 2 }));
    expect(result.materialId).toBeNull();
    expect(result.sheetMaterialTypeId).toBe(2);
  });

  it('exports a non-sheet detail with materialId null when DB material_id is NULL', () => {
    // Legacy path: post-034 even non-sheet rows have material_id NULL in DB
    const result = mapDetailSnapshot(makeDetailRow({ material_id: null, sheet_material_type_id: null }));
    expect(result.materialId).toBeNull();
  });

  it('still exports a numeric materialId when the DB row has a non-null material_id', () => {
    // Backward compatibility: existing rows with material_id set still serialize correctly
    const result = mapDetailSnapshot(makeDetailRow({ material_id: 99, sheet_material_type_id: 5 }));
    expect(result.materialId).toBe(99);
    expect(result.sheetMaterialTypeId).toBe(5);
  });
});

// ── Variant B (Task 4): import sanitization (Critic R15 B1) ─────────────────
// A Variant-A export carries a real materialId (shadow) alongside sheetMaterialTypeId.
// Before prepareOrderSave/validation, the snapshot builder must NULL out materialId
// for any header/detail that has a non-null sheetMaterialTypeId.
// Anti-injection guard stays active only for sheetMaterialTypeId==null rows.

describe('nullifyMaterialIdForSheetEntries — import sanitization', () => {
  it('nulls materialId in a detail when sheetMaterialTypeId is set (Variant-A legacy payload)', () => {
    const details = [{ materialId: 7, sheetMaterialTypeId: 2 }];
    const result = nullifyMaterialIdForSheetEntries(details);
    expect(result[0].materialId).toBeNull();
    expect(result[0].sheetMaterialTypeId).toBe(2);
  });

  it('preserves materialId in a detail when sheetMaterialTypeId is null', () => {
    const details = [{ materialId: 3, sheetMaterialTypeId: null }];
    const result = nullifyMaterialIdForSheetEntries(details);
    expect(result[0].materialId).toBe(3);
  });

  it('handles a detail where materialId is already null and sheetMaterialTypeId is set', () => {
    const details = [{ materialId: null, sheetMaterialTypeId: 2 }];
    const result = nullifyMaterialIdForSheetEntries(details);
    expect(result[0].materialId).toBeNull();
    expect(result[0].sheetMaterialTypeId).toBe(2);
  });

  it('handles a detail where materialId is undefined and sheetMaterialTypeId is set', () => {
    const details = [{ sheetMaterialTypeId: 2 }];
    const result = nullifyMaterialIdForSheetEntries(details as Array<{ materialId?: number | null; sheetMaterialTypeId?: number | null }>);
    expect(result[0].materialId).toBeNull();
  });

  it('processes multiple details: nulls only sheet ones, preserves legacy ones', () => {
    const details = [
      { materialId: 7, sheetMaterialTypeId: 2 },   // sheet → null materialId
      { materialId: 3, sheetMaterialTypeId: null }, // legacy → keep materialId
      { materialId: null, sheetMaterialTypeId: 5 }, // already null + sheet → stays null
    ];
    const result = nullifyMaterialIdForSheetEntries(details);
    expect(result[0].materialId).toBeNull();
    expect(result[1].materialId).toBe(3);
    expect(result[2].materialId).toBeNull();
  });
});

// ── Variant B (Critic R2 MAJOR Finding 1): unconditional header materialId null on import ─
// A header-only legacy snapshot that carries a materialId with NO header sheetMaterialTypeId
// must import without throwing (the header materialId is always dropped regardless of whether
// a sheetMaterialTypeId is present). Before the fix, the conditional sanitizer only cleared
// materialId when sheetMaterialTypeId != null, leaving header-only legacy payloads to fail
// validation with 422.

describe('snapshotToSaveOrderDto — header-only legacy import (Critic R2 MAJOR Finding 1)', () => {
  function makeMinimalSnapshot(headerOverrides: Record<string, unknown> = {}): import('../dto/order-snapshot.dto').OrderSnapshotDto {
    return {
      schema: ORDER_SNAPSHOT_SCHEMA,
      formatVersion: ORDER_SNAPSHOT_FORMAT_VERSION,
      exporterService: {
        name: 'erp-order-snapshot' as const,
        version: '1.0.0',
        compatibleImportVersions: ['1.0.0'],
      },
      source: { sourceInstanceId: 'test-inst', exportedAt: '2026-06-22T00:00:00.000Z', payloadHash: '' },
      identity: {
        order: { sourceId: '42', refKey1c: null },
        client: { sourceId: '10', refKey1c: null },
      },
      data: {
        client: { sourceId: '10', clientName: 'Test Client', refKey1c: null, notes: null, isActive: true },
        clientPhones: [],
        order: {
          sourceId: '42',
          orderName: 'Legacy-Header-Only',
          clientId: 10,
          orderDate: '2026-06-22',
          orderStatusId: 1,
          ...headerOverrides,
        } as import('../dto/order-snapshot.dto').OrderSnapshotHeaderDto,
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

  it('does not throw when header has materialId set but NO header sheetMaterialTypeId', () => {
    // Regression: before the fix, this would have produced a DTO with materialId=7 on the
    // header, which the Task-5 validator then rejected with 422. Now materialId is always
    // nulled unconditionally on the header, so the DTO passes validation.
    const snapshot = makeMinimalSnapshot({ materialId: 7, sheetMaterialTypeId: null });
    expect(() =>
      snapshotToSaveOrderDto(snapshot, 10, {
        details: [],
        payments: [],
        workshops: [],
        requirements: [],
        dowelingLinks: [],
      }),
    ).not.toThrow();
  });

  it('resulting header materialId is null for a header-only legacy snapshot', () => {
    const snapshot = makeMinimalSnapshot({ materialId: 7, sheetMaterialTypeId: null });
    const dto = snapshotToSaveOrderDto(snapshot, 10, {
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
    });
    expect(dto.header.materialId).toBeNull();
  });

  it('resulting header materialId is null even when sheetMaterialTypeId is also set (Variant-A double-field export)', () => {
    const snapshot = makeMinimalSnapshot({ materialId: 99, sheetMaterialTypeId: 5 });
    const dto = snapshotToSaveOrderDto(snapshot, 10, {
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
    });
    expect(dto.header.materialId).toBeNull();
    expect(dto.header.sheetMaterialTypeId).toBe(5);
  });
});
