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
  BazisNodeNotFoundError,
  BazisProjectNotFoundError,
  BazisRevisionDuplicateError,
  BazisRevisionNotFoundError,
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

  it('prunes revisions beyond the last 3 after import: lock, link re-check, deletes, rich audit + outbox + warning', async () => {
    const database = createDatabase({ pruneCandidates: [pruneCandidateRow(50, 1)] });
    const repository = new PgBazisRepository(database.service);

    const response = await repository.importRevision(importCommand());

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    const insertRevisionIdx = ordered.findIndex((sql) => sql.startsWith('INSERT INTO bazis_project_revisions'));
    const pruneSelectIdx = ordered.findIndex((sql) => sql.includes('prune_keep'));
    const linkRecheckIdx = ordered.findIndex((sql) =>
      sql.includes('FROM bazis_order_links') && sql.includes('ANY'));
    const pruneRunsIdx = ordered.findIndex((sql) => sql.startsWith('DELETE FROM bazis_import_runs'));
    const pruneRevisionsIdx = ordered.findIndex((sql) => sql.startsWith('DELETE FROM bazis_project_revisions'));

    // Кандидаты лочатся FOR UPDATE (единый порядок локов revision→nodes с create-order),
    // затем перепроверка links свежим снапшотом, и только потом удаления.
    expect(ordered[pruneSelectIdx]).toContain('FOR UPDATE');
    expect(pruneSelectIdx).toBeGreaterThan(insertRevisionIdx);
    expect(linkRecheckIdx).toBeGreaterThan(pruneSelectIdx);
    expect(pruneRunsIdx).toBeGreaterThan(linkRecheckIdx);
    expect(pruneRevisionsIdx).toBeGreaterThan(pruneRunsIdx);

    const audit = database.queries.find(
      (query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log (') && query.params?.[0] === 'bazis.revision_pruned',
    );
    expect(audit).toBeDefined();
    // before-снапшот несёт полные метаданные удаляемой ревизии (hard delete).
    const before = String(audit?.params?.[19] ?? '');
    expect(before).toContain('"fileName":"old.xml"');
    expect(before).toContain('"xmlSha256":"sha-old"');
    expect(before).toContain('"nodesCount":25');
    expect(before).toContain('"revisionNo":1');

    const outboxKeys = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO outbox_events'))
      .map((query) => query.params?.[4]);
    expect(outboxKeys).toContain('bazis-revision-pruned-50');

    expect(response.warnings.some((warning) => warning.includes('Ревизия №1'))).toBe(true);
  });

  it('skips candidates that acquired order links between selection and the re-check', async () => {
    const database = createDatabase({
      pruneCandidates: [pruneCandidateRow(50, 1), pruneCandidateRow(51, 2)],
      pruneProtectedRevisionIds: [50],
    });
    const repository = new PgBazisRepository(database.service);

    const response = await repository.importRevision(importCommand());

    const revisionDelete = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('DELETE FROM bazis_project_revisions'));
    expect(revisionDelete?.params?.[0]).toEqual([51]);
    expect(response.warnings.some((warning) => warning.includes('Ревизия №2'))).toBe(true);
    expect(response.warnings.some((warning) => warning.includes('Ревизия №1'))).toBe(false);
  });

  it('does not prune anything when all revisions fit the retention window', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    const response = await repository.importRevision(importCommand());

    const deletes = database.queries.filter((query) => normalizeSql(query.text).startsWith('DELETE FROM'));
    expect(deletes).toEqual([]);
    expect(response.warnings).toEqual([]);
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
        orderIds: [],
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

describe('PgBazisRepository.listAllTreeNodes', () => {
  it('reads the whole revision in one revision-scoped query ordered parents-first', async () => {
    const database = createDatabase({ nodeSearch: { total: 0, rows: [] } });
    const repository = new PgBazisRepository(database.service);

    await repository.listAllTreeNodes(82);

    const sql = normalizeSql(database.queries[1].text);
    expect(sql).toContain('FROM bazis_nodes n WHERE n.revision_id = $1');
    expect(sql).toContain('c.revision_id = n.revision_id');
    expect(sql).toContain('ORDER BY n.parent_node_id NULLS FIRST, n.seq');
    expect(database.queries[1].params).toEqual([82]);
  });

  it('throws BazisRevisionNotFoundError for unknown revision', async () => {
    const database = createDatabase({ nodeSearch: { revisionExists: false } });
    const repository = new PgBazisRepository(database.service);
    await expect(repository.listAllTreeNodes(1)).rejects.toBeInstanceOf(BazisRevisionNotFoundError);
  });
});

describe('PgBazisRepository.getRevisionEstimate', () => {
  it('extracts materials and operations from raw_json with jsonb guards', async () => {
    const database = createDatabase({ nodeSearch: { total: 0, rows: [] } });
    const repository = new PgBazisRepository(database.service);

    await repository.getRevisionEstimate(82);

    const materialsSql = normalizeSql(database.queries[1].text);
    expect(materialsSql).toContain("jsonb_typeof(n.raw_json->'ОсновнойМатериал') = 'object'");
    expect(materialsSql).toContain("m.value->>'ID' AS material_id");
    expect(materialsSql).toContain("n.raw_json->>'Код' AS node_code");
    const operationsSql = normalizeSql(database.queries[2].text);
    expect(operationsSql).toContain("n.raw_json->'СписокОпераций'->'СдельнаяОперация'");
    expect(operationsSql).toContain('jsonb_typeof');
    expect(database.queries[1].params).toEqual([82]);
    expect(database.queries[2].params).toEqual([82]);
  });

  it('throws BazisRevisionNotFoundError for unknown revision', async () => {
    const database = createDatabase({ nodeSearch: { revisionExists: false } });
    const repository = new PgBazisRepository(database.service);
    await expect(repository.getRevisionEstimate(1)).rejects.toBeInstanceOf(BazisRevisionNotFoundError);
  });
});

describe('PgBazisRepository.getNodeCard', () => {
  it('reads node with revision context and order links', async () => {
    const database = createDatabase({
      nodeCard: {
        row: {
          bazis_node_id: 555,
          revision_id: 82,
          parent_node_id: 10,
          seq: 4,
          node_kind: 'object',
          object_type: 'Панель',
          name: 'Дверь',
          detail_code: 'D-1',
          position: 'A1',
          designation: 'D-01',
          quantity: 1,
          cumulative_quantity: 2,
          length_mm: 1000,
          width_mm: 500,
          height_mm: null,
          thickness_mm: 16,
          price: 200,
          is_rectangular: true,
          texture_orientation: 'along',
          main_material_name: 'Laminate White',
          raw_json: { ТипОбъекта: 'Панель' },
          children_count: 0,
          bazis_project_id: 41,
          revision_no: 3,
          project_id: 77,
        },
        orderLinks: [{ order_id: 9001, order_detail_id: 501, mapping_kind: 'created' }],
      },
    });
    const repository = new PgBazisRepository(database.service);

    const card = await repository.getNodeCard(555);

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered[0]).toContain('FROM bazis_nodes n JOIN bazis_project_revisions r');
    // child-count строго в границах ревизии: parent_node_id — self-FK без
    // same-revision constraint, ручная правка БД не должна протекать (Critic R2)
    expect(ordered[0]).toContain('c.revision_id = n.revision_id');
    expect(ordered[1]).toContain('FROM bazis_node_order_detail_map');
    expect(card).toMatchObject({
      bazisNodeId: 555,
      revisionId: 82,
      bazisProjectId: 41,
      projectId: 77,
      revisionNo: 3,
      rawJson: { ТипОбъекта: 'Панель' },
      orderLinks: [{ orderId: 9001, orderDetailId: 501, mappingKind: 'created' }],
    });
  });

  it('throws BazisNodeNotFoundError when node is missing', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);
    await expect(repository.getNodeCard(1)).rejects.toBeInstanceOf(BazisNodeNotFoundError);
  });
});

describe('PgBazisRepository.searchNodes', () => {
  it('escapes ILIKE wildcards, limits matches and returns ancestor paths root-first', async () => {
    const database = createDatabase({
      nodeSearch: {
        total: 3,
        rows: [
          {
            bazis_node_id: 555,
            node_kind: 'object',
            object_type: 'Панель',
            name: 'Дверь',
            position: 'A1',
            designation: 'D-01',
            main_material_name: 'Laminate White',
            ancestor_id: 100,
            ancestor_name: 'Корень',
            depth: 2,
          },
          {
            bazis_node_id: 555,
            node_kind: 'object',
            object_type: 'Панель',
            name: 'Дверь',
            position: 'A1',
            designation: 'D-01',
            main_material_name: 'Laminate White',
            ancestor_id: 200,
            ancestor_name: 'Шкаф',
            depth: 1,
          },
          {
            bazis_node_id: 555,
            node_kind: 'object',
            object_type: 'Панель',
            name: 'Дверь',
            position: 'A1',
            designation: 'D-01',
            main_material_name: 'Laminate White',
            ancestor_id: 555,
            ancestor_name: 'Дверь',
            depth: 0,
          },
        ],
      },
    });
    const repository = new PgBazisRepository(database.service);

    const response = await repository.searchNodes({
      revisionId: 82,
      q: '50%_шкаф',
      objectType: null,
      limit: 50,
    });

    const searchQuery = database.queries[2];
    expect(searchQuery.params).toContain('%50\\%\\_шкаф%');
    const sql = normalizeSql(searchQuery.text);
    expect(sql).toContain('WITH RECURSIVE');
    // cycle guard + depth cap + revision-scope: мок не исполняет SQL, поэтому
    // текст-ассертами фиксируем наличие защит (BLOCKER R1, revision-scope R2)
    expect(sql).toContain('NOT p.bazis_node_id = ANY(a.visited)');
    expect(sql).toContain('a.depth < 100');
    expect(sql).toContain('p.revision_id = $1');
    // root-first порядок держится на этом ORDER BY — текстовый пин против регрессии
    expect(sql).toContain('ORDER BY m.bazis_node_id, a.depth DESC');
    expect(response.totalMatched).toBe(3);
    expect(response.items).toHaveLength(1);
    expect(response.items[0].pathNodeIds).toEqual([100, 200]); // root → parent
    expect(response.items[0].pathTitles).toEqual(['Корень', 'Шкаф']);
  });

  it('filters by objectType without q', async () => {
    const database = createDatabase({ nodeSearch: { total: 0, rows: [] } });
    const repository = new PgBazisRepository(database.service);
    await repository.searchNodes({ revisionId: 82, q: null, objectType: 'Панель', limit: 50 });
    expect(database.queries[1].params).toEqual([82, 'Панель', null]);
  });

  it('throws BazisRevisionNotFoundError for unknown revision', async () => {
    const database = createDatabase({ nodeSearch: { revisionExists: false } });
    const repository = new PgBazisRepository(database.service);
    await expect(
      repository.searchNodes({ revisionId: 1, q: 'x', objectType: null, limit: 50 }),
    ).rejects.toBeInstanceOf(BazisRevisionNotFoundError);
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
    // Единый порядок локов с prune: сначала KEY SHARE на строку ревизии,
    // потом FK-локи на nodes через map-инсерты.
    const orderedHook = database.queries.map((query) => normalizeSql(query.text));
    const revisionLockIdx = orderedHook.findIndex((sqlText) => sqlText.includes('FOR KEY SHARE'));
    const mapInsertIdx = orderedHook.findIndex((sqlText) => sqlText.startsWith('INSERT INTO bazis_node_order_detail_map'));
    expect(revisionLockIdx).toBeGreaterThan(-1);
    expect(revisionLockIdx).toBeLessThan(mapInsertIdx);
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

describe('PgBazisRepository.getMaterialsSummary', () => {
  it('aggregates panels by material with mapping status, hardware, edges and films', async () => {
    const database = createDatabase({
      materialsSummary: {
        summaryRow: { summary_json: { totalNodes: 20, panels: 10, hardware: 3, assemblies: 1, blocks: 0, uniqueMaterials: 2 } },
        panelRows: [
          {
            main_material_name: 'ЛДСП Белый',
            panel_count: 10,
            total_quantity: 10,
            total_area_m2: 12.5,
            target_kind: 'sheet',
            sheet_material_type_id: 501,
          },
        ],
        hardwareRows: [{ name: 'Петля', total_quantity: 8 }],
        edgeRows: [{ name: 'ABS 2mm Белый', usage_count: 6 }],
        filmRows: [{ name: 'Snow Film', usage_count: 4 }],
      },
    });
    // responder 1: summary_json ревизии; 2: panels; 3: hardware; 4: edges; 5: films
    const repository = new PgBazisRepository(database.service);

    const summary = await repository.getMaterialsSummary(82);

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered[0]).toContain('FROM bazis_project_revisions');
    expect(ordered[1]).toContain("n.object_type = 'Панель'");
    expect(ordered[1]).toContain("mm.source_kind = 'sheet'");
    expect(ordered[3]).toContain('СписокКромок1');
    // raw_json без shape-constraint: каждая array-источник обязана быть под jsonb_typeof-guard (Critic R1)
    expect(ordered[3]).toContain('jsonb_typeof');
    expect(ordered[4]).toContain('jsonb_typeof');
    expect(summary.panelsByMaterial[0]).toMatchObject({
      materialName: 'ЛДСП Белый', panelCount: 10, totalAreaM2: 12.5, mappingTargetKind: 'sheet',
    });
    expect(summary.hardwareByName).toEqual([{ name: 'Петля', totalQuantity: 8 }]);
    expect(summary.edgesByName).toEqual([{ name: 'ABS 2mm Белый', usageCount: 6, totalLengthMm: null }]);
    expect(summary.filmsByName).toEqual([{ name: 'Snow Film', usageCount: 4, totalLengthMm: null }]);
    expect(summary.summary).toMatchObject({ totalNodes: 20, panels: 10 });
  });

  it('throws BazisRevisionNotFoundError for unknown revision', async () => {
    const database = createDatabase(); // responder 1: пустой rows
    const repository = new PgBazisRepository(database.service);
    await expect(repository.getMaterialsSummary(1)).rejects.toBeInstanceOf(BazisRevisionNotFoundError);
  });
});

describe('PgBazisRepository.listRevisionOrders', () => {
  it('joins bazis_order_links with orders and per-order node counts', async () => {
    const database = createDatabase({
      revisionOrders: [
        {
          order_id: 9001,
          order_name: 'Тест-заказ 1',
          created_at: '2026-07-08 10:00:00+00',
          nodes_mapped: 12,
          details_created: 10,
        },
      ],
    });
    // responder 1 (revision exists): [{ ok: 1 }]; responder 2: одна строка order 9001
    const repository = new PgBazisRepository(database.service);

    const orders = await repository.listRevisionOrders(82);

    const sql = normalizeSql(database.queries[1].text);
    expect(sql).toContain('FROM bazis_order_links bol');
    expect(sql).toContain('JOIN orders o ON o.order_id = bol.order_id');
    // счётчик деталей — по order_detail_id, НЕ по mapping_kind (см. семантику выше)
    expect(sql).toContain('FILTER (WHERE map.order_detail_id IS NOT NULL)');
    // скоуп агрегата границей ревизии — пин против cross-revision утечки счётчиков
    expect(sql).toContain('JOIN bazis_nodes n ON n.bazis_node_id = map.node_id');
    expect(sql).toContain('WHERE n.revision_id = $1');
    expect(orders).toEqual([{
      orderId: 9001, orderName: 'Тест-заказ 1', createdAt: '2026-07-08 10:00:00+00',
      nodesMapped: 12, detailsCreated: 10,
    }]);
  });

  it('throws BazisRevisionNotFoundError for unknown revision', async () => {
    const database = createDatabase({ nodeSearch: { revisionExists: false } }); // responder 1: пустой rows
    const repository = new PgBazisRepository(database.service);
    await expect(repository.listRevisionOrders(1)).rejects.toBeInstanceOf(BazisRevisionNotFoundError);
  });
});

describe('PgBazisRepository.createOrderFromRevision revision lock', () => {
  it('fails the hook with BazisRevisionNotFoundError when the revision was pruned concurrently', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionGoneAtHook: true,
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
            cumulative_quantity: 1,
            length_mm: 100,
            width_mm: 50,
            main_material_name: 'ЛДСП',
            raw_json: {},
          },
        ],
        mappingRows: [
          {
            source_kind: 'sheet',
            name: 'лдсп',
            target_kind: 'sheet',
            sheet_material_type_id: 501,
            film_id: null,
            edge_type_id: null,
          },
        ],
      },
    });
    const orderTransactions: Pick<OrderTransactionService, 'create'> = {
      async create(command) {
        await expect(
          command.postPersistHook?.(
            { getTransactionClient: () => database.tx },
            { orderId: 9001, detailIdsByClientKey: new Map([['bazis-node-101', 7001]]) },
          ),
        ).rejects.toBeInstanceOf(BazisRevisionNotFoundError);
        throw new BazisRevisionNotFoundError(82);
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toBeInstanceOf(
      BazisRevisionNotFoundError,
    );
    // Доказательство, что reject пришёл именно из hook-лока, а не раньше.
    const lockQueries = database.queries.filter((query) => normalizeSql(query.text).includes('FOR KEY SHARE'));
    expect(lockQueries).toHaveLength(1);
  });
});

describe('PgBazisRepository tree order provenance', () => {
  it('exposes orderIds on tree nodes from the node-order map (created details only)', async () => {
    const database = createDatabase({
      treeChildren: [
        {
          bazis_node_id: 101,
          parent_node_id: null,
          seq: 0,
          node_kind: 'object',
          object_type: 'Панель',
          name: 'Фасад',
          detail_code: null,
          position: '7',
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: 100,
          width_mm: 50,
          thickness_mm: 16,
          main_material_name: 'ЛДСП',
          children_count: 0,
          order_ids: [11385, 11390],
        },
        {
          bazis_node_id: 102,
          parent_node_id: null,
          seq: 1,
          node_kind: 'assembly',
          object_type: null,
          name: 'Секция',
          detail_code: null,
          position: null,
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: null,
          width_mm: null,
          thickness_mm: null,
          main_material_name: null,
          children_count: 3,
          order_ids: null,
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const nodes = await repository.getTreeChildren(5, null);

    expect(nodes[0].orderIds).toEqual([11385, 11390]);
    expect(nodes[1].orderIds).toEqual([]);

    // Агрегат считает только реально созданные детали (order_detail_id NOT NULL),
    // а не любые map-строки (mapping_kind='ignored' не «добавлен в заказ»).
    const treeSql = database.queries
      .map((query) => normalizeSql(query.text))
      .find((sql) => sql.startsWith('SELECT n.bazis_node_id, n.parent_node_id'));
    expect(treeSql).toContain('bazis_node_order_detail_map');
    expect(treeSql).toContain('order_detail_id IS NOT NULL');
  });

  it('returns populated orderIds from the full-tree read (behavior, not just SQL shape)', async () => {
    const database = createDatabase({
      treeChildren: [
        {
          bazis_node_id: 201,
          parent_node_id: null,
          seq: 0,
          node_kind: 'object',
          object_type: 'Панель',
          name: 'Полка',
          detail_code: null,
          position: '3',
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: 800,
          width_mm: 300,
          thickness_mm: 16,
          main_material_name: 'ЛДСП',
          children_count: 0,
          order_ids: [11385],
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const nodes = await repository.listAllTreeNodes(5);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].orderIds).toEqual([11385]);

    const fullTreeSql = database.queries
      .map((query) => normalizeSql(query.text))
      .filter((sql) => sql.startsWith('SELECT n.bazis_node_id, n.parent_node_id'));
    expect(fullTreeSql.length).toBeGreaterThan(0);
    for (const sql of fullTreeSql) {
      expect(sql).toContain('bazis_node_order_detail_map');
      expect(sql).toContain('order_detail_id IS NOT NULL');
    }
  });
});

describe('PgBazisRepository.getTreeChildren', () => {
  it('throws BazisRevisionNotFoundError when the read returns nothing and the revision is gone (pruned)', async () => {
    const database = createDatabase({ nodeSearch: { revisionExists: false } });
    const repository = new PgBazisRepository(database.service);

    await expect(repository.getTreeChildren(5, null)).rejects.toBeInstanceOf(BazisRevisionNotFoundError);

    // Существование проверяется ПОСЛЕ чтения nodes (закрытие TOCTOU-окна):
    // порядок statement'ов — сначала SELECT nodes, затем SELECT 1 AS ok.
    const ordered = database.queries.map((query) => normalizeSql(query.text));
    const nodesIdx = ordered.findIndex((sql) => sql.startsWith('SELECT n.bazis_node_id'));
    const existsIdx = ordered.findIndex((sql) => sql.startsWith('SELECT 1 AS ok FROM bazis_project_revisions'));
    expect(nodesIdx).toBeGreaterThan(-1);
    expect(existsIdx).toBeGreaterThan(nodesIdx);
  });

  it('does not run the existence probe when the read returns children (hot path)', async () => {
    const database = createDatabase({
      treeChildren: [
        {
          bazis_node_id: 1,
          parent_node_id: null,
          seq: 0,
          node_kind: 'product',
          object_type: 'Модель',
          name: 'Шкаф',
          detail_code: null,
          position: null,
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: null,
          width_mm: null,
          thickness_mm: null,
          main_material_name: null,
          children_count: 4,
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const nodes = await repository.getTreeChildren(5, null);

    expect(nodes).toHaveLength(1);
    const probes = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('SELECT 1 AS ok FROM bazis_project_revisions'));
    expect(probes).toEqual([]);
  });
});

function createDatabase(
  options: {
    duplicateRevisionNo?: number;
    duplicateOtherProjectName?: string;
    materialMappings?: Array<{ source_kind: string; name: string }>;
    treeChildren?: Array<Record<string, unknown>>;
    upsertedMappings?: Array<Record<string, unknown>>;
    nodeCard?: {
      row?: Record<string, unknown> | null;
      orderLinks?: Array<Record<string, unknown>>;
    };
    nodeSearch?: {
      revisionExists?: boolean;
      total?: number;
      rows?: Array<Record<string, unknown>>;
    };
    createOrderState?: {
      idempotencyConflict?: boolean;
      existingIdempotencyRow?: {
        request_hash: string;
        response_json: Record<string, unknown> | null;
        status: string;
        created_at: string;
      };
      revisionRow?: Record<string, unknown>;
      revisionGoneAtHook?: boolean;
      panelRows?: Array<Record<string, unknown>>;
      mappingRows?: Array<Record<string, unknown>>;
      nowIso?: string;
    };
    materialsSummary?: {
      summaryRow?: Record<string, unknown> | null;
      panelRows?: Array<Record<string, unknown>>;
      hardwareRows?: Array<Record<string, unknown>>;
      edgeRows?: Array<Record<string, unknown>>;
      filmRows?: Array<Record<string, unknown>>;
    };
    revisionOrders?: Array<Record<string, unknown>>;
    pruneCandidates?: Array<Record<string, unknown>>;
    pruneProtectedRevisionIds?: number[];
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
      if (normalized.startsWith('SELECT n.bazis_node_id, n.revision_id')) {
        const row = options.nodeCard?.row;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT 1 AS ok FROM bazis_project_revisions')) {
        return options.nodeSearch?.revisionExists === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ ok: 1 }], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT count(*)::int AS total FROM bazis_nodes n WHERE')) {
        return { rows: [{ total: options.nodeSearch?.total ?? 0 }], rowCount: 1 };
      }
      if (normalized.startsWith('WITH RECURSIVE matches AS')) {
        return {
          rows: options.nodeSearch?.rows ?? [],
          rowCount: options.nodeSearch?.rows?.length ?? 0,
        };
      }
      if (normalized.startsWith('SELECT m.order_id, m.order_detail_id, m.mapping_kind')) {
        return {
          rows: options.nodeCard?.orderLinks ?? [],
          rowCount: options.nodeCard?.orderLinks?.length ?? 0,
        };
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
      if (normalized.startsWith('SELECT summary_json FROM bazis_project_revisions')) {
        return options.materialsSummary?.summaryRow
          ? { rows: [options.materialsSummary.summaryRow], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT n.main_material_name,')) {
        return {
          rows: options.materialsSummary?.panelRows ?? [],
          rowCount: options.materialsSummary?.panelRows?.length ?? 0,
        };
      }
      if (normalized.startsWith('SELECT n.name,')) {
        return {
          rows: options.materialsSummary?.hardwareRows ?? [],
          rowCount: options.materialsSummary?.hardwareRows?.length ?? 0,
        };
      }
      if (normalized.includes('СписокКромок1')) {
        return {
          rows: options.materialsSummary?.edgeRows ?? [],
          rowCount: options.materialsSummary?.edgeRows?.length ?? 0,
        };
      }
      if (normalized.includes('ОблицовкаПласти1')) {
        return {
          rows: options.materialsSummary?.filmRows ?? [],
          rowCount: options.materialsSummary?.filmRows?.length ?? 0,
        };
      }
      if (normalized.startsWith('SELECT bol.order_id,')) {
        return {
          rows: options.revisionOrders ?? [],
          rowCount: options.revisionOrders?.length ?? 0,
        };
      }

      if (normalized.includes('FOR KEY SHARE')) {
        return options.createOrderState?.revisionGoneAtHook
          ? { rows: [], rowCount: 0 }
          : { rows: [{ bazis_revision_id: 82 }], rowCount: 1 };
      }

      if (normalized.includes('prune_keep')) {
        const rows = options.pruneCandidates ?? [];
        return { rows, rowCount: rows.length };
      }

      if (normalized.includes('FROM bazis_order_links') && normalized.includes('ANY')) {
        const rows = (options.pruneProtectedRevisionIds ?? []).map((revisionId) => ({ revision_id: revisionId }));
        return { rows, rowCount: rows.length };
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

describe('PgBazisRepository.deleteProject', () => {
  it('deletes runs, revisions (nodes cascade) and project, writes audit + outbox, returns summary', async () => {
    const database = createDeleteDatabase();
    const repository = new PgBazisRepository(database.service);

    const response = await repository.deleteProject({
      currentUser: currentUser('admin'),
      requestId: 'req-delete-1',
      bazisProjectId: 41,
    });

    expect(response).toEqual({
      bazisProjectId: 41,
      projectId: 77,
      name: 'Шкаф Nova',
      revisionsDeleted: 2,
      nodesDeleted: 639,
    });

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered[0]).toBe('SELECT set_session_user($1)');
    const lockIdx = ordered.findIndex((sql) => sql.includes('FROM bazis_projects') && sql.includes('FOR UPDATE'));
    const linksIdx = ordered.findIndex((sql) => sql.includes('FROM bazis_order_links'));
    const runsIdx = ordered.findIndex((sql) => sql.startsWith('DELETE FROM bazis_import_runs'));
    const revisionsIdx = ordered.findIndex((sql) => sql.startsWith('DELETE FROM bazis_project_revisions'));
    const projectIdx = ordered.findIndex((sql) => sql.startsWith('DELETE FROM bazis_projects'));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(linksIdx).toBeGreaterThan(lockIdx);
    expect(runsIdx).toBeGreaterThan(linksIdx);
    expect(revisionsIdx).toBeGreaterThan(runsIdx);
    expect(projectIdx).toBeGreaterThan(revisionsIdx);

    const audit = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log ('));
    expect(audit?.params?.[0]).toBe('bazis.project_deleted');
    const relatedPairs = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log_related_entity'))
      .map((query) => [query.params?.[1], query.params?.[2]]);
    expect(relatedPairs).toEqual([
      ['project', 77],
      ['bazis_project', 41],
    ]);

    const outbox = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO outbox_events'));
    expect(outbox?.params?.[0]).toBe('bazis.project_deleted');
    expect(outbox?.params?.[4]).toBe('bazis-project-deleted-41');
  });

  it('throws BazisProjectNotFoundError when the project is missing', async () => {
    const database = createDeleteDatabase({ projectRow: null });
    const repository = new PgBazisRepository(database.service);

    await expect(
      repository.deleteProject({ currentUser: currentUser('admin'), bazisProjectId: 404 }),
    ).rejects.toBeInstanceOf(BazisProjectNotFoundError);
  });

  it('rejects with 409 BAZIS_PROJECT_HAS_ORDERS and deletes nothing when order links exist', async () => {
    const database = createDeleteDatabase({ linkedOrderIds: [11384, 11390] });
    const repository = new PgBazisRepository(database.service);

    await expect(
      repository.deleteProject({ currentUser: currentUser('admin'), bazisProjectId: 41 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'BAZIS_PROJECT_HAS_ORDERS',
      details: { orderIds: [11384, 11390] },
    });

    const deletes = database.queries.filter((query) => normalizeSql(query.text).startsWith('DELETE FROM'));
    expect(deletes).toEqual([]);
  });
});

function createDeleteDatabase(
  options: {
    projectRow?: { bazis_project_id: number; project_id: number; name: string } | null;
    linkedOrderIds?: number[];
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let auditId = 900;
  const projectRow =
    options.projectRow === null
      ? null
      : options.projectRow ?? { bazis_project_id: 41, project_id: 77, name: 'Шкаф Nova' };

  const tx = {
    raw: {} as PoolClient,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.includes('FROM bazis_projects') && normalized.includes('FOR UPDATE')) {
        return projectRow ? { rows: [projectRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (normalized.includes('FROM bazis_order_links')) {
        const rows = (options.linkedOrderIds ?? []).map((orderId) => ({ order_id: orderId }));
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('AS revisions_count')) {
        return { rows: [{ revisions_count: 2, nodes_count: 639 }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO audit_log (')) {
        auditId += 1;
        return { rows: [{ audit_id: auditId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
      async query(text: string, params: readonly unknown[] = []) {
        return tx.query(text, params);
      },
    } as unknown as DatabaseService,
  };
}

function pruneCandidateRow(bazisRevisionId: number, revisionNo: number): Record<string, unknown> {
  return {
    bazis_revision_id: bazisRevisionId,
    revision_no: revisionNo,
    file_name: 'old.xml',
    file_size: 1000,
    xml_sha256: 'sha-old',
    bazis_version: '2022.12.21.36090',
    product_name: 'Старое изделие',
    product_price: 10,
    summary_json: { totalNodes: 25 },
    imported_by: 1,
    imported_at: '2026-07-01T10:00:00.000Z',
    request_id: 'req-old',
    nodes_count: 25,
  };
}
