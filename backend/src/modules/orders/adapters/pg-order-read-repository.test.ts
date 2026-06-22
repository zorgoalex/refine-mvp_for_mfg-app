import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgOrderReadRepository } from './pg-order-read-repository';

describe('PgOrderReadRepository', () => {
  it('lists orders with pagination, whitelist sort and soft-delete filter', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await expect(
      repository.listOrders({
        currentUser: currentUser('42'),
        query: {
          page: 2,
          pageSize: 10,
          sortBy: 'debtAmount',
          sortOrder: 'asc',
          search: 'client',
          dateFrom: '2026-05-01',
          onlyMyOrders: true,
        },
      }),
    ).resolves.toMatchObject({
      data: [
        {
          orderId: 100,
          orderName: 'A-100',
          debtAmount: 70,
          notes: 'List note',
          materialIds: [10, 11],
          materialNames: ['MDF 16', 'MDF 18'],
          millingTypeId: 1,
          millingTypeName: 'Modern',
          dowelingOrderId: 700,
          dowelingOrderName: '1368',
          designEngineerId: 8,
          passedProductionStatusCodes: ['cut', 'paint'],
          createdBy: 15,
          editedBy: 16,
          version: 3,
        },
      ],
      pagination: {
        page: 2,
        pageSize: 10,
        total: 11,
        totalPages: 2,
      },
    });

    const listQuery = database.queries.find((query) => query.text.includes('LIMIT'))?.text ?? '';
    expect(listQuery).toContain('o.delete_flag = false');
    expect(listQuery).toContain('LEFT JOIN LATERAL');
    expect(listQuery).toContain('FROM order_details od');
    expect(listQuery).toContain('FROM order_doweling_links odl');
    expect(listQuery).toContain('FROM production_status_events pse');
    expect(listQuery).toContain('ORDER BY (o.final_amount - o.paid_amount) ASC');
    expect(database.queries.at(-1)?.params).toEqual(['%client%', '2026-05-01', 42, 10, 10]);
  });

  it('loads full order aggregate from base tables', async () => {
    const repository = new PgOrderReadRepository(createDatabase().service);

    await expect(
      repository.getOrderById({
        currentUser: currentUser('42'),
        orderId: 100,
      }),
    ).resolves.toMatchObject({
      header: {
        orderId: 100,
        orderName: 'A-100',
        clientId: 5,
        clientName: 'Client',
        paymentStatusId: 2,
        createdBy: 15,
        editedBy: 16,
      },
      details: [{ id: 200, detailNumber: 1, detailCost: 120 }],
      payments: [{ id: 300, amount: 50 }],
      workshops: [{ id: 400, workshopId: 1 }],
      requirements: [{ id: 500, resourceType: 'material' }],
      dowelingLinks: [
        {
          id: 600,
          dowelingOrderId: 700,
          designEngineerId: 8,
          dowelingOrder: {
            id: 700,
            name: '1368',
            designEngineerId: 8,
          },
        },
      ],
      totals: {
        totalAmount: 120,
        paidAmount: 50,
        debtAmount: 70,
      },
      version: 3,
    });
  });

  it('loads order audit events filtered by order entity and related order id', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await expect(
      repository.getOrderAudit({
        currentUser: currentUser('15'),
        orderId: 100,
        page: 2,
        pageSize: 25,
        requestId: 'request-audit-1',
      }),
    ).resolves.toEqual({
      data: [
        {
          auditId: 'audit-1',
          entityType: 'order',
          entityId: '100',
          action: 'orders.status_change',
          userId: 15,
          username: 'top-manager',
          role: 'top_manager',
          before: { statusId: 1 },
          after: { statusId: 2 },
          diff: { statusId: { before: 1, after: 2 } },
          requestId: 'request-command-1',
          ip: null,
          userAgent: 'vitest',
          createdAt: '2026-05-01T12:00:00.000Z',
        },
      ],
      pagination: {
        page: 2,
        pageSize: 25,
        total: 11,
        totalPages: 1,
      },
      requestId: 'request-audit-1',
    });

    const auditQueries = database.queries.filter((query) => query.text.includes('FROM audit_log'));
    expect(auditQueries).toHaveLength(2);
    expect(auditQueries[0].text).toContain("entity_type = 'order' AND entity_id = $1");
    expect(auditQueries[0].text).toContain('OR related_order_id = $2');
    expect(auditQueries[1].text).toContain('ORDER BY created_at DESC, audit_id DESC');
    expect(auditQueries[1].params).toEqual(['100', 100, 25, 25]);
  });

  it('loads active order form reference data with stable API field names', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await expect(
      repository.getOrderFormData({
        currentUser: currentUser('42'),
      }),
    ).resolves.toEqual({
      clients: [{ id: 1, name: 'Client A' }],
      materials: [{ id: 10, name: 'MDF 16', unitId: 2 }],
      millingTypes: [{ id: 20, name: 'Modern', costPerSqm: 120.5 }],
      edgeTypes: [{ id: 30, name: 'PVC 2mm' }],
      films: [{ id: 40, name: 'White matte' }],
      orderStatuses: [{ id: 50, name: 'New', code: null, color: '#ffffff' }],
      paymentStatuses: [{ id: 60, name: 'Unpaid', code: null, color: '#ff0000' }],
      paymentTypes: [{ id: 70, name: 'Cash' }],
      productionStatuses: [{ id: 80, name: 'Cut', code: 'cut', color: '#00ff00' }],
      workshops: [{ id: 90, name: 'Main workshop' }],
      employees: [{ id: 100, fullName: 'Test Employee' }],
      units: [{ id: 110, code: 'pcs', name: 'Pieces', symbol: 'pcs' }],
      // SP3: repo always returns sheet types (dumb); the service masks by perm.
      sheetMaterialTypes: [
        { id: 200, name: 'МДФ 16', widthMm: 2800, heightMm: 2070, isActive: true },
      ],
    });

    const referenceQueries = database.queries.slice(-13).map((query) => query.text);
    expect(referenceQueries.join('\n')).toContain('FROM clients');
    expect(referenceQueries.join('\n')).toContain('FROM payment_statuses');
    expect(referenceQueries.join('\n')).toContain('FROM sheet_material_types');
    expect(referenceQueries.join('\n')).not.toContain('payment_status_code');
    // SP3 Task 10b: the form material dropdown never offers synthetic shadow rows.
    expect(referenceQueries.find((query) => query.includes('FROM materials'))).toContain(
      'is_sheet_shadow = false',
    );
    // sheet_material_types is fetched WITHOUT an is_active filter (active+inactive),
    // so the is_active query count stays 11.
    expect(referenceQueries.filter((query) => query.includes('WHERE is_active = true'))).toHaveLength(
      11,
    );
  });
});

// SP3 tier2 finding 4: backend order reads must be deployable BEFORE migration 029.
// With sheetOrdersReads=false the generated SQL must reference NO migration-029 schema
// (sheet_material_type_id / sheet_eligible / is_sheet_shadow / sheet_material_types joins),
// so order list/show/form-data work against a pre-029 database.
describe('PgOrderReadRepository sheetOrdersReads gate', () => {
  const SHEET_029_TOKENS = [
    'o.sheet_material_type_id',
    'od.sheet_material_type_id',
    'o.sheet_eligible',
    'is_sheet_shadow = false',
    'sheet_material_types hsmt',
    'sheet_material_types smt',
  ];

  async function collectSql(sheetOrdersReads: boolean): Promise<string> {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service, sheetOrdersReads);
    await repository.listOrders({ currentUser: currentUser('42'), query: { page: 1, pageSize: 10 } });
    await repository.getOrderById({ currentUser: currentUser('42'), orderId: 100 });
    await repository.getOrderFormData({ currentUser: currentUser('42') });
    return database.queries.map((q) => q.text).join('\n');
  }

  it('omits ALL migration-029 sheet schema when the flag is off', async () => {
    const sql = await collectSql(false);
    for (const token of SHEET_029_TOKENS) {
      expect(sql).not.toContain(token);
    }
    // legacy material name still resolved from materials only
    expect(sql).toContain('m.material_name AS material_name');
  });

  it('includes migration-029 sheet schema when the flag is on', async () => {
    const sql = await collectSql(true);
    expect(sql).toContain('o.sheet_material_type_id');
    expect(sql).toContain('o.sheet_eligible');
    expect(sql).toContain('is_sheet_shadow = false');
    // Variant B (flag-ON): sheet name is smt.name directly — no COALESCE fallback to materials
    expect(sql).not.toContain('COALESCE(smt.name, m.material_name)');
    expect(sql).toContain('smt.name');
    // No materials join in the flag-ON detail/header reads
    expect(sql).not.toContain('LEFT JOIN materials m ON m.material_id = od.material_id');
    expect(sql).not.toContain('LEFT JOIN materials m ON m.material_id = o.material_id');
    // Aggregate groups by sheet_material_type_id, not material_id
    expect(sql).toContain('od.sheet_material_type_id');
    // sheetMaterialTypeIds aggregate in the list query
    expect(sql).toContain('sheet_material_type_ids');
  });
});

// Variant B: NULL-safe mapper and sheet-only flag-ON read
describe('PgOrderReadRepository Variant B (sheet-only reads)', () => {
  it('maps detail row with material_id NULL to materialId: null (not 0/NaN)', async () => {
    const database = createDatabaseWithNullMaterialId();
    const repository = new PgOrderReadRepository(database.service, true);

    const result = await repository.getOrderById({
      currentUser: currentUser('42'),
      orderId: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.details[0].materialId).toBeNull();
  });

  it('list aggregate populates sheetMaterialTypeIds and leaves materialIds empty when flag is ON', async () => {
    const database = createDatabaseWithSheetAggregate();
    const repository = new PgOrderReadRepository(database.service, true);

    const result = await repository.listOrders({
      currentUser: currentUser('42'),
      query: { page: 1, pageSize: 10 },
    });

    expect(result.data[0].sheetMaterialTypeIds).toEqual([5, 6]);
    expect(result.data[0].materialIds).toEqual([]);
  });
});

function createDatabaseWithNullMaterialId() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const service = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      if (text.includes('COUNT(*)::int')) return { rows: [{ total: 1 }] };
      if (text.includes('FROM audit_log')) return { rows: [] };
      if (text.includes('FROM orders o')) return { rows: [orderRow()] };
      if (text.includes('FROM order_details')) {
        return {
          rows: [
            {
              detail_id: 201,
              order_id: 100,
              detail_number: 1,
              detail_name: 'Panel',
              height: '800',
              width: '600',
              quantity: 1,
              area: '0.48',
              material_id: null,
              sheet_material_type_id: 5,
              material_name: 'МДФ 16',
              milling_type_id: 1,
              edge_type_id: 1,
              film_id: null,
              milling_cost_per_sqm: null,
              detail_cost: '100.00',
              priority: 100,
              production_status_id: null,
              joint_order_id: null,
              note: null,
              link_cutting_file: null,
              link_cutting_image_file: null,
              link_cad_file: null,
              link_pdf_file: null,
              ref_key_1c: null,
            },
          ],
        };
      }
      if (text.includes('FROM payments')) return { rows: [] };
      if (text.includes('FROM order_workshops')) return { rows: [] };
      if (text.includes('FROM order_resource_requirements')) return { rows: [] };
      if (text.includes('FROM order_doweling_links')) return { rows: [] };
      if (text.includes('FROM clients')) return { rows: [{ id: '1', name: 'Client A' }] };
      if (text.includes('FROM materials')) return { rows: [{ id: '10', name: 'MDF 16', unit_id: '2' }] };
      if (text.includes('FROM milling_types')) return { rows: [] };
      if (text.includes('FROM edge_types')) return { rows: [] };
      if (text.includes('FROM films')) return { rows: [] };
      if (text.includes('FROM order_statuses')) return { rows: [] };
      if (text.includes('FROM payment_statuses')) return { rows: [] };
      if (text.includes('FROM payment_types')) return { rows: [] };
      if (text.includes('FROM production_statuses')) return { rows: [] };
      if (text.includes('FROM workshops')) return { rows: [] };
      if (text.includes('FROM employees')) return { rows: [] };
      if (text.includes('FROM units')) return { rows: [] };
      if (text.includes('FROM sheet_material_types')) return { rows: [] };
      return { rows: [] };
    },
  } as unknown as DatabaseService;
  return { service, queries };
}

function createDatabaseWithSheetAggregate() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const service = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      if (text.includes('COUNT(*)::int')) return { rows: [{ total: 1 }] };
      if (text.includes('FROM orders o')) {
        return {
          rows: [
            {
              ...orderRow(),
              material_ids: [],
              material_names: ['МДФ 16', 'МДФ 19'],
              sheet_material_type_ids: [5, 6],
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as DatabaseService;
  return { service, queries };
}

function createDatabase() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const service = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('COUNT(*)::int')) {
        return { rows: [{ total: 11 }] };
      }

      if (text.includes('FROM audit_log')) {
        return {
          rows: [
            {
              audit_id: 'audit-1',
              entity_type: 'order',
              entity_id: '100',
              event: 'orders.status_change',
              user_id: '15',
              username: 'top-manager',
              role: 'top_manager',
              ip_address: null,
              user_agent: 'vitest',
              request_id: 'request-command-1',
              before_json: { statusId: 1 },
              after_json: { statusId: 2 },
              diff_json: { statusId: { before: 1, after: 2 } },
              created_at: new Date('2026-05-01T12:00:00.000Z'),
            },
          ],
        };
      }

      if (text.includes('FROM orders o')) {
        return { rows: [orderRow()] };
      }

      if (text.includes('FROM order_details')) {
        return {
          rows: [
            {
              detail_id: 200,
              order_id: 100,
              detail_number: 1,
              detail_name: 'Side',
              height: '1000',
              width: '500',
              quantity: 2,
              area: '1.00',
              material_id: 10,
              milling_type_id: 1,
              edge_type_id: 1,
              film_id: null,
              milling_cost_per_sqm: null,
              detail_cost: '120.00',
              priority: 100,
              production_status_id: null,
              joint_order_id: null,
              note: null,
              link_cutting_file: null,
              link_cutting_image_file: null,
              link_cad_file: null,
              link_pdf_file: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM payments')) {
        return {
          rows: [
            {
              payment_id: 300,
              order_id: 100,
              type_paid_id: 1,
              amount: '50.00',
              payment_date: '2026-05-01',
              notes: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM order_workshops')) {
        return {
          rows: [
            {
              order_workshop_id: 400,
              order_id: 100,
              workshop_id: 1,
              production_status_id: 2,
              received_date: null,
              started_date: null,
              completed_date: null,
              planned_completion_date: '2026-05-03',
              sequence_order: 1,
              responsible_employee_id: null,
              notes: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM order_resource_requirements')) {
        return {
          rows: [
            {
              requirement_id: 500,
              order_id: 100,
              resource_type: 'material',
              material_id: 10,
              film_id: null,
              edge_type_id: null,
              required_quantity: '2',
              unit_id: 1,
              waste_percentage: '10',
              final_quantity: '2.2',
              requirement_status_id: 1,
              supplier_id: null,
              purchase_price: null,
              requisition_id: null,
              warehouse_id: null,
              reserved_at: null,
              consumed_at: null,
              notes: null,
              calculation_details: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM order_doweling_links')) {
        return {
          rows: [
            {
              order_doweling_link_id: 600,
              order_id: 100,
              doweling_order_id: 700,
              doweling_order_name: '1368',
              design_engineer_id: 8,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM clients')) {
        return { rows: [{ id: '1', name: 'Client A' }] };
      }

      if (text.includes('FROM materials')) {
        return { rows: [{ id: '10', name: 'MDF 16', unit_id: '2' }] };
      }

      if (text.includes('FROM milling_types')) {
        return { rows: [{ id: '20', name: 'Modern', cost_per_sqm: '120.50' }] };
      }

      if (text.includes('FROM edge_types')) {
        return { rows: [{ id: '30', name: 'PVC 2mm' }] };
      }

      if (text.includes('FROM films')) {
        return { rows: [{ id: '40', name: 'White matte' }] };
      }

      if (text.includes('FROM order_statuses')) {
        return { rows: [{ id: '50', name: 'New', code: null, color: '#ffffff' }] };
      }

      if (text.includes('FROM payment_statuses')) {
        return { rows: [{ id: '60', name: 'Unpaid', code: null, color: '#ff0000' }] };
      }

      if (text.includes('FROM payment_types')) {
        return { rows: [{ id: '70', name: 'Cash' }] };
      }

      if (text.includes('FROM production_statuses')) {
        return { rows: [{ id: '80', name: 'Cut', code: 'cut', color: '#00ff00' }] };
      }

      if (text.includes('FROM workshops')) {
        return { rows: [{ id: '90', name: 'Main workshop' }] };
      }

      if (text.includes('FROM employees')) {
        return { rows: [{ id: '100', full_name: 'Test Employee' }] };
      }

      if (text.includes('FROM units')) {
        return { rows: [{ id: '110', code: 'pcs', name: 'Pieces', symbol: 'pcs' }] };
      }

      if (text.includes('FROM sheet_material_types')) {
        return {
          rows: [
            { id: '200', name: 'МДФ 16', width_mm: '2800.00', height_mm: '2070.00', is_active: true },
          ],
        };
      }

      return { rows: [] };
    },
  } as unknown as DatabaseService;

  return { service, queries };
}

function orderRow() {
  return {
    order_id: 100,
    order_name: 'A-100',
    client_id: 5,
    client_name: 'Client',
    order_date: '2026-05-01',
    priority: 100,
    order_status_id: 1,
    order_status_name: 'Новый',
    payment_status_id: 2,
    payment_status_name: 'Частично оплачен',
    production_status_id: null,
    production_status_name: null,
    production_status_from_details_enabled: false,
    planned_completion_date: '2026-05-10',
    completion_date: null,
    issue_date: null,
    payment_date: '2026-05-01',
    discount: '0',
    surcharge: '0',
    notes: 'List note',
    manager_id: 42,
    link_cutting_file: null,
    link_cutting_image_file: null,
    link_cad_file: null,
    link_pdf_file: null,
    total_amount: '120.00',
    final_amount: '120.00',
    paid_amount: '50.00',
    parts_count: 2,
    total_area: '1.00',
    created_at: new Date('2026-05-01T10:00:00.000Z'),
    updated_at: new Date('2026-05-01T11:00:00.000Z'),
    created_by: 15,
    edited_by: 16,
    version: 3,
    ref_key_1c: null,
    material_ids: [10, 11],
    material_names: ['MDF 16', 'MDF 18'],
    milling_type_id: 1,
    milling_type_name: 'Modern',
    latest_doweling_order_id: 700,
    latest_doweling_order_name: '1368',
    latest_design_engineer_id: 8,
    passed_production_status_codes: ['cut', 'paint'],
  };
}

function currentUser(id: string): CurrentUser {
  return {
    id,
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}
