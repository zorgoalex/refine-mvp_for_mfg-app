import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  aggregateByMaterial,
  applyProcurement,
  buildOrderResourceDemandProjection,
  buildScopedOrderWhere,
  demandFingerprint,
  emptyDemandFingerprint,
  parseResourceKey,
  projectOrders,
  summarizeProcurement,
  type ProjectedOrder,
  type ProjectedResourceLine,
  type ResourceProcurementRow,
} from './pg-order-resource-demand-repository';
import { decide, procurementOutboxKey } from './pg-order-resource-procurement-repository';

// --- fixtures -------------------------------------------------------------

function detail(overrides: Record<string, unknown> = {}) {
  return {
    detail_id: 1,
    order_id: 101,
    height: 1000,
    width: 500,
    quantity: 1,
    detail_number: 1,
    detail_name: 'E2E-Тест Деталь',
    updated_at: '2026-09-01T00:00:00.000Z',
    sheet_material_type_id: null,
    sheet_material_name: null,
    supplier_id: null,
    supplier_name: null,
    film_id: null,
    film_name: null,
    vendor_id: null,
    vendor_name: null,
    ...overrides,
  };
}

function hdf(overrides: Record<string, unknown> = {}) {
  return {
    order_hdf_detail_id: 501,
    order_id: 101,
    hdf_height_mm: 400,
    hdf_width_mm: 300,
    quantity: 1,
    hdf_sheet_material_type_id: 11,
    hdf_sheet_material_name: 'E2E-Тест ХДФ Белый',
    supplier_id: 31,
    supplier_name: 'E2E-Тест Поставщик Листов',
    source_detail_number: 1,
    source_detail_name: 'E2E-Тест Деталь',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function placements(yMm: number) {
  return {
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
    sheet_width_mm: 1400,
    sheet_height_mm: 2800,
    pieces: [{
      item_id: 'det-1',
      instance: 1,
      x_mm: 0,
      y_mm: yMm,
      width_mm: 500,
      height_mm: 500,
      rotated: false,
    }],
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    order_id: 101,
    order_name: 'E2E-Тест 101',
    full_number: 'МП-101',
    order_date: '2026-09-01',
    project_code: 'МП',
    client_name: 'E2E-Тест Клиент Иванов',
    updated_at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function demandLine(overrides: Partial<ProjectedResourceLine> = {}): ProjectedResourceLine {
  return {
    resourceKey: 'sheet_material:11',
    kind: 'sheet_material',
    refId: 11,
    name: 'E2E-Тест ЛДСП Белый',
    supplierName: 'E2E-Тест Поставщик Листов',
    quantity: 2.5,
    unit: 'm2',
    areaM2: 2.5,
    detailsCount: 3,
    source: 'area',
    demandFingerprint: 'fp-real',
    details: [],
    ...overrides,
  };
}

function procurementRow(overrides: Partial<ResourceProcurementRow> = {}): ResourceProcurementRow {
  return {
    order_resource_procurement_id: 1,
    order_id: 501,
    resource_kind: 'sheet_material',
    sheet_material_type_id: 11,
    film_id: null,
    resource_name: 'E2E-Тест ЛДСП Белый',
    purchased: false,
    origin: null,
    quantity_at_mark: null,
    unit_at_mark: null,
    demand_fingerprint_at_mark: null,
    marked_at: null,
    marked_by: null,
    marked_by_name: null,
    version: 0,
    ...overrides,
  };
}

function projectedOrder(orderId: number, lines: ProjectedResourceLine[]): ProjectedOrder {
  return {
    orderId,
    base: {
      orderId,
      orderName: `E2E-Тест Заказ ${orderId}`,
      fullNumber: `МП-${orderId}`,
      orderDate: '2026-09-01',
      projectCode: 'МП',
      clientName: 'E2E-Тест Клиент Иванов',
      updatedAt: '2026-09-01T00:00:00.000Z',
      sheetMaterials: [],
      films: [],
    },
    lines,
  };
}

function currentUser(role: CurrentUser['role'], id = '77'): CurrentUser {
  return { id, username: `e2e-test-${role}`, role, roleId: 1, permissions: [] };
}

// --- demandFingerprint -----------------------------------------------------

describe('demandFingerprint', () => {
  const base = {
    kind: 'sheet_material' as const,
    refId: 11,
    quantity: 1,
    source: 'area' as const,
    detailsCount: 2,
    sources: ['d:1:2026-01-01T00:00:00.000Z', 'd:2:2026-01-02T00:00:00.000Z'],
    cutJobIds: [] as number[],
  };

  it('is a 64-char hex sha256 digest', () => {
    expect(demandFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable regardless of sources/cutJobIds order', () => {
    const fp = demandFingerprint(base);
    expect(demandFingerprint({ ...base, sources: [...base.sources].reverse() })).toBe(fp);
    expect(demandFingerprint({ ...base, cutJobIds: [9, 3, 5] })).toBe(
      demandFingerprint({ ...base, cutJobIds: [5, 9, 3] }),
    );
  });

  it('changes when quantity changes', () => {
    expect(demandFingerprint({ ...base, quantity: 2 })).not.toBe(demandFingerprint(base));
  });

  it('changes when detailsCount changes', () => {
    expect(demandFingerprint({ ...base, detailsCount: 3 })).not.toBe(demandFingerprint(base));
  });

  it('changes when source changes', () => {
    expect(demandFingerprint({ ...base, source: 'cut' })).not.toBe(demandFingerprint(base));
  });

  it('changes when a detail updated_at key in sources changes', () => {
    const changed = demandFingerprint({
      ...base,
      sources: ['d:1:2026-01-01T00:00:00.000Z', 'd:2:2026-02-02T00:00:00.000Z'],
    });
    expect(changed).not.toBe(demandFingerprint(base));
  });

  it('changes when the set of cut job ids changes', () => {
    expect(demandFingerprint({ ...base, cutJobIds: [900] })).not.toBe(
      demandFingerprint({ ...base, cutJobIds: [901] }),
    );
  });
});

// --- projectOrders -----------------------------------------------------------

describe('projectOrders', () => {
  it('produces a sheet line in m2 with quantity equal to the rounded detail area', () => {
    const result = projectOrders({
      orders: [order()],
      details: [
        detail({ detail_id: 1, height: 1000, width: 500, quantity: 2, sheet_material_type_id: 11, sheet_material_name: 'E2E-Тест ЛДСП Белый', supplier_id: 31, supplier_name: 'E2E-Тест Поставщик Листов' }),
        detail({ detail_id: 2, height: 500, width: 500, quantity: 1, sheet_material_type_id: 11, sheet_material_name: 'E2E-Тест ЛДСП Белый', supplier_id: 31, supplier_name: 'E2E-Тест Поставщик Листов' }),
      ],
      detailCutJobs: [],
      cutGroups: [],
      cutSheets: [],
    });

    const lines = result.lines.get(101)!;
    expect(lines).toHaveLength(1);
    const [sheetLine] = lines;
    expect(sheetLine).toMatchObject({
      resourceKey: 'sheet_material:11',
      kind: 'sheet_material',
      refId: 11,
      unit: 'm2',
      source: 'area',
      quantity: 1.25,
      areaM2: 1.25,
      detailsCount: 2,
    });
    expect(sheetLine.details.map((d) => d.id)).toEqual([1, 2]);
  });

  it('produces a film line with null quantity and source none when there is no cut data', () => {
    const result = projectOrders({
      orders: [order()],
      details: [
        detail({ detail_id: 1, height: 1000, width: 500, quantity: 1, film_id: 21, film_name: 'E2E-Тест Плёнка Белая', vendor_id: 41, vendor_name: 'E2E-Тест Плёнка ООО' }),
      ],
      detailCutJobs: [],
      cutGroups: [],
      cutSheets: [],
    });

    const lines = result.lines.get(101)!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      resourceKey: 'film:21',
      kind: 'film',
      refId: 21,
      unit: 'lm',
      source: 'none',
      quantity: null,
    });
  });

  it('produces a film line with cut-derived quantity and source cut when a ready manual layout provides film usage', () => {
    const result = projectOrders({
      orders: [order()],
      details: [
        detail({ detail_id: 1, height: 1000, width: 500, quantity: 1, film_id: 21, film_name: 'E2E-Тест Плёнка Белая', vendor_id: 41, vendor_name: 'E2E-Тест Плёнка ООО' }),
      ],
      detailCutJobs: [{ order_detail_id: 1, cut_job_id: 900 }],
      cutGroups: [{
        cut_job_id: 900,
        cut_group_id: 901,
        summary: { engine_used: 'vacuum_table' },
        sheet_material_name: 'Ванна 1400',
        sheet_material_width_mm: 1400,
        sheet_material_height_mm: 2800,
        manual_is_active: true,
        manual_is_stale: false,
        manual_sheets: [{ sheetIndex: 0, placements: placements(0) }],
      }],
      cutSheets: [],
    });

    const lines = result.lines.get(101)!;
    const filmLine = lines.find((l) => l.kind === 'film')!;
    expect(filmLine).toMatchObject({ source: 'cut' });
    expect(filmLine.quantity).not.toBeNull();
    expect(filmLine.quantity).toBeGreaterThan(0);
  });

  it('carries detail and HDF refs on the same sheet material line', () => {
    const result = projectOrders({
      orders: [order()],
      details: [
        detail({ detail_id: 1, sheet_material_type_id: 11, sheet_material_name: 'E2E-Тест ЛДСП Белый' }),
      ],
      hdfDetails: [hdf({ order_hdf_detail_id: 501, hdf_sheet_material_type_id: 11, hdf_sheet_material_name: 'E2E-Тест ЛДСП Белый' })],
      detailCutJobs: [],
      cutGroups: [],
      cutSheets: [],
    });

    const lines = result.lines.get(101)!;
    const sheetLine = lines.find((l) => l.kind === 'sheet_material')!;
    expect(sheetLine.details).toHaveLength(2);
    expect(sheetLine.details.map((d) => d.source).sort()).toEqual(['detail', 'hdf']);
  });

  it('buildOrderResourceDemandProjection (legacy) returns base rows without a lines key', () => {
    const legacy = buildOrderResourceDemandProjection({
      orders: [order()],
      details: [detail({ detail_id: 1, sheet_material_type_id: 11, sheet_material_name: 'E2E-Тест ЛДСП Белый' })],
      detailCutJobs: [],
      cutGroups: [],
      cutSheets: [],
    });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).not.toHaveProperty('lines');
    expect(legacy[0]).toHaveProperty('sheetMaterials');
  });
});

// --- applyProcurement --------------------------------------------------------

describe('applyProcurement', () => {
  it('reports version 0 and not purchased when there is no procurement row', () => {
    const [result] = applyProcurement([demandLine()], []);
    expect(result.line.procurement).toMatchObject({ purchased: false, version: 0 });
    expect(result.line.orphan).toBe(false);
  });

  it('reports changedSinceMark false when the purchased row fingerprint matches the current demand', () => {
    const line = demandLine({ demandFingerprint: 'fp-real' });
    const row = procurementRow({ purchased: true, version: 2, demand_fingerprint_at_mark: 'fp-real' });
    const [result] = applyProcurement([line], [row]);
    expect(result.line.procurement).toMatchObject({ purchased: true, changedSinceMark: false });
  });

  it('reports changedSinceMark true when the purchased row fingerprint differs from the current demand', () => {
    const line = demandLine({ demandFingerprint: 'fp-real' });
    const row = procurementRow({ purchased: true, version: 2, demand_fingerprint_at_mark: 'fp-old' });
    const [result] = applyProcurement([line], [row]);
    expect(result.line.procurement).toMatchObject({ purchased: true, changedSinceMark: true });
  });

  it('returns an orphan line when a purchased mark no longer matches any demand line', () => {
    const row = procurementRow({ purchased: true, version: 3, resource_kind: 'film', film_id: 21, sheet_material_type_id: null, demand_fingerprint_at_mark: 'fp-old' });
    const result = applyProcurement([], [row]);
    expect(result).toHaveLength(1);
    expect(result[0].line).toMatchObject({
      resourceKey: 'film:21',
      quantity: 0,
      source: 'none',
      orphan: true,
      demandFingerprint: emptyDemandFingerprint('film', 21),
    });
    expect(result[0].line.procurement.purchased).toBe(true);
  });

  it('does not list an unpurchased procurement row for a resource no longer in demand', () => {
    const row = procurementRow({ purchased: false, version: 1 });
    const result = applyProcurement([], [row]);
    expect(result).toHaveLength(0);
  });
});

// --- summarizeProcurement -----------------------------------------------------

describe('summarizeProcurement', () => {
  it('excludes orphans from total/purchased but counts orphanPurchased separately', () => {
    const lines = [
      { ...demandLine({ resourceKey: 'sheet_material:11' }), orphan: false, procurement: { purchased: true, version: 1, origin: 'manual' as const, markedAt: null, markedBy: null, quantityAtMark: null, unitAtMark: null, changedSinceMark: false } },
      { ...demandLine({ resourceKey: 'sheet_material:12' }), orphan: false, procurement: { purchased: false, version: 0, origin: null, markedAt: null, markedBy: null, quantityAtMark: null, unitAtMark: null, changedSinceMark: false } },
      { ...demandLine({ resourceKey: 'film:21' }), orphan: true, procurement: { purchased: true, version: 2, origin: 'manual' as const, markedAt: null, markedBy: null, quantityAtMark: null, unitAtMark: null, changedSinceMark: true } },
    ];
    expect(summarizeProcurement(lines)).toEqual({ total: 2, purchased: 1, orphanPurchased: 1 });
  });
});

// --- aggregateByMaterial ---------------------------------------------------

describe('aggregateByMaterial', () => {
  it('sums quantities per resourceKey, counts no-data/purchased orders and lists participants', () => {
    const orderA = projectedOrder(501, [demandLine({ resourceKey: 'film:7', kind: 'film', refId: 7, unit: 'lm', quantity: 1.5, source: 'cut', demandFingerprint: 'fp-a' })]);
    const orderB = projectedOrder(502, [demandLine({ resourceKey: 'film:7', kind: 'film', refId: 7, unit: 'lm', quantity: null, source: 'none', demandFingerprint: 'fp-b' })]);
    const procurement = [
      procurementRow({ order_id: 501, resource_kind: 'film', film_id: 7, sheet_material_type_id: null, purchased: true, version: 3, demand_fingerprint_at_mark: 'fp-a' }),
    ];

    const result = aggregateByMaterial([orderA, orderB], procurement);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      resourceKey: 'film:7',
      totalQuantity: 1.5,
      ordersCount: 2,
      noDataOrders: 1,
      purchasedOrders: 1,
    });
    expect(result[0].participants).toEqual([
      { orderId: 501, orderName: orderA.base.orderName, purchased: true, version: 3, demandFingerprint: 'fp-a' },
      { orderId: 502, orderName: orderB.base.orderName, purchased: false, version: 0, demandFingerprint: 'fp-b' },
    ]);
  });

  it('excludes orphan purchased marks from the aggregate entirely', () => {
    const orderC = projectedOrder(503, []);
    const procurement = [procurementRow({ order_id: 503, resource_kind: 'film', film_id: 9, sheet_material_type_id: null, purchased: true, version: 1 })];
    expect(aggregateByMaterial([orderC], procurement)).toEqual([]);
  });
});

// --- parseResourceKey -------------------------------------------------------

describe('parseResourceKey', () => {
  it.each([
    ['sheet_material:12', { kind: 'sheet_material', refId: 12 }],
    ['film:7', { kind: 'film', refId: 7 }],
  ] as const)('accepts %s', (input, expected) => {
    expect(parseResourceKey(input)).toEqual(expected);
  });

  it.each([
    ['film:0'],
    ['film:-1'],
    ['glass:1'],
    ['film:1x'],
    [''],
  ])('rejects %s', (input) => {
    expect(parseResourceKey(input)).toBeNull();
  });
});

// --- procurementOutboxKey ---------------------------------------------------

describe('procurementOutboxKey', () => {
  it('contains the orderId, resourceKey and version', () => {
    const key = procurementOutboxKey(501, 'sheet_material:11', 3);
    expect(key).toContain('501');
    expect(key).toContain('sheet_material:11');
    expect(key).toContain('3');
  });

  it('gives different orders a different key for the same requestId/resourceKey/version', () => {
    const keyA = procurementOutboxKey(501, 'sheet_material:11', 1);
    const keyB = procurementOutboxKey(502, 'sheet_material:11', 1);
    expect(keyA).not.toBe(keyB);
  });
});

// --- buildScopedOrderWhere ---------------------------------------------------

describe('buildScopedOrderWhere', () => {
  it('adds no actor param for an all-scoped role', () => {
    const { whereSql, params } = buildScopedOrderWhere(currentUser('admin'));
    expect(params).toEqual([]);
    expect(whereSql).not.toContain('$');
  });

  it('pushes the actor id for an own-scoped role', () => {
    const { whereSql, params } = buildScopedOrderWhere(currentUser('manager', '42'));
    expect(params).toEqual([42]);
    expect(whereSql).toContain('o.created_by = $1');
  });

  it('pushes the actor id for an assigned-scoped role', () => {
    const { whereSql, params } = buildScopedOrderWhere(currentUser('worker', '15'));
    expect(params).toEqual([15]);
    expect(whereSql).toContain('assigned_user.user_id = $1');
  });

  it('adds an order_id predicate at the next placeholder for a scoped role', () => {
    const { whereSql, params } = buildScopedOrderWhere(currentUser('manager', '42'), 555);
    expect(params).toEqual([42, 555]);
    expect(whereSql).toContain('o.order_id = $2');
  });

  it('adds only the order_id predicate for an all-scoped role', () => {
    const { whereSql, params } = buildScopedOrderWhere(currentUser('admin'), 555);
    expect(params).toEqual([555]);
    expect(whereSql).toContain('o.order_id = $1');
  });
});

// --- decide (procurement command decision matrix, plan §4.3) --------------

describe('decide', () => {
  const resourceKey = 'sheet_material:11';

  it('is a no-op on repeat-to-current-state even with a stale expectedVersion (lost-response retry)', () => {
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const row = procurementRow({ purchased: true, version: 5, demand_fingerprint_at_mark: 'fp-real' });
    const result = decide(projectedOrder(501, demand), [row], resourceKey, true, { expectedVersion: 0, expectedDemandFingerprint: 'fp-real' });
    expect(result.type).toBe('noop');
  });

  it('rejects a stale expectedVersion when the target state is a real change', () => {
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const row = procurementRow({ purchased: false, version: 2 });
    const result = decide(projectedOrder(501, demand), [row], resourceKey, true, { expectedVersion: 0, expectedDemandFingerprint: 'fp-real' });
    expect(result).toMatchObject({ type: 'conflict', code: 'PROCUREMENT_VERSION_CONFLICT' });
  });

  it('rejects marking a resource that is not part of the order demand', () => {
    const result = decide(projectedOrder(501, []), [], resourceKey, true, { expectedVersion: 0, expectedDemandFingerprint: 'fp-real' });
    expect(result).toMatchObject({ type: 'conflict', code: 'PROCUREMENT_RESOURCE_NOT_IN_ORDER' });
  });

  it('rejects marking with a stale demand fingerprint', () => {
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const result = decide(projectedOrder(501, demand), [], resourceKey, true, { expectedVersion: 0, expectedDemandFingerprint: 'fp-stale' });
    expect(result).toMatchObject({ type: 'conflict', code: 'PROCUREMENT_DEMAND_CHANGED' });
  });

  it('allows unmarking even with a stale demand fingerprint', () => {
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-real' });
    const result = decide(projectedOrder(501, demand), [row], resourceKey, false, { expectedVersion: 1, expectedDemandFingerprint: 'fp-stale' });
    expect(result.type).toBe('apply');
  });

  it('allows unmarking an orphan purchased row (resource no longer in demand)', () => {
    const row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-old' });
    const result = decide(projectedOrder(501, []), [row], resourceKey, false, { expectedVersion: 1, expectedDemandFingerprint: 'anything' });
    expect(result.type).toBe('apply');
    if (result.type === 'apply') {
      expect(result.line.orphan).toBe(true);
    }
  });

  it('follows the documented mark/unmark/mark sequence and rejects a stale replay against the current version', () => {
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];

    // false/v0 -> A(true, expected=0)
    let result = decide(projectedOrder(501, demand), [], resourceKey, true, { expectedVersion: 0, expectedDemandFingerprint: 'fp-real' });
    expect(result).toMatchObject({ type: 'apply' });

    // true/v1 -> B(false, expected=1)
    let row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-real' });
    result = decide(projectedOrder(501, demand), [row], resourceKey, false, { expectedVersion: 1, expectedDemandFingerprint: 'fp-real' });
    expect(result).toMatchObject({ type: 'apply' });

    // false/v2 -> A(true, expected=2)
    row = procurementRow({ purchased: false, version: 2 });
    result = decide(projectedOrder(501, demand), [row], resourceKey, true, { expectedVersion: 2, expectedDemandFingerprint: 'fp-real' });
    expect(result).toMatchObject({ type: 'apply' });

    // true/v3 -> B replayed with the old expected=1 -> conflict
    row = procurementRow({ purchased: true, version: 3, demand_fingerprint_at_mark: 'fp-real' });
    result = decide(projectedOrder(501, demand), [row], resourceKey, false, { expectedVersion: 1, expectedDemandFingerprint: 'fp-real' });
    expect(result).toMatchObject({ type: 'conflict', code: 'PROCUREMENT_VERSION_CONFLICT' });
  });
});

describe('capabilities follow the procurement flag (rollback returns phase 1 UI)', () => {
  it('turns every phase-2 capability off with the flag and on with it', async () => {
    const { capabilities } = await import('./pg-order-resource-demand-repository');
    expect(capabilities({ procurementEnabled: false })).toEqual({ procurement: false, byMaterial: false, cardDetails: false, onecDocuments: false });
    expect(capabilities({ procurementEnabled: true })).toEqual({ procurement: true, byMaterial: true, cardDetails: true, onecDocuments: false });
  });

  it('uses the runtime-configured scope of the user, not only the static role policy', async () => {
    const { buildScopedOrderWhere } = await import('./pg-order-resource-demand-repository');
    const { ROLE_POLICIES } = await import('../../../permissions/policies/role-policies');
    const restricted = {
      id: '42', username: 'E2E-Тест-оператор', role: 'admin' as const, roleId: 1, permissions: ['orders.view' as const],
      policyScopes: { ...ROLE_POLICIES.admin, orders: { ...ROLE_POLICIES.admin.orders, view: 'none' as const } },
    };
    expect(buildScopedOrderWhere(restricted).whereSql).toContain('FALSE');
    const own = { ...restricted, policyScopes: { ...ROLE_POLICIES.admin, orders: { ...ROLE_POLICIES.admin.orders, view: 'own' as const } } };
    const where = buildScopedOrderWhere(own);
    expect(where.whereSql).toContain('o.created_by = $1');
    expect(where.params).toEqual([42]);
  });
});
