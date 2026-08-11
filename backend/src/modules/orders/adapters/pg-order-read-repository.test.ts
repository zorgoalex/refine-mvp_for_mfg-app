import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { parseOrderSearchInput, PgOrderReadRepository } from './pg-order-read-repository';

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
          projectId: 77,
          projectCode: 'МП-1024',
          fullNumber: 'МП-1024-A-100',
          debtAmount: 70,
          notes: 'List note',
          materialIds: [10, 11],
          materialNames: ['MDF 16', 'MDF 18'],
          basisProjects: ['1491', '1492'],
          bazisCutNumbers: ['БР-8', 'БР-12'],
          cutNumbers: ['42-3', '51-1'],
          bathCutNumbers: ['В-70-2'],
          filmNames: ['Film A', 'Film B'],
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
    expect(listQuery).toContain('JOIN projects mp ON mp.project_id = o.project_id');
    expect(listQuery).toContain('mp.code AS project_code');
    expect(listQuery).toContain("(mp.code || '-' || o.order_name) AS full_number");
    expect(listQuery).toContain('LEFT JOIN LATERAL');
    expect(listQuery).toContain('FROM order_details od');
    expect(listQuery).toContain('AS basis_projects');
    expect(listQuery).toContain('NULLIF(BTRIM(od.basis_project), \'\') IS NOT NULL');
    expect(listQuery).toContain('AS bazis_cut_numbers');
    expect(listQuery).toContain('FROM bazis_cut_set_details detail');
    expect(listQuery).toContain('detail.source_order_id = o.order_id');
    expect(listQuery).toContain('AS cut_numbers');
    expect(listQuery).toContain('AS bath_cut_numbers');
    expect(listQuery).toContain("cj.status = 'ready'");
    expect(listQuery).toContain('cj.last_calc_basis IS NOT NULL');
    expect(listQuery).toContain("= 'vacuum_table' AS is_vacuum");
    expect(listQuery).toContain('archived.cut_job_id IS NULL');
    expect(listQuery).toContain('FROM order_doweling_links odl');
    expect(listQuery).toContain('FROM production_status_events pse');
    expect(listQuery).toContain('ORDER BY (o.final_amount - o.paid_amount) ASC');
    // search «client» биндит и contains-ветку, и code-prefix ветку (mp.code ILIKE 'client%')
    expect(database.queries.at(-1)?.params).toEqual(['%client%', 'client%', '2026-05-01', 42, 10, 10]);
  });

  it('keeps the default list SQL free of trash-only select and join fragments', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await repository.listOrders({
      currentUser: currentUser('42'),
      query: {
        page: 1,
        pageSize: 10,
        sortBy: 'updatedAt',
        sortOrder: 'desc',
        onlyMyOrders: false,
      },
    });

    const listQuery = database.queries.find((query) => query.text.includes('LIMIT'))?.text ?? '';

    expect(listQuery).toBe(mergeBaseDefaultListSql());
  });

  it('lists only deleted orders with deleted metadata fields and trash sort support', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await expect(
      repository.listOrders({
        currentUser: currentUser('42'),
        query: {
          page: 1,
          pageSize: 10,
          sortBy: 'deletedAt',
          sortOrder: 'desc',
          deleted: true,
        },
      }),
    ).resolves.toMatchObject({
      data: [
        {
          deletedAt: '2026-05-02T08:30:00.000Z',
          deletedBy: 91,
          deletedByName: 'Trash Manager',
        },
      ],
    });

    const listQuery = database.queries.find((query) => query.text.includes('LIMIT'))?.text ?? '';

    expect(listQuery).toContain('o.delete_flag = true');
    expect(listQuery).not.toContain('o.delete_flag = false');
    expect(listQuery).toContain('o.deleted_at');
    expect(listQuery).toContain('o.deleted_by');
    expect(listQuery).toContain('LEFT JOIN users deleted_by_user ON deleted_by_user.user_id = o.deleted_by');
    expect(listQuery).toContain('deleted_by_user.full_name AS deleted_by_name');
    expect(listQuery).toContain('ORDER BY o.deleted_at DESC');
  });

  it('adds own-scope deleted clause only for trash list queries', async () => {
    const trashDatabase = createDatabase();
    const trashRepository = new PgOrderReadRepository(trashDatabase.service);

    await trashRepository.listOrders({
      currentUser: currentUser('42'),
      query: {
        page: 1,
        pageSize: 10,
        sortBy: 'deletedAt',
        sortOrder: 'desc',
        onlyMyOrders: false,
        deleted: true,
        deletedScopeUserId: '42',
      },
    });

    const trashQuery = trashDatabase.queries.find((query) => query.text.includes('LIMIT'))?.text ?? '';

    expect(trashQuery).toContain('(o.created_by = $1 OR o.manager_id = $1)');
    expect(trashDatabase.queries.at(-1)?.params).toEqual([42, 10, 0]);

    const defaultDatabase = createDatabase();
    const defaultRepository = new PgOrderReadRepository(defaultDatabase.service);

    await defaultRepository.listOrders({
      currentUser: currentUser('42'),
      query: {
        page: 1,
        pageSize: 10,
        sortBy: 'updatedAt',
        sortOrder: 'desc',
        onlyMyOrders: false,
        deletedScopeUserId: '42',
      },
    });

    const defaultQuery = defaultDatabase.queries.find((query) => query.text.includes('LIMIT'))?.text ?? '';

    expect(defaultQuery).not.toContain('(o.created_by = $1 OR o.manager_id = $1)');
  });

  it('adds project search branches, projectId filter and projectCode sort for full numbers', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await repository.listOrders({
      currentUser: currentUser('42'),
      query: {
        page: 1,
        pageSize: 10,
        sortBy: 'projectCode',
        sortOrder: 'desc',
        search: 'МП-1024-77',
        projectId: 77,
      },
    });

    const countQuery = database.queries.find((query) => query.text.includes('COUNT(*)::int'));
    const listQuery = database.queries.find((query) => query.text.includes('LIMIT'));

    expect(countQuery?.text).toContain('JOIN projects mp ON mp.project_id = o.project_id');
    expect(listQuery?.text).toContain('mp.code ILIKE $2');
    // Composed full-number contains-match: covers dashes inside the order name
    // (or code) where the dash-split branch guesses the wrong boundary.
    expect(listQuery?.text).toContain("(mp.code || '-' || o.order_name) ILIKE $1");
    expect(listQuery?.text).toContain('(mp.code = $3 AND o.order_name ILIKE $4)');
    expect(listQuery?.text).toContain('o.project_id = $5');
    expect(listQuery?.text).toContain('ORDER BY mp.code DESC');
    expect(listQuery?.text).toContain("(mp.code || '-' || o.order_name) AS full_number");
    expect(listQuery?.params).toEqual(['%МП-1024-77%', 'МП-1024-77%', 'МП-1024', '77%', 77, 10, 0]);
  });

  it('keeps plain numeric search out of project-code branches', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await repository.listOrders({
      currentUser: currentUser('42'),
      query: {
        page: 1,
        pageSize: 10,
        search: '1258',
      },
    });

    const listQuery = database.queries.find((query) => query.text.includes('LIMIT'));

    expect(listQuery?.text).toContain('(o.order_name ILIKE $1 OR c.client_name::text ILIKE $1)');
    expect(listQuery?.text).not.toContain('mp.code ILIKE');
    expect(listQuery?.text).not.toContain('mp.code = $');
    expect(listQuery?.text).not.toContain("(mp.code || '-' || o.order_name) ILIKE");
    expect(listQuery?.params).toEqual(['%1258%', 10, 0]);
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
        orderStatusName: 'Новый',
        paymentStatusId: 2,
        paymentStatusName: 'Частично оплачен',
        productionStatusName: null,
        createdBy: 15,
        editedBy: 16,
      },
      details: [
        {
          id: 200,
          detailNumber: 1,
          detailCost: 120,
          bazisProjectId: 41,
          cutJob: { cutJobId: 41, resultNo: 2, cutNumber: '41-2', name: 'Раскрой заказа' },
          bathCutJob: { cutJobId: 42, resultNo: 3, cutNumber: 'В-42-3', name: 'Ванна заказа' },
          bazisCutSets: [
            { bazisCutSetId: 8, name: 'БР-8' },
            { bazisCutSetId: 12, name: 'Фасады' },
          ],
        },
      ],
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

  it('reads linked Basis-cut sets by direct/order and indirect/node provenance plus Basis projects', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await repository.getOrderById({
      currentUser: currentUser('42'),
      orderId: 100,
    });

    const detailQuery = database.queries.find((query) => query.text.includes('FROM order_details od'))?.text ?? '';
    expect(detailQuery).toContain('FROM bazis_cut_set_details d');
    expect(detailQuery).toContain('d.source_order_detail_id = od.detail_id');
    expect(detailQuery).toContain('d.source_bazis_node_id = detail_map.node_id');
    expect(detailQuery).toContain('FROM bazis_node_order_detail_map detail_map');
    expect(detailQuery).toContain('JOIN bazis_project_revisions revision');
    expect(detailQuery).toContain('JOIN bazis_projects project');
    expect(detailQuery).toContain('AS bazis_projects');
    expect(detailQuery).toContain('ORDER BY refs.bazis_cut_set_id');
  });

  it('resolves the source Basis-project id from the imported detail mapping', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await repository.getOrderById({
      currentUser: currentUser('42'),
      orderId: 100,
    });

    const detailQuery = database.queries.find((query) => query.text.includes('FROM order_details od'))?.text ?? '';
    expect(detailQuery).toContain('FROM bazis_node_order_detail_map map');
    expect(detailQuery).toContain('map.order_detail_id = od.detail_id');
    expect(detailQuery).toContain('revision.bazis_project_id');
  });

  it('falls back to a unique order-level Basis-project link for duplicate imported panels', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await repository.getOrderById({
      currentUser: currentUser('42'),
      orderId: 100,
    });

    const detailQuery = database.queries.find((query) => query.text.includes('FROM order_details od'))?.text ?? '';
    expect(detailQuery).toContain('linked_bazis_project_candidates AS MATERIALIZED');
    expect(detailQuery).toContain('FROM bazis_order_links link');
    expect(detailQuery).toContain('HAVING count(DISTINCT bazis_project_id) = 1');
    expect(detailQuery).toContain('FROM linked_bazis_projects linked');
    expect(detailQuery).toContain('linked.project_no = substring(');
  });

  it('keeps the default getOrderById SQL free of trash-only select and join fragments', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await repository.getOrderById({
      currentUser: currentUser('42'),
      orderId: 100,
    });

    const headerQuery = database.queries.find(
      (query) => query.text.includes('FROM orders o') && query.text.includes('WHERE o.order_id = $1'),
    )?.text ?? '';

    expect(headerQuery).toBe(mergeBaseDefaultGetByIdSql());
  });

  it('loads deleted order header when includeDeleted is true', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await expect(
      repository.getOrderById({
        currentUser: currentUser('42'),
        orderId: 100,
        includeDeleted: true,
      }),
    ).resolves.toMatchObject({
      header: {
        deleteFlag: true,
        deletedAt: '2026-05-02T08:30:00.000Z',
        deletedByName: 'Trash Manager',
      },
    });

    const headerQuery = database.queries.find(
      (query) => query.text.includes('FROM orders o') && query.text.includes('WHERE o.order_id = $1'),
    )?.text ?? '';

    expect(headerQuery).toContain('WHERE o.order_id = $1');
    expect(headerQuery).not.toContain('WHERE o.order_id = $1 AND o.delete_flag = false');
    expect(headerQuery).toContain('o.delete_flag');
    expect(headerQuery).toContain('o.deleted_at');
    expect(headerQuery).toContain('LEFT JOIN users deleted_by_user ON deleted_by_user.user_id = o.deleted_by');
    expect(headerQuery).toContain('deleted_by_user.full_name AS deleted_by_name');
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
      clients: [{ id: 1, name: 'Client A', sortOrder: 10 }],
      materials: [{ id: 10, name: 'MDF 16', unitId: 2, sortOrder: 10 }],
      millingTypes: [{ id: 20, name: 'Modern', costPerSqm: 120.5, sortOrder: 10 }],
      edgeTypes: [{ id: 30, name: 'PVC 2mm', sortOrder: 10 }],
      films: [{ id: 40, name: 'White matte', sortOrder: 10 }],
      orderStatuses: [{ id: 50, name: 'New', code: null, color: '#ffffff', sortOrder: 10 }],
      paymentStatuses: [{ id: 60, name: 'Unpaid', code: null, color: '#ff0000', sortOrder: 10 }],
      paymentTypes: [{ id: 70, name: 'Cash', sortOrder: 10 }],
      productionStatuses: [{ id: 80, name: 'Cut', code: 'cut', color: '#00ff00', sortOrder: 10 }],
      workshops: [{ id: 90, name: 'Main workshop', sortOrder: 10 }],
      employees: [{ id: 100, fullName: 'Test Employee' }],
      units: [{ id: 110, code: 'pcs', name: 'Pieces', symbol: 'pcs', sortOrder: 10 }],
      // SP3: repo always returns sheet types (dumb); the service masks by perm.
      sheetMaterialTypes: [
        { id: 200, name: 'МДФ 16', widthMm: 2800, heightMm: 2070, isActive: true, isCuttable: true, sortOrder: 10 },
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
    // legacy path: header materials join must be present in the list query
    expect(sql).toContain('LEFT JOIN materials hm ON hm.material_id = o.material_id');
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
    // flag-ON: header materials join must NOT scan the materials table (dead weight post-034)
    expect(sql).not.toContain('LEFT JOIN materials hm ON hm.material_id = o.material_id');
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
    expect(result.data[0].filmNames).toEqual(['Пленка A', 'Пленка B']);
  });
});

describe('parseOrderSearchInput', () => {
  it('keeps plain numeric search out of project-code mode', () => {
    expect(parseOrderSearchInput('1258')).toEqual({
      plain: '1258',
      codePrefix: null,
      codeExact: null,
      namePrefix: null,
    });
  });

  it('treats code-only input as project-code prefix', () => {
    expect(parseOrderSearchInput('ФК26')).toEqual({
      plain: 'ФК26',
      codePrefix: 'ФК26',
      codeExact: null,
      namePrefix: null,
    });
  });

  it('splits full number by the last dash', () => {
    expect(parseOrderSearchInput('ФК26-1258')).toEqual({
      plain: 'ФК26-1258',
      codePrefix: 'ФК26-1258',
      codeExact: 'ФК26',
      namePrefix: '1258',
    });
  });

  it('preserves dashes inside project code before the last segment', () => {
    expect(parseOrderSearchInput('МП-1024-77')).toEqual({
      plain: 'МП-1024-77',
      codePrefix: 'МП-1024-77',
      codeExact: 'МП-1024',
      namePrefix: '77',
    });
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
              film_names: ['Пленка A', 'Пленка B'],
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
              basis_project: '1491',
              bazis_project_id: 41,
              link_cutting_file: null,
              link_cutting_image_file: null,
              link_cad_file: null,
              link_pdf_file: null,
              ref_key_1c: null,
              cut_job_id: 41,
              cut_result_no: 2,
              cut_job_name: 'Раскрой заказа',
              cut_job_param_profile_id: null,
              cut_job_profile_name: null,
              cut_job_profile_is_active: null,
              bath_cut_job_id: 42,
              bath_cut_result_no: 3,
              bath_cut_job_name: 'Ванна заказа',
              bath_cut_job_param_profile_id: 7,
              bath_cut_job_profile_name: 'Вакуум',
              bath_cut_job_profile_is_active: true,
              bazis_cut_sets: [
                { bazisCutSetId: 12, name: 'Фасады' },
                { bazisCutSetId: 8, name: 'БР-8' },
              ],
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
        return { rows: [{ id: '1', name: 'Client A', sort_order: 10 }] };
      }

      if (text.includes('FROM materials')) {
        return { rows: [{ id: '10', name: 'MDF 16', unit_id: '2', sort_order: 10 }] };
      }

      if (text.includes('FROM milling_types')) {
        return { rows: [{ id: '20', name: 'Modern', cost_per_sqm: '120.50', sort_order: 10 }] };
      }

      if (text.includes('FROM edge_types')) {
        return { rows: [{ id: '30', name: 'PVC 2mm', sort_order: 10 }] };
      }

      if (text.includes('FROM films')) {
        return { rows: [{ id: '40', name: 'White matte', sort_order: 10 }] };
      }

      if (text.includes('FROM order_statuses')) {
        return { rows: [{ id: '50', name: 'New', code: null, color: '#ffffff', sort_order: 10 }] };
      }

      if (text.includes('FROM payment_statuses')) {
        return { rows: [{ id: '60', name: 'Unpaid', code: null, color: '#ff0000', sort_order: 10 }] };
      }

      if (text.includes('FROM payment_types')) {
        return { rows: [{ id: '70', name: 'Cash', sort_order: 10 }] };
      }

      if (text.includes('FROM production_statuses')) {
        return { rows: [{ id: '80', name: 'Cut', code: 'cut', color: '#00ff00', sort_order: 10 }] };
      }

      if (text.includes('FROM workshops')) {
        return { rows: [{ id: '90', name: 'Main workshop', sort_order: 10 }] };
      }

      if (text.includes('FROM employees')) {
        return { rows: [{ id: '100', full_name: 'Test Employee' }] };
      }

      if (text.includes('FROM units')) {
        return { rows: [{ id: '110', code: 'pcs', name: 'Pieces', symbol: 'pcs', sort_order: 10 }] };
      }

      if (text.includes('FROM sheet_material_types')) {
        return {
          rows: [
            { id: '200', name: 'МДФ 16', width_mm: '2800.00', height_mm: '2070.00', is_active: true, is_cuttable: true, sort_order: 10 },
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
    project_id: 77,
    project_code: 'МП-1024',
    full_number: 'МП-1024-A-100',
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
    delete_flag: true,
    deleted_at: new Date('2026-05-02T08:30:00.000Z'),
    deleted_by: 91,
    deleted_by_name: 'Trash Manager',
    material_ids: [10, 11],
    material_names: ['MDF 16', 'MDF 18'],
    basis_projects: ['1491', '1492'],
    bazis_cut_numbers: ['БР-8', 'БР-12'],
    cut_numbers: ['42-3', '51-1'],
    bath_cut_numbers: ['В-70-2'],
    film_names: ['Film A', 'Film B'],
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

function mergeBaseDefaultListSql(): string {
  return [
    '',
    '      WITH page_orders AS (',
    '        SELECT',
    '          o.order_id, o.order_name, o.project_id, mp.code AS project_code,',
    "          (mp.code || '-' || o.order_name) AS full_number,",
    '          o.client_id, c.client_name,',
    '          o.order_date, o.priority,',
    '          o.order_status_id, os.order_status_name,',
    '          o.payment_status_id, pay_s.payment_status_name,',
    '          o.production_status_id, prod_s.production_status_name,',
    '          o.production_status_from_details_enabled,',
    '          o.planned_completion_date, o.completion_date, o.issue_date, o.payment_date,',
    '          o.discount, o.surcharge, o.notes, o.manager_id,',
    '          o.link_cutting_file, o.link_cutting_image_file, o.link_cad_file, o.link_pdf_file,',
    '          o.total_amount, o.final_amount, o.paid_amount, o.parts_count, o.total_area,',
    '          o.created_at, o.updated_at, o.created_by, o.edited_by, o.version, o.ref_key_1c,',
    '          o.sheet_material_type_id AS header_sheet_material_type_id,',
    '          hsmt.name AS header_material_name',
    '        FROM orders o',
    '        JOIN projects mp ON mp.project_id = o.project_id',
    '        LEFT JOIN clients c ON c.client_id = o.client_id',
    '        LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id',
    '        LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id',
    '        LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id',
    '        ',
    '        LEFT JOIN sheet_material_types hsmt ON hsmt.sheet_material_type_id = o.sheet_material_type_id',
    '        WHERE o.delete_flag = false',
    '        ORDER BY o.updated_at DESC, o.order_id DESC',
    '        LIMIT $1 OFFSET $2',
    '      )',
    '      SELECT',
    '        o.*,',
    '        material_projection.material_ids,',
    '        material_projection.material_names,',
    '        basis_projection.basis_projects,',
    '        bazis_cut_projection.bazis_cut_numbers,',
    '        cut_projection.cut_numbers,',
    '        cut_projection.bath_cut_numbers,',
    '        film_projection.film_names,',
    '        material_projection.sheet_material_type_ids,',
    '        milling_projection.milling_type_id,',
    '        milling_projection.milling_type_name,',
    '        latest_doweling.doweling_order_id AS latest_doweling_order_id,',
    '        latest_doweling.doweling_order_name AS latest_doweling_order_name,',
    '        latest_doweling.design_engineer_id AS latest_design_engineer_id,',
    '        production_projection.passed_production_status_codes,',
    '        group_projection.group_links_json',
    '      FROM page_orders o',
    '      LEFT JOIN LATERAL (',
    '        SELECT',
    '          ARRAY_AGG(materials.material_id ORDER BY materials.first_detail_number, materials.first_detail_id) AS material_ids,',
    '          ARRAY_AGG(materials.material_name ORDER BY materials.first_detail_number, materials.first_detail_id) AS material_names,',
    '          ARRAY_AGG(materials.sheet_material_type_id ORDER BY materials.first_detail_number, materials.first_detail_id) AS sheet_material_type_ids',
    '        FROM (',
    '          SELECT',
    '            NULL::bigint AS material_id,',
    '            od.sheet_material_type_id,',
    '            smt.name AS material_name,',
    '            MIN(od.detail_number) AS first_detail_number,',
    '            MIN(od.detail_id) AS first_detail_id',
    '          FROM order_details od',
    '          ',
    '          LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id',
    '          WHERE od.order_id = o.order_id AND od.delete_flag = false AND od.sheet_material_type_id IS NOT NULL',
    '          GROUP BY od.sheet_material_type_id, smt.name',
    '        ) materials',
    '      ) material_projection ON true',
    '      LEFT JOIN LATERAL (',
    '        SELECT ARRAY_AGG(projects.basis_project ORDER BY projects.first_detail_number, projects.first_detail_id) AS basis_projects',
    '        FROM (',
    '          SELECT DISTINCT ON (LOWER(BTRIM(od.basis_project)))',
    '            BTRIM(od.basis_project) AS basis_project,',
    '            od.detail_number AS first_detail_number,',
    '            od.detail_id AS first_detail_id',
    '          FROM order_details od',
    '          WHERE od.order_id = o.order_id',
    '            AND od.delete_flag = false',
    "            AND NULLIF(BTRIM(od.basis_project), '') IS NOT NULL",
    '          ORDER BY LOWER(BTRIM(od.basis_project)), od.detail_number, od.detail_id',
    '        ) projects',
    '      ) basis_projection ON true',
    '      LEFT JOIN LATERAL (',
    "        SELECT ARRAY_AGG('БР-' || sets.bazis_cut_set_id::text ORDER BY sets.bazis_cut_set_id) AS bazis_cut_numbers",
    '        FROM (',
    '          SELECT DISTINCT detail.bazis_cut_set_id',
    '          FROM bazis_cut_set_details detail',
    '          WHERE detail.source_order_id = o.order_id',
    '        ) sets',
    '      ) bazis_cut_projection ON true',
    '      LEFT JOIN LATERAL (',
    '        SELECT',
    '          ARRAY_AGG(cuts.cut_number ORDER BY cuts.cut_job_id)',
    '            FILTER (WHERE cuts.is_vacuum = false) AS cut_numbers,',
    '          ARRAY_AGG(cuts.cut_number ORDER BY cuts.cut_job_id)',
    '            FILTER (WHERE cuts.is_vacuum = true) AS bath_cut_numbers',
    '        FROM (',
    '          SELECT DISTINCT',
    '            cj.cut_job_id,',
    '            cr.result_no,',
    '            CASE',
    '              WHEN COALESCE(',
    "                cj.last_calc_params->>'layout_mode',",
    "                cpp.params->>'layout_mode',",
    "                cj.params->>'layout_mode'",
    "              ) = 'vacuum_table'",
    "                THEN 'В-' || COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text) || '-' || cr.result_no::text",
    "              ELSE COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text) || '-' || cr.result_no::text",
    '            END AS cut_number,',
    '            COALESCE(',
    "              cj.last_calc_params->>'layout_mode',",
    "              cpp.params->>'layout_mode',",
    "              cj.params->>'layout_mode'",
    "            ) = 'vacuum_table' AS is_vacuum",
    '          FROM cut_job_item cji',
    '          JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id',
    '          JOIN cut_result cr',
    '            ON cr.cut_result_id = cj.current_cut_result_id',
    '           AND cr.cut_job_id = cj.cut_job_id',
    '          LEFT JOIN cut_result_archive_state archived',
    '            ON archived.cut_job_id = cr.cut_job_id',
    '           AND archived.result_no = cr.result_no',
    '          LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id',
    '          WHERE cji.order_id = o.order_id',
    '            AND cji.is_active = true',
    "            AND cj.status = 'ready'",
    '            AND cj.last_calc_basis IS NOT NULL',
    '            AND archived.cut_job_id IS NULL',
    '        ) cuts',
    '      ) cut_projection ON true',
    '      LEFT JOIN LATERAL (',
    '        SELECT ARRAY_AGG(films.film_name ORDER BY films.first_detail_number, films.first_detail_id) AS film_names',
    '        FROM (',
    '          SELECT',
    '            f.film_name,',
    '            MIN(od.detail_number) AS first_detail_number,',
    '            MIN(od.detail_id) AS first_detail_id',
    '          FROM order_details od',
    '          INNER JOIN films f ON f.film_id = od.film_id',
    '          WHERE od.order_id = o.order_id AND od.delete_flag = false',
    '          GROUP BY f.film_name',
    '        ) films',
    '      ) film_projection ON true',
    '      LEFT JOIN LATERAL (',
    '        SELECT',
    '          CASE WHEN COUNT(DISTINCT od.milling_type_id) = 1 THEN MIN(od.milling_type_id) END AS milling_type_id,',
    '          CASE WHEN COUNT(DISTINCT od.milling_type_id) = 1 THEN MAX(mt.milling_type_name) END AS milling_type_name',
    '        FROM order_details od',
    '        LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id',
    '        WHERE od.order_id = o.order_id AND od.delete_flag = false',
    '      ) milling_projection ON true',
    '      LEFT JOIN LATERAL (',
    '        SELECT',
    '          odl.doweling_order_id,',
    '          d.doweling_order_name,',
    '          d.design_engineer_id',
    '        FROM order_doweling_links odl',
    '        LEFT JOIN doweling_orders d ON d.doweling_order_id = odl.doweling_order_id',
    '        WHERE odl.order_id = o.order_id AND odl.delete_flag = false',
    '        ORDER BY odl.order_doweling_link_id DESC',
    '        LIMIT 1',
    '      ) latest_doweling ON true',
    '      LEFT JOIN LATERAL (',
    '        SELECT ARRAY_AGG(events.production_status_code ORDER BY events.sort_order, events.production_status_code) AS passed_production_status_codes',
    '        FROM (',
    '          SELECT',
    '            ps.production_status_code,',
    '            MIN(COALESCE(ps.sort_order, 0)) AS sort_order',
    '          FROM production_status_events pse',
    '          INNER JOIN production_statuses ps ON ps.production_status_id = pse.production_status_id',
    '          WHERE pse.order_id = o.order_id',
    '          GROUP BY ps.production_status_code',
    '        ) events',
    '      ) production_projection ON true',
    '      LEFT JOIN LATERAL (',
    '        SELECT COALESCE(',
    '          jsonb_agg(',
    '            jsonb_build_object(',
    "              'id', p.id::text,",
    "              'code', p.code,",
    "              'name', p.name,",
    "              'relationType', pop.relation_type,",
    "              'isPrimary', pop.is_primary,",
    "              'validFrom', pop.valid_from",
    '            )',
    '            ORDER BY pop.is_primary DESC, pop.relation_type ASC, p.name ASC, p.code ASC',
    '          ),',
    "          '[]'::jsonb",
    '        ) AS group_links_json',
    '        FROM public.group_order_groups pop',
    '        INNER JOIN public.group_groups p ON p.id = pop.group_id',
    '        WHERE pop.order_id = o.order_id',
    '          AND pop.valid_to IS NULL',
    '      ) group_projection ON true',
    '      ORDER BY o.updated_at DESC, o.order_id DESC',
    '      ',
  ].join('\n');
}

function mergeBaseDefaultGetByIdSql(): string {
  return [
    '',
    '      SELECT',
    '        o.order_id, o.order_name, o.client_id, c.client_name,',
    '        o.order_date, o.priority,',
    '        o.order_status_id, os.order_status_name,',
    '        o.payment_status_id, pay_s.payment_status_name,',
    '        o.production_status_id, prod_s.production_status_name,',
    '        o.production_status_from_details_enabled,',
    '        o.planned_completion_date, o.completion_date, o.issue_date, o.payment_date,',
    '        o.discount, o.surcharge, o.notes, o.manager_id,',
    '        o.link_cutting_file, o.link_cutting_image_file, o.link_cad_file, o.link_pdf_file,',
    '        o.total_amount, o.final_amount, o.paid_amount, o.parts_count, o.total_area,',
    '        o.created_at, o.updated_at, o.created_by, o.edited_by, o.version, o.ref_key_1c,',
    '        o.sheet_material_type_id, o.sheet_eligible,',
    '        smt.name AS material_name,',
    '        NULL::bigint AS material_id,',
    '        o.milling_type_id, o.edge_type_id, o.film_id',
    '      FROM orders o',
    '      LEFT JOIN clients c ON c.client_id = o.client_id',
    '      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id',
    '      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id',
    '      LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id',
    '      ',
    '      LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = o.sheet_material_type_id',
    '      WHERE o.order_id = $1 AND o.delete_flag = false',
    '      ',
  ].join('\n');
}
