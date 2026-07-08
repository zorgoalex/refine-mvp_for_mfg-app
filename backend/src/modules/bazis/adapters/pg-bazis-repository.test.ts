import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { OrderDto } from '../../orders/dto/order.dto';
import type { OrderTransactionService } from '../../orders/application/order-transaction.service';
import type { ParsedBazisRevision } from '../application/bazis-xml-parser';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import {
  BazisNoPanelsSelectedError,
  BazisProjectNotFoundError,
  BazisRevisionDuplicateError,
} from '../errors/bazis.errors';
import { PgBazisRepository } from './pg-bazis-repository';

describe('PgBazisRepository.importRevision', () => {
  it('sets session user first, then inserts project/revision/nodes/audit/outbox/run', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    const response = await repository.importRevision(importCommand());

    expect(response.bazisProject).toEqual({ bazisProjectId: 41, projectId: 77, name: 'Шкаф Nova' });
    expect(response.revision).toMatchObject({ bazisRevisionId: 82, revisionNo: 3, xmlSha256: 'sha-001' });

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered[0]).toBe('SELECT set_session_user($1)');
    expect(ordered).toContain('INSERT INTO bazis_projects (project_id, name, created_by) VALUES ($1, $2, $3) RETURNING bazis_project_id');
    expect(ordered).toContain('SELECT revision_no FROM bazis_project_revisions WHERE bazis_project_id = $1 AND xml_sha256 = $2');
    expect(ordered).toContain('INSERT INTO bazis_project_revisions (bazis_project_id, revision_no, file_name, file_size, xml_sha256, raw_xml, bazis_version, product_name, product_price, summary_json, imported_by, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING bazis_revision_id');
    expect(ordered.filter((sql) => sql.startsWith('INSERT INTO bazis_nodes'))).toHaveLength(2);
    expect(ordered).toContain('UPDATE bazis_projects SET current_revision_id = $1 WHERE bazis_project_id = $2');
    expect(ordered).toContain('INSERT INTO audit_log ( event, entity_type, entity_id, user_id, username, role_code, role, request_id, source, related_order_id, related_client_id, related_payment_id, related_production_event_id, related_deadline_id, related_user_id, status_field, status_id, status_name, status_code, stage_code, before_json, after_json, diff_json, metadata_json ) VALUES ( $1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb, $22::jsonb, $23::jsonb ) RETURNING audit_id');
    const relatedPairs = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log_related_entity'))
      .map((query) => [query.params?.[1], query.params?.[2]]);
    // project_created: project + bazis_project; revision_imported: project + bazis_project + bazis_revision
    expect(relatedPairs).toEqual([
      ['project', 77],
      ['bazis_project', 41],
      ['project', 77],
      ['bazis_project', 41],
      ['bazis_revision', 82],
    ]);
    expect(ordered).toContain('INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (idempotency_key) DO NOTHING');
    expect(ordered).toContain("INSERT INTO bazis_import_runs (file_name, xml_sha256, status, revision_id, imported_by, request_id) VALUES ($1,$2,'parsed',$3,$4,$5)");
  });

  it('throws BazisRevisionDuplicateError when sha256 exists in same bazis project', async () => {
    const repository = new PgBazisRepository(createDatabase({ duplicateRevisionNo: 7 }).service);

    await expect(repository.importRevision(importCommand())).rejects.toBeInstanceOf(BazisRevisionDuplicateError);
  });

  it('returns warning when sha256 exists in another bazis project', async () => {
    const repository = new PgBazisRepository(createDatabase({ duplicateOtherProjectName: 'Другой проект' }).service);

    const response = await repository.importRevision(importCommand());

    expect(response.warnings).toEqual(['Такой же файл уже импортирован в Базис-проект «Другой проект»']);
  });

  it('maps parsed node parentIndex to inserted ids (parent id resolved)', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.importRevision(importCommand());

    const nodeInserts = database.queries.filter((query) => normalizeSql(query.text).startsWith('INSERT INTO bazis_nodes'));
    expect(nodeInserts[0]?.params[1]).toBeNull();
    expect(nodeInserts[1]?.params[1]).toBe(501);
  });

  it('reports unmapped materials by source_kind + lower(name)', async () => {
    const parsed = parsedRevision({
      materials: [
        { name: 'Laminate White', kindGuess: 'sheet', usageCount: 2 },
        { name: 'LAMINATE WHITE', kindGuess: 'film', usageCount: 1 },
        { name: 'ABS 2mm', kindGuess: 'edge', usageCount: 4 },
        { name: 'Bolt', kindGuess: 'hardware', usageCount: 8 },
      ],
    });
    const repository = new PgBazisRepository(
      createDatabase({
        materialMappings: [
          { source_kind: 'sheet', name: 'laminate white' },
          { source_kind: 'edge', name: 'abs 2mm' },
        ],
      }).service,
    );

    const response = await repository.importRevision(importCommand({ parsed }));

    expect(response.unmappedMaterials).toEqual([{ name: 'LAMINATE WHITE', kindGuess: 'film', usageCount: 1 }]);
  });
});

describe('PgBazisRepository.recordFailedImport', () => {
  it('writes failed run row outside main flow', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.recordFailedImport({
      currentUser: currentUser(),
      requestId: 'req-failed',
      fileName: 'failed.xml',
      xmlSha256: null,
      errorMessage: 'boom',
    });

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered.slice(-2)).toEqual([
      'SELECT set_session_user($1)',
      "INSERT INTO bazis_import_runs (file_name, xml_sha256, status, error_json, imported_by, request_id) VALUES ($1,$2,'failed',$3::jsonb,$4,$5)",
    ]);
  });
});

describe('PgBazisRepository reads + mappings', () => {
  it('getTreeChildren returns root nodes with childrenCount', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        treeChildren: [
          {
            bazis_node_id: 11,
            parent_node_id: null,
            seq: 1,
            node_kind: 'product',
            object_type: null,
            name: 'Root',
            detail_code: null,
            position: null,
            quantity: 1,
            cumulative_quantity: 1,
            length_mm: null,
            width_mm: null,
            thickness_mm: null,
            main_material_name: null,
            children_count: 2,
          },
        ],
      }).service,
    );

    await expect(repository.getTreeChildren(82, null)).resolves.toEqual([
      {
        bazisNodeId: 11,
        parentNodeId: null,
        seq: 1,
        nodeKind: 'product',
        objectType: null,
        name: 'Root',
        detailCode: null,
        position: null,
        quantity: 1,
        cumulativeQuantity: 1,
        lengthMm: null,
        widthMm: null,
        thicknessMm: null,
        mainMaterialName: null,
        childrenCount: 2,
      },
    ]);
  });

  it('getProject throws BazisProjectNotFoundError', async () => {
    const repository = new PgBazisRepository(createDatabase().service);

    await expect(repository.getProject(999)).rejects.toBeInstanceOf(BazisProjectNotFoundError);
  });

  it('upsertMaterialMappings writes source_kind conflict key and one batch audit', async () => {
    const database = createDatabase({
      upsertedMappings: [
        {
          bazis_material_mapping_id: 1,
          source_kind: 'sheet',
          bazis_name: 'Laminate White',
          target_kind: 'sheet',
          sheet_material_type_id: 10,
          film_id: null,
          edge_type_id: null,
        },
        {
          bazis_material_mapping_id: 2,
          source_kind: 'film',
          bazis_name: 'Laminate White',
          target_kind: 'ignore',
          sheet_material_type_id: null,
          film_id: null,
          edge_type_id: null,
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const response = await repository.upsertMaterialMappings(currentUser(), 'req-map', [
      { sourceKind: 'sheet', bazisName: 'Laminate White', targetKind: 'sheet', sheetMaterialTypeId: 10 },
      { sourceKind: 'film', bazisName: 'Laminate White', targetKind: 'ignore' },
    ]);

    expect(response).toEqual([
      {
        bazisMaterialMappingId: 1,
        sourceKind: 'sheet',
        bazisName: 'Laminate White',
        targetKind: 'sheet',
        sheetMaterialTypeId: 10,
        filmId: null,
        edgeTypeId: null,
      },
      {
        bazisMaterialMappingId: 2,
        sourceKind: 'film',
        bazisName: 'Laminate White',
        targetKind: 'ignore',
        sheetMaterialTypeId: null,
        filmId: null,
        edgeTypeId: null,
      },
    ]);

    const inserts = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_material_mappings'),
    );
    expect(inserts).toHaveLength(2);
    expect(normalizeSql(inserts[0]!.text)).toContain('ON CONFLICT (source_kind, lower(bazis_name)) DO UPDATE SET');

    const audit = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log'));
    expect(audit).toBeDefined();
    expect(audit?.params[0]).toBe('bazis.material_mapping_set');
    expect(audit?.params[1]).toBe('bazis_material_mapping');
    expect(audit?.params[2]).toBe('batch');
    expect(String(audit?.params[22])).toContain('"count":2');
    expect(String(audit?.params[22])).toContain('"names":["Laminate White","Laminate White"]');
  });
});

describe('PgBazisRepository.createOrderFromRevision', () => {
  it('expands selected nodes into distinct panels and builds order details with the frozen basis_data string', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        panelRows: [
          {
            bazis_node_id: 101,
            object_type: 'Панель',
            name: 'Фасад/левая створка',
            position: '7',
            designation: 'D-01',
            cumulative_quantity: 2,
            length_mm: 1200,
            width_mm: 450,
            main_material_name: 'Laminate White',
            raw_json: {
              ОблицовкаПласти1: { Пласть: [{ Наименование: 'Snow Film' }] },
              ОблицовкаПласти2: { Пласть: [{ Наименование: 'Snow Film' }] },
            },
          },
          {
            bazis_node_id: 102,
            object_type: 'Панель',
            name: 'Полка',
            position: '8',
            designation: 'S-02',
            cumulative_quantity: 1,
            length_mm: 800,
            width_mm: 300,
            main_material_name: 'Unknown Sheet',
            raw_json: {},
          },
        ],
        mappingRows: [
          {
            source_kind: 'sheet',
            name: 'laminate white',
            target_kind: 'sheet',
            sheet_material_type_id: 501,
            film_id: null,
            edge_type_id: null,
          },
          {
            source_kind: 'film',
            name: 'snow film',
            target_kind: 'film',
            sheet_material_type_id: null,
            film_id: 601,
            edge_type_id: null,
          },
          {
            source_kind: 'sheet',
            name: 'unknown sheet',
            target_kind: 'sheet',
            sheet_material_type_id: 502,
            film_id: null,
            edge_type_id: null,
          },
        ],
      },
    });
    const orderTransactions: Pick<OrderTransactionService, 'create'> = {
      create: async (command: Parameters<OrderTransactionService['create']>[0]) => {
        expect(command.dto).toMatchObject({
          header: {
            projectId: 77,
            clientId: 5,
            orderName: 'ERP order',
            orderStatusId: 3,
          },
        });
        const details = (command.dto.details ?? []) as Array<Record<string, unknown>>;
        expect(details).toHaveLength(2);
        expect(details[0]).toMatchObject({
          clientKey: 'bazis-node-101',
          detailName: 'Фасад/левая створка',
          height: 1200,
          width: 450,
          quantity: 2,
          basisProject: 'Шкаф Nova',
          basisDesignation: 'D-01',
          basisData: '7/D-01/Фасад/левая створка',
          sheetMaterialTypeId: 501,
          filmId: 601,
          millingTypeId: 1,
          edgeTypeId: 1,
        });
        expect(details[1]).toMatchObject({
          clientKey: 'bazis-node-102',
          basisData: '8/S-02/Полка',
          sheetMaterialTypeId: 502,
          filmId: null,
          millingTypeId: 1,
          edgeTypeId: 1,
        });
        expect(command.dto.idempotencyKey).toBeUndefined();

        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          {
            orderId: 9001,
            detailIdsByClientKey: new Map([
              ['bazis-node-101', 7001],
              ['bazis-node-102', 7002],
            ]),
          },
        );

        return buildOrderDto(9001, 'ERP order');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    const result = await repository.createOrderFromRevision(createOrderCommand());

    expect(result).toEqual({
      orderId: 9001,
      orderName: 'ERP order',
      detailsCreated: 2,
      mappedNodes: 2,
      requestId: 'req-create-order',
      auditId: 'audit-1',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('WITH RECURSIVE sel AS');
    expect(sql).toContain('INSERT INTO bazis_node_order_detail_map');
    expect(sql).toContain('ON CONFLICT (node_id, order_id) DO NOTHING');
    expect(sql).toContain('INSERT INTO bazis_order_links');
    expect(sql).toContain('ON CONFLICT (bazis_project_id, order_id) DO NOTHING');
  });

  it('replays a completed bazis idempotency response without creating another order', async () => {
    const response = {
      orderId: 77,
      orderName: 'Existing order',
      detailsCreated: 3,
      mappedNodes: 3,
      requestId: 'req-replay',
      auditId: 'audit-existing',
    };
    const database = createDatabase({
      createOrderState: {
        idempotencyConflict: true,
        existingIdempotencyRow: {
          request_hash: hashCreateOrderRequestShape(createOrderCommand()),
          response_json: response,
          status: 'completed',
          created_at: isoMinutesAgo(30),
        },
      },
    });
    const orderTransactions: Pick<OrderTransactionService, 'create'> = {
      create: async () => buildOrderDto(1, 'should-not-run'),
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await expect(repository.createOrderFromRevision(createOrderCommand())).resolves.toEqual(response);
    expect(normalizedSql(database.queries)).not.toContain('WITH RECURSIVE sel AS');
  });

  it('rejects reused idempotency keys with a different payload hash', async () => {
    const database = createDatabase({
      createOrderState: {
        idempotencyConflict: true,
        existingIdempotencyRow: {
          request_hash: 'different-hash',
          response_json: null,
          status: 'processing',
          created_at: isoMinutesAgo(1),
        },
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: 'BAZIS_IDEMPOTENCY_REUSED',
    });
  });

  it('rejects in-progress idempotency keys newer than ten minutes', async () => {
    const database = createDatabase({
      createOrderState: {
        idempotencyConflict: true,
        existingIdempotencyRow: {
          request_hash: hashCreateOrderRequestShape(createOrderCommand()),
          response_json: null,
          status: 'processing',
          created_at: isoMinutesAgo(1),
        },
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: 'BAZIS_IDEMPOTENCY_IN_PROGRESS',
    });
  });

  it('marks stale processing idempotency as failed and asks for a new key', async () => {
    const database = createDatabase({
      createOrderState: {
        idempotencyConflict: true,
        existingIdempotencyRow: {
          request_hash: hashCreateOrderRequestShape(createOrderCommand()),
          response_json: null,
          status: 'processing',
          created_at: isoMinutesAgo(20),
        },
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: 'BAZIS_IDEMPOTENCY_FAILED',
      message: expect.stringContaining('повторите с новым ключом'),
    });
    expect(normalizedSql(database.queries)).toContain("UPDATE command_idempotency_keys SET status = 'failed'");
  });

  it('marks the key failed and throws when selection expands to zero panels', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        panelRows: [],
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toBeInstanceOf(
      BazisNoPanelsSelectedError,
    );
    expect(normalizedSql(database.queries)).toContain("UPDATE command_idempotency_keys SET status = 'failed'");
  });

  it('uses hook correlation ids for map rows and marks idempotency failed when order creation fails', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        panelRows: [
          {
            bazis_node_id: 101,
            object_type: 'Панель',
            name: 'Фасад',
            position: '7',
            designation: 'D-01',
            cumulative_quantity: 2,
            length_mm: 1200,
            width_mm: 450,
            main_material_name: 'Laminate White',
            raw_json: {},
          },
        ],
        mappingRows: [
          {
            source_kind: 'sheet',
            name: 'laminate white',
            target_kind: 'sheet',
            sheet_material_type_id: 501,
            film_id: null,
            edge_type_id: null,
          },
        ],
      },
    });
    const orderTransactions: Pick<OrderTransactionService, 'create'> = {
      create: async (command: Parameters<OrderTransactionService['create']>[0]) => {
        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          { orderId: 9001, detailIdsByClientKey: new Map([['bazis-node-101', 7001]]) },
        );
        throw new Error('fk mismatch');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toThrow('fk mismatch');

    const nodeMapInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_node_order_detail_map'),
    );
    expect(nodeMapInsert?.params).toEqual([101, 7001, 9001, 'created']);
    expect(normalizedSql(database.queries)).toContain("UPDATE command_idempotency_keys SET status = 'failed'");
  });

  it('rejects panels without an effective sheet mapping before calling create (Variant B: sheet id required)', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        panelRows: [
          {
            bazis_node_id: 101,
            object_type: 'Панель',
            name: 'Фасад',
            position: '7',
            designation: 'D-01',
            cumulative_quantity: 2,
            length_mm: 1200,
            width_mm: 450,
            main_material_name: 'Неизвестный лист',
            raw_json: {},
          },
        ],
        mappingRows: [],
      },
    });
    const create = vi.fn();
    const repository = new PgBazisRepository(database.service, { create });

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toMatchObject({
      statusCode: 422,
      code: 'BAZIS_UNMAPPED_MATERIALS',
      details: { unmappedMaterials: ['Неизвестный лист'] },
    });

    expect(create).not.toHaveBeenCalled();
    expect(normalizedSql(database.queries)).toContain("UPDATE command_idempotency_keys SET status = 'failed'");
  });
});

function createDatabase(
  options: {
    duplicateRevisionNo?: number;
    duplicateOtherProjectName?: string;
    materialMappings?: Array<{ source_kind: string; name: string }>;
    treeChildren?: Array<Record<string, unknown>>;
    upsertedMappings?: Array<Record<string, unknown>>;
    createOrderState?: {
      idempotencyConflict?: boolean;
      existingIdempotencyRow?: {
        request_hash: string;
        response_json: Record<string, unknown> | null;
        status: string;
        created_at: string;
      };
      revisionRow?: Record<string, unknown>;
      panelRows?: Array<Record<string, unknown>>;
      mappingRows?: Array<Record<string, unknown>>;
      nowIso?: string;
    };
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let auditId = 0;
  let nodeId = 500;
  let mappingIndex = 0;
  let createOrderRequestHash: unknown = null;
  const tx = {
    raw: {} as PoolClient,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        if (String(params[1]) === 'bazis.create_order') {
          createOrderRequestHash = params[5];
          return options.createOrderState?.idempotencyConflict
            ? { rows: [], rowCount: 0 }
            : {
                rows: [
                  {
                    idempotency_key: params[0],
                    request_hash: params[5],
                    response_json: null,
                    status: 'processing',
                    created_at: options.createOrderState?.nowIso ?? '2026-07-08T12:00:00.000Z',
                  },
                ],
                rowCount: 1,
              };
        }
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash, response_json, status, created_at FROM command_idempotency_keys')) {
        const row = options.createOrderState?.existingIdempotencyRow;
        return row
          ? { rows: [row], rowCount: 1 }
          : {
              rows: [{
                idempotency_key: params[0],
                request_hash: createOrderRequestHash,
                response_json: null,
                status: 'processing',
                created_at: options.createOrderState?.nowIso ?? '2026-07-08T12:00:00.000Z',
              }],
              rowCount: 1,
            };
      }

      if (normalized.startsWith("UPDATE command_idempotency_keys SET status = 'completed'")) {
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE command_idempotency_keys SET status = 'failed'")) {
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT r.bazis_revision_id')) {
        return options.createOrderState?.revisionRow
          ? { rows: [options.createOrderState.revisionRow], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('WITH RECURSIVE sel AS')) {
        return {
          rows: options.createOrderState?.panelRows ?? [],
          rowCount: options.createOrderState?.panelRows?.length ?? 0,
        };
      }

      if (normalized.startsWith('SELECT source_kind, lower(bazis_name) AS name, target_kind')) {
        return {
          rows: options.createOrderState?.mappingRows ?? [],
          rowCount: options.createOrderState?.mappingRows?.length ?? 0,
        };
      }

      if (normalized.startsWith('INSERT INTO bazis_projects')) {
        return { rows: [{ bazis_project_id: 41 }], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT bazis_project_id, project_id, name FROM bazis_projects')) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT revision_no FROM bazis_project_revisions')) {
        return options.duplicateRevisionNo != null
          ? { rows: [{ revision_no: options.duplicateRevisionNo }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT r.bazis_project_id, p.name FROM bazis_project_revisions r')) {
        return options.duplicateOtherProjectName
          ? { rows: [{ bazis_project_id: 99, name: options.duplicateOtherProjectName }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM bazis_project_revisions')) {
        return { rows: [{ next: 3 }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO bazis_project_revisions')) {
        return { rows: [{ bazis_revision_id: 82 }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO bazis_nodes')) {
        nodeId += 1;
        return { rows: [{ bazis_node_id: nodeId }], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT source_kind, lower(bazis_name) AS name FROM bazis_material_mappings')) {
        return { rows: options.materialMappings ?? [], rowCount: options.materialMappings?.length ?? 0 };
      }
      if (normalized.startsWith('INSERT INTO audit_log (')) {
        auditId += 1;
        return { rows: [{ audit_id: `audit-${auditId}` }], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT bp.bazis_project_id')) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT r.bazis_revision_id')) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT n.bazis_node_id')) {
        return { rows: options.treeChildren ?? [], rowCount: options.treeChildren?.length ?? 0 };
      }
      if (normalized.startsWith('INSERT INTO bazis_material_mappings')) {
        const row = options.upsertedMappings?.[mappingIndex];
        mappingIndex += 1;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (normalized.startsWith('SELECT bazis_material_mapping_id')) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    tx,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
      async query<T extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ) {
        return tx.query(text, params) as Promise<{ rows: T[]; rowCount: number }>;
      },
    } as unknown as DatabaseService,
  };
}

function importCommand(overrides: Partial<{ parsed: ParsedBazisRevision }> = {}) {
  return {
    currentUser: currentUser(),
    requestId: 'req-1',
    projectId: 77,
    bazisProjectId: null,
    fileName: 'nova.xml',
    fileSize: 2048,
    xmlSha256: 'sha-001',
    rawXmlGzip: Buffer.from('gz'),
    parsed: overrides.parsed ?? parsedRevision(),
  };
}

function createOrderCommand(
  overrides: Partial<{
    revisionId: number;
    clientId: number;
    orderName: string;
    orderStatusId: number;
    selectedNodeIds: number[];
    idempotencyKey: string;
    requestId: string;
  }> = {},
) {
  return {
    currentUser: currentUser(),
    requestId: overrides.requestId ?? 'req-create-order',
    revisionId: overrides.revisionId ?? 82,
    clientId: overrides.clientId ?? 5,
    orderName: overrides.orderName ?? 'ERP order',
    orderStatusId: overrides.orderStatusId ?? 3,
    selectedNodeIds: overrides.selectedNodeIds ?? [11],
    idempotencyKey: overrides.idempotencyKey ?? 'bazis-create-order-001',
  };
}

function parsedRevision(overrides: Partial<ParsedBazisRevision> = {}): ParsedBazisRevision {
  return {
    bazisVersion: '11',
    productName: 'Шкаф Nova',
    productPrice: 1200,
    nodes: [
      {
        index: 0,
        parentIndex: null,
        seq: 1,
        nodeKind: 'product',
        objectType: null,
        name: 'Root',
        detailCode: null,
        position: null,
        designation: null,
        quantity: 1,
        cumulativeQuantity: 1,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        thicknessMm: null,
        price: null,
        isRectangular: null,
        textureOrientation: null,
        mainMaterialName: null,
        raw: {},
      },
      {
        index: 1,
        parentIndex: 0,
        seq: 2,
        nodeKind: 'object',
        objectType: 'Panel',
        name: 'Door',
        detailCode: 'D-1',
        position: 'A1',
        designation: null,
        quantity: 2,
        cumulativeQuantity: 2,
        lengthMm: 1000,
        widthMm: 500,
        heightMm: null,
        thicknessMm: 16,
        price: 200,
        isRectangular: true,
        textureOrientation: 'along',
        mainMaterialName: 'Laminate White',
        raw: { kind: 'panel' },
      },
    ],
    materials: [
      { name: 'Laminate White', kindGuess: 'sheet', usageCount: 2 },
      { name: 'ABS 2mm', kindGuess: 'edge', usageCount: 4 },
    ],
    summary: {
      totalNodes: 2,
      panels: 1,
      hardware: 0,
      assemblies: 0,
      blocks: 0,
      uniqueMaterials: 2,
    },
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role'] = 'manager'): CurrentUser {
  return { id: '1', username: role, role, roleId: 10, permissions: getPermissionsForRole(role) };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function hashCreateOrderRequestShape(command: ReturnType<typeof createOrderCommand>): string {
  return createHash('sha256')
    .update(
      stableStringify({
        revisionId: command.revisionId,
        clientId: command.clientId,
        orderName: command.orderName,
        orderStatusId: command.orderStatusId,
        selectedNodeIds: [...command.selectedNodeIds].sort((left, right) => left - right),
        actorUserId: Number(command.currentUser.id),
        commandName: 'bazis.create_order',
      }),
    )
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function buildOrderDto(orderId: number, orderName: string): OrderDto {
  return {
    header: {
      orderId,
      orderName,
      clientId: 5,
      clientName: 'Client',
      orderDate: '2026-07-08',
      priority: 100,
      managerId: 1,
      orderStatusId: 3,
      paymentStatusId: 1,
      productionStatusId: null,
      productionStatusFromDetailsEnabled: true,
      plannedCompletionDate: null,
      completionDate: null,
      issueDate: null,
      paymentDate: null,
      discount: 0,
      surcharge: 0,
      totalAmount: 0,
      finalAmount: 0,
      paidAmount: 0,
      partsCount: 0,
      totalArea: 0,
      createdAt: '2026-07-08T12:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
      createdBy: 1,
      editedBy: 1,
      version: 1,
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
      projectId: 77,
      projectCode: 'МП-77',
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    primaryGroup: null,
    groups: [],
    totals: {
      totalAmount: 0,
      finalAmount: 0,
      paidAmount: 0,
      debtAmount: 0,
      partsCount: 0,
      totalArea: 0,
    },
    version: 1,
    createdAt: '2026-07-08T12:00:00.000Z',
    updatedAt: '2026-07-08T12:00:00.000Z',
    createdBy: 1,
    editedBy: 1,
  };
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
