import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
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
import { orderDtoToSaveDto } from './bazis-order-draft';
import { PgBazisRepository } from './pg-bazis-repository';

const { getOrderByIdMock } = vi.hoisted(() => ({
  getOrderByIdMock: vi.fn(),
}));

vi.mock('../../orders/adapters/pg-order-read-repository', () => ({
  PgOrderReadRepository: class {
    getOrderById = getOrderByIdMock;
  },
}));

beforeEach(() => {
  getOrderByIdMock.mockReset();
});

describe('PgBazisRepository.importRevision', () => {
  it('sets session user first, then inserts project/revision/nodes/audit/outbox/run', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    const response = await repository.importRevision(importCommand());

    expect(response.bazisProject).toEqual({ bazisProjectId: 41, projectId: 77, name: '1457' });
    expect(response.revision).toMatchObject({ bazisRevisionId: 82, revisionNo: 3, xmlSha256: 'sha-001' });

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered[0]).toBe('SELECT set_session_user($1)');
    expect(ordered.some((sql) => sql.startsWith('INSERT INTO bazis_projects'))).toBe(true);
    const projectInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_projects'),
    );
    expect(projectInsert?.params?.[1]).toBe('1457');
    expect(ordered).toContain('SELECT revision_no FROM bazis_project_revisions WHERE bazis_project_id = $1 AND xml_sha256 = $2');
    expect(ordered).toContain('INSERT INTO bazis_project_revisions (bazis_project_id, revision_no, file_name, file_size, xml_sha256, raw_xml, bazis_version, bazis_order_no, product_name, product_price, summary_json, imported_by, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) RETURNING bazis_revision_id');
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

  it('writes parsed bazisOrderNo into revision row when present', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.importRevision(importCommand({ parsed: parsedRevision({ bazisOrderNo: '1457' }) }));

    const revisionInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_project_revisions'),
    );
    expect(revisionInsert?.params[7]).toBe('1457');
  });

  it('matches the XML developer to one active employee and stores XML provenance', async () => {
    const database = createDatabase({
      activeEmployees: [{ employee_id: 10, full_name: 'Тапен Жамит' }],
    });
    const repository = new PgBazisRepository(database.service);

    const response = await repository.importRevision(importCommand({
      parsed: parsedRevision({ designEngineerName: 'Тапен Ж.К' }),
    }));

    const projectInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_projects'),
    );
    expect(projectInsert?.params.slice(3, 5)).toEqual([10, 'Тапен Ж.К']);
    expect(response.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('не найден однозначно'),
    ]));
  });

  it('falls back to first root productOrderNo when parsed bazisOrderNo is null', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.importRevision(
      importCommand({
        parsed: parsedRevision({
          bazisOrderNo: null,
          nodes: [
            {
              ...parsedRevision().nodes[0],
              productOrderNo: '1443',
            },
            parsedRevision().nodes[1],
          ],
        }),
      }),
    );

    const revisionInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_project_revisions'),
    );
    expect(revisionInsert?.params[7]).toBe('1443');
    const projectInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_projects'),
    );
    expect(projectInsert?.params[1]).toBe('1443');
  });

  it('stores null bazis_order_no when both parsed and root fallback values are absent', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.importRevision(
      importCommand({
        parsed: parsedRevision({
          bazisOrderNo: null,
          nodes: parsedRevision().nodes.map((node) => ({ ...node, productOrderNo: null })),
        }),
      }),
    );

    const revisionInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_project_revisions'),
    );
    expect(revisionInsert?.params[7]).toBeNull();
    const projectInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_projects'),
    );
    expect(projectInsert?.params[1]).toBe('nova.xml');
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
            designation: null,
            product_order_no: null,
            quantity: 1,
            cumulative_quantity: 1,
            length_mm: null,
            width_mm: null,
            thickness_mm: null,
            main_material_name: null,
            notes: null,
            edge_count: '0',
            has_drilling: false,
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
        designation: null,
        productOrderNo: null,
        quantity: 1,
        cumulativeQuantity: 1,
        lengthMm: null,
        widthMm: null,
        thicknessMm: null,
        mainMaterialName: null,
        edgeCount: 0,
        hasDrilling: false,
        millingName: null,
        filmName: null,
        paintName: null,
        notes: null,
        childrenCount: 2,
        orders: [],
        orderIds: [],
      },
    ]);
  });

  it('getProject throws BazisProjectNotFoundError', async () => {
    const repository = new PgBazisRepository(createDatabase().service);

    await expect(repository.getProject(999)).rejects.toBeInstanceOf(BazisProjectNotFoundError);
  });

  it('getProject returns bazisOrderNo from the latest revision column', async () => {
    const database = createDatabase({
      projectListRows: [
        {
          bazis_project_id: 14,
          project_id: 10,
          project_name: 'Квартира 1485',
          name: 'санузел + шкаф',
          revisions_count: 1,
          last_revision_no: 1,
          last_imported_at: '2026-07-10T12:44:00.000Z',
          bazis_order_no: '1457',
          linked_order_ids: [11385],
          linked_orders: [{ orderId: 11385, orderName: 'санузел' }],
        },
      ],
      projectRevisionRows: [
        {
          bazis_revision_id: 82,
          revision_no: 1,
          file_name: 'nova.xml',
          file_size: 2048,
          xml_sha256: 'sha-001',
          product_name: 'Шкаф Nova',
          product_price: 1200,
          summary_json: { panels: 1 },
          imported_at: '2026-07-10T12:44:00.000Z',
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    await expect(repository.getProject(14)).resolves.toMatchObject({
      bazisProjectId: 14,
      projectName: 'Квартира 1485',
      bazisOrderNo: '1457',
      revisions: [{ bazisRevisionId: 82 }],
    });

    const cardSql = database.queries
      .map((query) => normalizeSql(query.text))
      .find((sql) => sql.startsWith('SELECT bp.bazis_project_id'));
    expect(cardSql).toContain('rev.bazis_order_no');
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

describe('PgBazisRepository tree derived fields', () => {
  it('listAllTreeNodes selects notes and guarded edge/hole jsonb expressions', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.listAllTreeNodes(82);

    const treeQuery = database.queries.find((query) =>
      normalizeSql(query.text).includes('FROM bazis_nodes n WHERE n.revision_id = $1'),
    );
    expect(treeQuery).toBeDefined();
    expect(treeQuery!.text).toContain('n.notes');
    expect(treeQuery!.text).toContain("jsonb_typeof(n.raw_json->'СписокКромок1'->'Кромка') = 'array'");
    expect(treeQuery!.text).toContain("jsonb_typeof(n.raw_json->'СписокКромок4'->'Кромка') = 'array'");
    expect(treeQuery!.text).toContain("jsonb_typeof(n.raw_json->'Отверстия'->'Отверстие') = 'array'");
    expect(treeQuery!.text).toContain("jsonb_typeof(n.raw_json->'Отверстие') = 'array'");
    expect(treeQuery!.text).toContain('AS edge_count');
    expect(treeQuery!.text).toContain('AS has_drilling');
  });

  it('getTreeChildren selects the SAME derived fields (shared DTO, non-all tree path)', async () => {
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.getTreeChildren(82, null);

    const childrenQuery = database.queries.find((query) =>
      normalizeSql(query.text).includes('n.parent_node_id IS NOT DISTINCT FROM $2'),
    );
    expect(childrenQuery).toBeDefined();
    expect(childrenQuery!.text).toContain('n.notes');
    expect(childrenQuery!.text).toContain('AS edge_count');
    expect(childrenQuery!.text).toContain('AS has_drilling');
  });

  it('maps edge_count/has_drilling/notes into the DTO', async () => {
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
          designation: 'D-01',
          product_order_no: '1443',
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: 100,
          width_mm: 50,
          thickness_mm: 16,
          main_material_name: 'ЛДСП',
          notes: 'торец подклеить',
          edge_count: '3',
          has_drilling: true,
          children_count: 0,
          linked_orders: null,
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const nodes = await repository.listAllTreeNodes(82);

    expect(nodes[0]).toMatchObject({
      edgeCount: 3,
      hasDrilling: true,
      notes: 'торец подклеить',
    });
  });
});

describe('PgBazisRepository.setNodeNotes', () => {
  it('locks the node row, updates notes, writes audit + idempotent outbox in one tx', async () => {
    const database = createDatabase({
      setNodeNotesState: {
        existingRow: {
          bazis_node_id: 7213,
          notes: null,
          revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
        },
      },
    });
    const repository = new PgBazisRepository(database.service);

    const result = await repository.setNodeNotes({
      currentUser: currentUser('admin'),
      requestId: 'req-notes-1',
      nodeId: 7213,
      notes: 'торец подклеить',
    });

    expect(result).toEqual({ bazisNodeId: 7213, notes: 'торец подклеить' });
    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered[0]).toBe('SELECT set_session_user($1)');
    expect(ordered.some((sql) => sql.includes('FOR UPDATE OF n'))).toBe(true);
    expect(ordered).toContain('UPDATE bazis_nodes SET notes = $2 WHERE bazis_node_id = $1');
    const auditInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(auditInsert?.params).toContain('bazis.node_notes_changed');
    const related = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log_related_entity'))
      .map((query) => [query.params?.[1], query.params?.[2]]);
    expect(related).toEqual([
      ['project', 77],
      ['bazis_project', 41],
      ['bazis_revision', 82],
    ]);
    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(outbox?.params?.[0]).toBe('bazis.node_notes_changed');
    expect(outbox?.params?.[4]).toBe('bazis-node-notes-7213-req-notes-1');
  });

  it('missing requestId: outbox key is unique per change (audit-id based), not a shared constant', async () => {
    const database = createDatabase({
      setNodeNotesState: {
        existingRow: {
          bazis_node_id: 7213,
          notes: null,
          revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
        },
      },
    });
    const repository = new PgBazisRepository(database.service);

    await repository.setNodeNotes({
      currentUser: currentUser('admin'),
      requestId: undefined,
      nodeId: 7213,
      notes: 'без request id',
    });

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    const key = String(outbox?.params?.[4] ?? '');
    // Fallback-константа requestIdOrFallback давала бы один и тот же ключ на
    // каждое изменение узла → ON CONFLICT дропал бы последующие события.
    expect(key).toMatch(/^bazis-node-notes-7213-audit-/);
    expect(key).not.toBe('bazis-node-notes-7213-bazis-node-notes');
  });

  it('404s on missing node', async () => {
    const database = createDatabase({
      setNodeNotesState: { existingRow: null },
    });
    const repository = new PgBazisRepository(database.service);

    await expect(
      repository.setNodeNotes({
        currentUser: currentUser('admin'),
        requestId: 'r',
        nodeId: 999,
        notes: 'x',
      }),
    ).rejects.toBeInstanceOf(BazisNodeNotFoundError);
  });

  it('no-op short-circuit: same value writes no UPDATE/audit/outbox', async () => {
    const database = createDatabase({
      setNodeNotesState: {
        existingRow: {
          bazis_node_id: 7213,
          notes: 'как было',
          revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
        },
      },
    });
    const repository = new PgBazisRepository(database.service);

    const result = await repository.setNodeNotes({
      currentUser: currentUser('admin'),
      requestId: 'r2',
      nodeId: 7213,
      notes: 'как было',
    });

    expect(result).toEqual({ bazisNodeId: 7213, notes: 'как было' });
    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered.some((sql) => sql.startsWith('UPDATE bazis_nodes'))).toBe(false);
    expect(ordered.some((sql) => sql.startsWith('INSERT INTO audit_log'))).toBe(false);
    expect(ordered.some((sql) => sql.startsWith('INSERT INTO outbox_events'))).toBe(false);
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
          revision_bazis_order_no: '1457',
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
            product_name: 'Шкаф',
            product_order_no: '1443',
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
            product_name: 'Шкаф',
            product_order_no: '1443',
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
          basisProject: '1443',
          basisProduct: 'Шкаф',
          basisDesignation: 'D-01',
          basisData: '7/D-01/Фасад/левая створка',
          sheetMaterialTypeId: 501,
          filmId: 601,
          millingTypeId: 1,
          edgeTypeId: 1,
        });
        expect(details[1]).toMatchObject({
          clientKey: 'bazis-node-102',
          basisProject: '1443',
          basisProduct: 'Шкаф',
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
    const dowelingInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO doweling_orders'),
    );
    expect(dowelingInsert?.params).toEqual(['1457', 9001, 1, 2, 88, 2]);
    expect(normalizeSql(dowelingInsert?.text ?? '')).not.toContain('operator_id');
    expect(database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO order_doweling_links'),
    )?.params).toEqual([9001, 501]);
    expect(database.queries.some((query) => query.params?.[0] === 'doweling.created')).toBe(true);
  });

  it('requires a constructor before creating the ERP order', async () => {
    const create = vi.fn();
    const database = createDatabase({
      createOrderState: {
        revisionRow: { ...baseRevisionRow(), design_engineer_id: null, design_engineer_name: null },
      },
    });
    const repository = new PgBazisRepository(database.service, { create });

    await expect(repository.createOrderFromRevision(createOrderCommand())).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { field: 'designEngineerId' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy doweling production status is missing', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: baseRevisionRow(),
        draftNodeRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
        dowelingStatusDefaults: { payment_status_id: 1, production_status_id: null },
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async (command) => {
        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          {
            orderId: 9001,
            detailIdsByClientKey: new Map([['draft-detail-1', 7001]]),
          },
        );
        return buildOrderDto(9001, 'never');
      },
    });

    await expect(repository.createOrderFromDraft(createOrderFromDraftCommand({
      nodes: [{ clientKey: 'draft-detail-1', bazisNodeId: 101 }],
    }))).rejects.toMatchObject({
      statusCode: 500,
      code: 'BAZIS_DOWELING_DEFAULT_STATUS_MISSING',
    });
    expect(database.queries.some((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO doweling_orders'),
    )).toBe(false);
  });

  it('rejects an empty Bazis node set before reserving idempotency', async () => {
    const create = vi.fn();
    const database = createDatabase();
    const repository = new PgBazisRepository(database.service, { create });

    await expect(repository.createOrderFromDraft(createOrderFromDraftCommand({ nodes: [] })))
      .rejects.toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
        details: { errors: [{ field: 'nodes', message: 'Выберите хотя бы одну деталь Базис-проекта' }] },
      });
    expect(create).not.toHaveBeenCalled();
    expect(database.queries).toHaveLength(0);
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

  it('uses revision bazis order number when product order number is empty', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          revision_bazis_order_no: '1457',
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
            product_name: 'Шкаф',
            product_order_no: null,
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
        const details = (command.dto.details ?? []) as Array<Record<string, unknown>>;
        expect(details).toHaveLength(1);
        expect(details[0]).toMatchObject({
          basisProject: '1457',
          basisProduct: 'Шкаф',
        });

        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          { orderId: 9001, detailIdsByClientKey: new Map([['bazis-node-101', 7001]]) },
        );

        return buildOrderDto(9001, 'ERP order');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await repository.createOrderFromRevision(createOrderCommand());
  });

  it('falls back to bazis project name when both product and revision order numbers are empty', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          revision_bazis_order_no: null,
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
            product_name: 'Шкаф',
            product_order_no: null,
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
        const details = (command.dto.details ?? []) as Array<Record<string, unknown>>;
        expect(details).toHaveLength(1);
        expect(details[0]).toMatchObject({
          basisProject: 'Шкаф Nova',
          basisProduct: 'Шкаф',
        });

        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          { orderId: 9001, detailIdsByClientKey: new Map([['bazis-node-101', 7001]]) },
        );

        return buildOrderDto(9001, 'ERP order');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await repository.createOrderFromRevision(createOrderCommand());
  });

  it('keeps basisDesignation pinned to panel designation', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          revision_bazis_order_no: '1457',
          project_client_id: 5,
        },
        panelRows: [
          {
            bazis_node_id: 101,
            object_type: 'Панель',
            name: 'Фасад',
            position: '7',
            designation: 'PIN-77',
            cumulative_quantity: 2,
            length_mm: 1200,
            width_mm: 450,
            main_material_name: 'Laminate White',
            product_name: 'Шкаф',
            product_order_no: '1443',
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
        const details = (command.dto.details ?? []) as Array<Record<string, unknown>>;
        expect(details).toHaveLength(1);
        expect(details[0]).toMatchObject({
          basisProject: '1443',
          basisProduct: 'Шкаф',
          basisDesignation: 'PIN-77',
        });

        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          { orderId: 9001, detailIdsByClientKey: new Map([['bazis-node-101', 7001]]) },
        );

        return buildOrderDto(9001, 'ERP order');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await repository.createOrderFromRevision(createOrderCommand());
  });
});

describe('PgBazisRepository.createOrderFromDraft', () => {
  it('creates an order from a draft, rewrites projectId, strips nested idempotency, and maps nodes by explicit clientKey', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          revision_bazis_order_no: '1457',
          project_client_id: 5,
        },
        draftNodeRows: [
          { bazis_node_id: 101, object_type: 'Панель' },
          { bazis_node_id: 102, object_type: 'Панель' },
        ],
      },
    });
    const orderTransactions: Pick<OrderTransactionService, 'create'> = {
      create: async (command: Parameters<OrderTransactionService['create']>[0]) => {
        expect(command.dto.header).toMatchObject({
          projectId: 77,
          clientId: 5,
          orderName: 'ERP order draft',
          orderStatusId: 3,
        });
        expect(command.dto.idempotencyKey).toBeUndefined();
        expect(command.dto.details).toHaveLength(3);

        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          {
            orderId: 9001,
            detailIdsByClientKey: new Map([
              ['draft-detail-1', 7001],
              ['draft-detail-2', 7002],
              ['manual-detail-3', 7003],
            ]),
          },
        );

        return buildOrderDto(9001, 'ERP order draft');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    const result = await repository.createOrderFromDraft(createOrderFromDraftCommand());

    expect(result).toEqual({
      orderId: 9001,
      orderName: 'ERP order draft',
      detailsCreated: 3,
      mappedNodes: 2,
      requestId: 'req-create-order-draft',
      auditId: 'audit-1',
    });

    const mapInserts = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_node_order_detail_map'),
    );
    expect(mapInserts.map((query) => query.params)).toEqual([
      [101, 7001, 9001, 'created'],
      [102, 7002, 9001, 'created'],
    ]);
    expect(mapInserts).toHaveLength(2);

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(outbox?.params?.[4]).toBe('bazis-order-created-draft-9001');

    const auditInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log ('),
    );
    expect(auditInsert?.params?.[0]).toBe('bazis.order_created');
    expect(auditInsert?.params?.some((param) => String(param).includes('"source":"panels_draft"'))).toBe(true);
  });

  it('rejects when the draft order client does not match the bazis project client', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        createOrderState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
          },
        },
      }).service,
      { create: async () => buildOrderDto(1, 'never') },
    );

    await expect(
      repository.createOrderFromDraft(
        createOrderFromDraftCommand({
          order: createSaveOrderDto({ header: { clientId: 8 } }),
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: {
        errors: [{ field: 'clientId', message: 'Клиент заказа должен совпадать с клиентом проекта Базис' }],
      },
    });
  });

  it('pins header.projectId to the revision project id', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        draftNodeRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
      },
    });
    const orderTransactions: Pick<OrderTransactionService, 'create'> = {
      create: async (command) => {
        expect(command.dto.header.projectId).toBe(77);
        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          { orderId: 9001, detailIdsByClientKey: new Map([['draft-detail-1', 7001]]) },
        );
        return buildOrderDto(9001, 'ERP order draft');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await repository.createOrderFromDraft(
      createOrderFromDraftCommand({
        order: createSaveOrderDto({ header: { projectId: 999999 } }),
        nodes: [{ clientKey: 'draft-detail-1', bazisNodeId: 101 }],
      }),
    );
  });

  it('rejects nodes from another revision with VALIDATION_ERROR and marks the key failed', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        draftNodeRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(
      repository.createOrderFromDraft(
        createOrderFromDraftCommand({
          nodes: [
            { clientKey: 'draft-detail-1', bazisNodeId: 101 },
            { clientKey: 'draft-detail-2', bazisNodeId: 999 },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { errors: [{ field: 'nodes', message: 'Указанные узлы должны быть панелями из выбранной ревизии' }] },
    });
    expect(normalizedSql(database.queries)).toContain("UPDATE command_idempotency_keys SET status = 'failed'");
  });

  it('rejects non-panel nodes with VALIDATION_ERROR', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        createOrderState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
          },
          draftNodeRows: [{ bazis_node_id: 101, object_type: 'Шкаф' }],
        },
      }).service,
      { create: async () => buildOrderDto(1, 'never') },
    );

    await expect(
      repository.createOrderFromDraft(
        createOrderFromDraftCommand({
          nodes: [{ clientKey: 'draft-detail-1', bazisNodeId: 101 }],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { errors: [{ field: 'nodes', message: 'Указанные узлы должны быть панелями из выбранной ревизии' }] },
    });
  });

  it('rejects node mappings whose clientKey is absent from order details', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(
      repository.createOrderFromDraft(
        createOrderFromDraftCommand({
          nodes: [{ clientKey: 'missing-detail', bazisNodeId: 101 }],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: {
        errors: [{ field: 'nodes', message: 'Каждый clientKey из nodes должен присутствовать в order.details' }],
      },
    });
    expect(normalizedSql(database.queries)).toContain("UPDATE command_idempotency_keys SET status = 'failed'");
  });

  it('rejects duplicate bazisNodeId in nodes before touching bazis_nodes', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(
      repository.createOrderFromDraft(
        createOrderFromDraftCommand({
          nodes: [
            { clientKey: 'draft-detail-1', bazisNodeId: 101 },
            { clientKey: 'draft-detail-2', bazisNodeId: 101 },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { errors: [{ field: 'nodes', message: 'Повторяющиеся bazisNodeId в nodes недопустимы' }] },
    });
    expect(
      database.queries.some((query) => normalizeSql(query.text).startsWith('SELECT bazis_node_id, object_type FROM bazis_nodes')),
    ).toBe(false);
  });

  it('replays a completed create-from-draft idempotency response without creating another order', async () => {
    const response = {
      orderId: 7001,
      orderName: 'Existing draft order',
      detailsCreated: 3,
      mappedNodes: 2,
      requestId: 'req-replay-draft',
      auditId: 'audit-draft-existing',
    };
    const database = createDatabase({
      createOrderState: {
        idempotencyConflict: true,
        existingIdempotencyRow: {
          request_hash: hashCreateOrderFromDraftRequestShape(createOrderFromDraftCommand()),
          response_json: response,
          status: 'completed',
          created_at: isoMinutesAgo(15),
        },
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => buildOrderDto(1, 'never'),
    });

    await expect(repository.createOrderFromDraft(createOrderFromDraftCommand())).resolves.toEqual(response);
    expect(normalizedSql(database.queries)).not.toContain('INSERT INTO bazis_node_order_detail_map');
  });

  it('strips nested order.idempotencyKey before delegating to orderTransactions.create', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        draftNodeRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
      },
    });
    const orderTransactions: Pick<OrderTransactionService, 'create'> = {
      create: async (command) => {
        expect(command.dto.idempotencyKey).toBeUndefined();
        await command.postPersistHook?.(
          { getTransactionClient: () => database.tx },
          { orderId: 9001, detailIdsByClientKey: new Map([['draft-detail-1', 7001]]) },
        );
        return buildOrderDto(9001, 'ERP order draft');
      },
    };
    const repository = new PgBazisRepository(database.service, orderTransactions);

    await repository.createOrderFromDraft(
      createOrderFromDraftCommand({
        order: createSaveOrderDto({ idempotencyKey: 'nested-idem-key' }),
        nodes: [{ clientKey: 'draft-detail-1', bazisNodeId: 101 }],
      }),
    );
  });

  it('marks the bazis idempotency key failed and propagates ORDER_NAME_DUPLICATE', async () => {
    const database = createDatabase({
      createOrderState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
        },
        draftNodeRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
      },
    });
    const repository = new PgBazisRepository(database.service, {
      create: async () => {
        throw new ApiError(409, 'ORDER_NAME_DUPLICATE', 'duplicate');
      },
    });

    await expect(
      repository.createOrderFromDraft(createOrderFromDraftCommand({
        nodes: [{ clientKey: 'draft-detail-1', bazisNodeId: 101 }],
      })),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_NAME_DUPLICATE',
    });
    expect(normalizedSql(database.queries)).toContain("UPDATE command_idempotency_keys SET status = 'failed'");
  });
});

describe('PgBazisRepository.addToOrder', () => {
  it('rejects duplicate bazisNodeId across adds/replaces/skips before idempotency', async () => {
    const repository = new PgBazisRepository(createDatabase().service, { update: vi.fn() });

    await expect(
      repository.addToOrder(
        createAddToOrderCommand({
          adds: [101],
          replaces: [{ bazisNodeId: 101, orderDetailId: 7002 }],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects duplicate orderDetailId in replaces', async () => {
    const repository = new PgBazisRepository(createDatabase().service, { update: vi.fn() });

    await expect(
      repository.addToOrder(
        createAddToOrderCommand({
          adds: [],
          replaces: [
            { bazisNodeId: 101, orderDetailId: 7002 },
            { bazisNodeId: 102, orderDetailId: 7002 },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { errors: [{ field: 'replaces', message: 'Повторяющиеся orderDetailId в replaces недопустимы' }] },
    });
  });

  it('rejects empty adds+replaces payload', async () => {
    const repository = new PgBazisRepository(createDatabase().service, { update: vi.fn() });

    await expect(
      repository.addToOrder(
        createAddToOrderCommand({
          adds: [],
          replaces: [],
          skips: [],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects target orders from another client with 422', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 99 },
      },
    });
    const repository = new PgBazisRepository(database.service, { update: vi.fn() });

    await expect(repository.addToOrder(createAddToOrderCommand())).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { errors: [{ field: 'orderId', message: 'Заказ должен существовать и принадлежать клиенту проекта Базис' }] },
    });
  });

  it('rejects deleted or missing target orders with 422', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: null,
      },
    });
    const repository = new PgBazisRepository(database.service, { update: vi.fn() });

    await expect(repository.addToOrder(createAddToOrderCommand())).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { errors: [{ field: 'orderId', message: 'Заказ должен существовать и принадлежать клиенту проекта Базис' }] },
    });
  });

  it('rejects non-panel nodes or nodes from another revision with 422', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 101, object_type: 'Шкаф' }],
      },
    });
    const repository = new PgBazisRepository(database.service, { update: vi.fn() });
    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP order current'));

    await expect(repository.addToOrder(createAddToOrderCommand())).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { errors: [{ field: 'adds', message: 'Указанные узлы должны быть панелями из выбранной ревизии' }] },
    });
  });

  it('rejects unmapped panels with 422', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
        panelRows: [panelRow101()],
        mappingRows: [],
      },
    });
    const repository = new PgBazisRepository(database.service, { update: vi.fn() });

    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP order current'));

    await expect(repository.addToOrder(createAddToOrderCommand())).rejects.toMatchObject({
      statusCode: 422,
      code: 'BAZIS_UNMAPPED_MATERIALS',
    });
  });

  it('adds new details through update, preserves full header/version, writes map upsert, links, audit bridge, and outbox', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
        panelRows: [panelRow101()],
        mappingRows: sheetAndFilmMappings(),
        duplicateRows: [],
      },
    });
    const currentOrder = buildDetailedOrderDto(9001, 'ERP order current');
    getOrderByIdMock.mockResolvedValue(currentOrder);
    let dtoPassed: ReturnType<typeof orderDtoToSaveDto> | null = null;
    const update = vi.fn(async (command: Parameters<NonNullable<OrderTransactionService['update']>>[0]) => {
      dtoPassed = command.dto;
      await command.prePersistHook?.(
        { getTransactionClient: () => database.tx } as never,
        { orderId: 9001, orderName: 'ERP order current', version: currentOrder.version, createdByUserId: '1', managerUserId: '1' },
      );
      await command.postPersistHook?.(
        { getTransactionClient: () => database.tx } as never,
        { orderId: 9001, detailIdsByClientKey: new Map([['bazis-node-101', 8001]]) },
      );
      return currentOrder;
    });
    const repository = new PgBazisRepository(database.service, { update });

    const result = await repository.addToOrder(createAddToOrderCommand({ adds: [101], replaces: [], skips: [] }));

    expect(result).toEqual({
      orderId: 9001,
      detailsAdded: 1,
      detailsReplaced: 0,
      requestId: 'req-add-to-order',
    });
    expect(getOrderByIdMock).toHaveBeenCalledWith({ currentUser: currentUser(), orderId: 9001 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(dtoPassed?.header).toEqual(orderDtoToSaveDto(currentOrder).header);
    expect(dtoPassed?.version).toBe(currentOrder.version);
    expect(dtoPassed?.payments).toEqual(orderDtoToSaveDto(currentOrder).payments);
    expect(dtoPassed?.workshops).toEqual(orderDtoToSaveDto(currentOrder).workshops);
    expect(dtoPassed?.requirements).toEqual(orderDtoToSaveDto(currentOrder).requirements);
    expect(dtoPassed?.dowelingLinks).toEqual(orderDtoToSaveDto(currentOrder).dowelingLinks);
    expect(dtoPassed?.details).toHaveLength(currentOrder.details.length + 1);
    expect(dtoPassed?.details.at(-1)).toMatchObject({
      clientKey: 'bazis-node-101',
      detailName: 'Фасад/левая створка',
      height: 1200,
      width: 450,
      quantity: 2,
      sheetMaterialTypeId: 501,
      filmId: 601,
      basisProject: '1443',
      basisProduct: 'Шкаф',
      basisDesignation: 'D-01',
      basisData: '7/D-01/Фасад/левая створка',
      materialId: null,
    });
    expect(normalizedSql(database.queries)).toContain(
      "INSERT INTO bazis_node_order_detail_map (node_id, order_detail_id, order_id, mapping_kind) VALUES ($1, $2, $3, 'created') ON CONFLICT (node_id, order_id) DO UPDATE SET order_detail_id = EXCLUDED.order_detail_id, mapping_kind = 'created'",
    );
    const mapInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_node_order_detail_map'),
    );
    expect(mapInsert?.params).toEqual([101, 8001, 9001]);
    const bridgePairs = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log_related_entity'))
      .map((query) => [query.params?.[1], query.params?.[2]]);
    expect(bridgePairs).toEqual([
      ['project', 77],
      ['bazis_project', 41],
      ['bazis_revision', 82],
    ]);
    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(outbox?.params?.[4]).toBe('bazis-order-details-added-9001-add-to-order-001');
    expect(JSON.parse(String(outbox?.params?.[3]))).toMatchObject({
      orderId: 9001,
      clientId: 5,
      bazisProjectId: 41,
      revisionId: 82,
      projectId: 77,
      addedNodeIds: [101],
      replacedPairs: [],
    });
  });

  it('replaces only the whitelist fields and rewrites node mapping', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 102, object_type: 'Панель' }],
        panelRows: [panelRow102()],
        mappingRows: sheetOnlyMapping(502),
        duplicateRows: [{ bazis_node_id: 102, order_detail_id: 7002, matched_by: 'basis_fields' }],
      },
    });
    const currentOrder = buildDetailedOrderDto(9001, 'ERP order current');
    // Critic code-R1 #1: висящий legacy material_id у заменяемой детали не должен
    // доехать до валидатора (Variant B: material_id обязан быть null).
    currentOrder.details = currentOrder.details.map((detail) =>
      detail.id === 7002 ? { ...detail, materialId: 5 } : detail,
    );
    getOrderByIdMock.mockResolvedValue(currentOrder);
    let dtoPassed: ReturnType<typeof orderDtoToSaveDto> | null = null;
    const update = vi.fn(async (command: Parameters<NonNullable<OrderTransactionService['update']>>[0]) => {
      dtoPassed = command.dto;
      await command.prePersistHook?.(
        { getTransactionClient: () => database.tx } as never,
        { orderId: 9001, orderName: 'ERP order current', version: currentOrder.version, createdByUserId: '1', managerUserId: '1' },
      );
      await command.postPersistHook?.(
        { getTransactionClient: () => database.tx } as never,
        { orderId: 9001, detailIdsByClientKey: new Map() },
      );
      return currentOrder;
    });
    const repository = new PgBazisRepository(database.service, { update });

    const result = await repository.addToOrder(
      createAddToOrderCommand({
        adds: [],
        replaces: [{ bazisNodeId: 102, orderDetailId: 7002 }],
        skips: [],
      }),
    );

    expect(result).toEqual({
      orderId: 9001,
      detailsAdded: 0,
      detailsReplaced: 1,
      requestId: 'req-add-to-order',
    });
    const replaced = dtoPassed?.details.find((detail) => detail.id === 7002);
    expect(replaced).toMatchObject({
      id: 7002,
      detailName: 'Полка',
      height: 800,
      width: 300,
      quantity: 1,
      sheetMaterialTypeId: 502,
      filmId: null,
      basisProject: '1443',
      basisProduct: 'Шкаф',
      basisDesignation: 'S-02',
      basisData: '8/S-02/Полка',
      millingTypeId: 9,
      edgeTypeId: 8,
      priority: 17,
      note: 'keep me',
      linkCadFile: '/cad/preserved.dxf',
    });
    expect(replaced?.materialId).toBeNull();
    const deletes = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('DELETE FROM bazis_node_order_detail_map'),
    );
    expect(deletes.map((query) => query.params)).toEqual([[9001, 7002]]);
    const inserts = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO bazis_node_order_detail_map'),
    );
    expect(inserts.map((query) => query.params)).toEqual([[102, 7002, 9001]]);
  });

  it('rejects when a replace pair is absent in the fresh duplicate set', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 102, object_type: 'Панель' }],
        panelRows: [panelRow102()],
        mappingRows: sheetOnlyMapping(502),
        duplicateRows: [],
      },
    });
    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP order current'));
    const update = vi.fn(async (command: Parameters<NonNullable<OrderTransactionService['update']>>[0]) => {
      await command.prePersistHook?.(
        { getTransactionClient: () => database.tx } as never,
        { orderId: 9001, orderName: 'ERP order current', version: 7, createdByUserId: '1', managerUserId: '1' },
      );
      return buildOrderDto(9001, 'never');
    });
    const repository = new PgBazisRepository(database.service, { update });

    await expect(
      repository.addToOrder(
        createAddToOrderCommand({
          adds: [],
          replaces: [{ bazisNodeId: 102, orderDetailId: 7002 }],
          skips: [],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'BAZIS_ADD_TO_ORDER_CONFLICT',
      details: { missingPairs: [{ bazisNodeId: 102, orderDetailId: 7002 }] },
    });
  });

  it('rejects adds that now duplicate existing details', async () => {
    const database = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
        panelRows: [panelRow101()],
        mappingRows: sheetAndFilmMappings(),
        duplicateRows: [{ bazis_node_id: 101, order_detail_id: 7001, matched_by: 'node_map' }],
      },
    });
    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP order current'));
    const update = vi.fn(async (command: Parameters<NonNullable<OrderTransactionService['update']>>[0]) => {
      await command.prePersistHook?.(
        { getTransactionClient: () => database.tx } as never,
        { orderId: 9001, orderName: 'ERP order current', version: 7, createdByUserId: '1', managerUserId: '1' },
      );
      return buildOrderDto(9001, 'never');
    });
    const repository = new PgBazisRepository(database.service, { update });

    await expect(repository.addToOrder(createAddToOrderCommand({ adds: [101], replaces: [], skips: [] }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'BAZIS_ADD_TO_ORDER_CONFLICT',
      details: { addNodeIdsWithDuplicates: [101] },
    });
  });

  it('rejects ambiguous duplicates in replaces but allows the same ambiguity in skips', async () => {
    const conflictDatabase = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 101, object_type: 'Панель' }],
        panelRows: [panelRow101()],
        mappingRows: sheetAndFilmMappings(),
        duplicateRows: [
          { bazis_node_id: 101, order_detail_id: 7001, matched_by: 'basis_fields' },
          { bazis_node_id: 102, order_detail_id: 7001, matched_by: 'basis_fields' },
        ],
      },
    });
    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP order current'));
    const conflictRepo = new PgBazisRepository(conflictDatabase.service, {
      update: async (command) => {
        await command.prePersistHook?.(
          { getTransactionClient: () => conflictDatabase.tx } as never,
          { orderId: 9001, orderName: 'ERP order current', version: 7, createdByUserId: '1', managerUserId: '1' },
        );
        return buildOrderDto(9001, 'never');
      },
    });

    await expect(
      conflictRepo.addToOrder(
        createAddToOrderCommand({
          adds: [],
          replaces: [{ bazisNodeId: 101, orderDetailId: 7001 }],
          skips: [{ bazisNodeId: 102, orderDetailId: 7001 }],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'BAZIS_ADD_TO_ORDER_CONFLICT',
    });

    const okDatabase = createDatabase({
      addToOrderState: {
        revisionRow: baseRevisionRow(),
        targetOrderRow: { order_id: 9001, client_id: 5 },
        nodeLookupRows: [{ bazis_node_id: 104, object_type: 'Панель' }],
        panelRows: [panelRow104()],
        mappingRows: sheetOnlyMapping(504),
        duplicateRows: [
          { bazis_node_id: 101, order_detail_id: 7001, matched_by: 'basis_fields' },
          { bazis_node_id: 102, order_detail_id: 7001, matched_by: 'basis_fields' },
        ],
      },
    });
    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP order current'));
    const okRepo = new PgBazisRepository(okDatabase.service, {
      update: async (command) => {
        await command.prePersistHook?.(
          { getTransactionClient: () => okDatabase.tx } as never,
          { orderId: 9001, orderName: 'ERP order current', version: 7, createdByUserId: '1', managerUserId: '1' },
        );
        await command.postPersistHook?.(
          { getTransactionClient: () => okDatabase.tx } as never,
          { orderId: 9001, detailIdsByClientKey: new Map([['bazis-node-104', 8004]]) },
        );
        return buildOrderDto(9001, 'ERP order current');
      },
    });

    await expect(
      okRepo.addToOrder(
        createAddToOrderCommand({
          adds: [104],
          replaces: [],
          skips: [
            { bazisNodeId: 101, orderDetailId: 7001 },
            { bazisNodeId: 102, orderDetailId: 7001 },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      orderId: 9001,
      detailsAdded: 1,
      detailsReplaced: 0,
    });
  });

  it('replays a completed add-to-order idempotency response without updating the order', async () => {
    const response = {
      orderId: 9001,
      detailsAdded: 2,
      detailsReplaced: 1,
      requestId: 'req-add-replay',
    };
    const database = createDatabase({
      addToOrderState: {
        idempotencyConflict: true,
        existingIdempotencyRow: {
          request_hash: hashAddToOrderRequestShape(createAddToOrderCommand()),
          response_json: response,
          status: 'completed',
          created_at: isoMinutesAgo(5),
        },
      },
    });
    const update = vi.fn();
    const repository = new PgBazisRepository(database.service, { update });

    await expect(repository.addToOrder(createAddToOrderCommand())).resolves.toEqual(response);
    expect(update).not.toHaveBeenCalled();
    expect(getOrderByIdMock).not.toHaveBeenCalled();
  });
});

describe('PgBazisRepository.buildOrderDraft', () => {
  it('returns draft details with client metadata and clientKey', async () => {
    const database = createDatabase({
      orderDraftState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          revision_bazis_order_no: '1457',
          project_client_id: 5,
          client_name: 'ООО Клиент',
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
            product_name: 'Шкаф',
            product_order_no: '1443',
            raw_json: {
              ОблицовкаПласти1: { Пласть: [{ Наименование: 'Snow Film' }] },
              ОблицовкаПласти2: { Пласть: [{ Наименование: 'Snow Film' }] },
            },
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
        ],
      },
    });
    const repository = new PgBazisRepository(database.service);

    const result = await repository.buildOrderDraft({
      currentUser: currentUser(),
      revisionId: 82,
      selectedNodeIds: [101],
    });

    expect(result).toMatchObject({
      revisionId: 82,
      projectId: 77,
      clientId: 5,
      clientName: 'ООО Клиент',
      bazisProjectName: 'Шкаф Nova',
      bazisOrderNo: '1457',
      duplicates: [],
    });
    expect(result.details).toEqual([
      {
        bazisNodeId: 101,
        clientKey: 'bazis-node-101',
        detailName: 'Фасад/левая створка',
        height: 1200,
        width: 450,
        quantity: 2,
        sheetMaterialTypeId: 501,
        filmId: 601,
        millingTypeId: 1,
        edgeTypeId: 1,
        priority: 100,
        basisProject: '1443',
        basisProduct: 'Шкаф',
        basisDesignation: 'D-01',
        basisData: '7/D-01/Фасад/левая створка',
        doweling: false,
      },
    ]);
  });

  it('prioritizes user properties for film and milling reference ids', async () => {
    const database = createDatabase({
      orderDraftState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          revision_bazis_order_no: '1457',
          project_client_id: 5,
          client_name: 'ООО Клиент',
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
            product_name: 'Шкаф',
            product_order_no: '1443',
            raw_json: {
              ОблицовкаПласти1: { Пласть: [{ Наименование: 'Snow Film' }] },
              ПользовательскиеСвойства: {
                Свойство: [
                  { Имя: 'Фрезеровка', Значение: 'Модерн' },
                  { Имя: 'Плёнка', Значение: 'Белый глянец' },
                ],
              },
            },
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
            name: 'белый глянец',
            target_kind: 'film',
            sheet_material_type_id: null,
            film_id: 777,
            edge_type_id: null,
          },
        ],
        referenceRows: [
          { reference_kind: 'milling', reference_id: 42, name: 'модерн' },
          { reference_kind: 'film', reference_id: 778, name: 'белый глянец' },
        ],
      },
    });
    const repository = new PgBazisRepository(database.service);

    const result = await repository.buildOrderDraft({
      currentUser: currentUser(),
      revisionId: 82,
      selectedNodeIds: [101],
    });

    expect(result.details[0]).toMatchObject({
      filmId: 777,
      millingTypeId: 42,
    });
    const mappingQuery = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('SELECT source_kind, lower(bazis_name) AS name'),
    );
    expect(mappingQuery?.params).toEqual([
      ['sheet', 'film'],
      ['laminate white', 'белый глянец'],
    ]);
    const referenceQuery = database.queries.find((query) =>
      normalizeSql(query.text).startsWith("SELECT 'milling'::text AS reference_kind"),
    );
    expect(referenceQuery?.params).toEqual([['модерн'], ['белый глянец']]);
  });

  it('throws BazisRevisionNotFoundError when the revision is missing', async () => {
    const repository = new PgBazisRepository(createDatabase().service);

    await expect(
      repository.buildOrderDraft({
        currentUser: currentUser(),
        revisionId: 999,
        selectedNodeIds: [101],
      }),
    ).rejects.toBeInstanceOf(BazisRevisionNotFoundError);
  });

  it('throws BazisNoPanelsSelectedError when the selection expands to zero panels', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        orderDraftState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
            client_name: 'ООО Клиент',
          },
          panelRows: [],
        },
      }).service,
    );

    await expect(
      repository.buildOrderDraft({
        currentUser: currentUser(),
        revisionId: 82,
        selectedNodeIds: [101],
      }),
    ).rejects.toBeInstanceOf(BazisNoPanelsSelectedError);
  });

  it('throws unmapped materials before producing a draft', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        orderDraftState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
            client_name: 'ООО Клиент',
          },
          panelRows: [
            {
              bazis_node_id: 101,
              object_type: 'Панель',
              name: 'Фасад',
              position: '7',
              designation: 'D-01',
              cumulative_quantity: 1,
              length_mm: 1200,
              width_mm: 450,
              main_material_name: 'Unknown Sheet',
              raw_json: {},
            },
          ],
          mappingRows: [],
        },
      }).service,
    );

    await expect(
      repository.buildOrderDraft({
        currentUser: currentUser(),
        revisionId: 82,
        selectedNodeIds: [101],
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'BAZIS_UNMAPPED_MATERIALS',
      details: { unmappedMaterials: ['Unknown Sheet'] },
    });
  });

  it('rejects targetOrderId from another client with VALIDATION_ERROR', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        orderDraftState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
            client_name: 'ООО Клиент',
          },
          panelRows: [
            {
              bazis_node_id: 101,
              object_type: 'Панель',
              name: 'Фасад',
              position: '7',
              designation: 'D-01',
              cumulative_quantity: 1,
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
          targetOrderRow: { order_id: 9001, client_id: 8 },
        },
      }).service,
    );

    await expect(
      repository.buildOrderDraft({
        currentUser: currentUser(),
        revisionId: 82,
        selectedNodeIds: [101],
        targetOrderId: 9001,
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: {
        errors: [{ field: 'targetOrderId', message: 'Целевой заказ должен принадлежать клиенту проекта Базис' }],
      },
    });
  });

  it('returns node_map duplicates for the same node already linked to the target order', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        orderDraftState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
            client_name: 'ООО Клиент',
          },
          panelRows: [
            {
              bazis_node_id: 101,
              object_type: 'Панель',
              name: 'Фасад',
              position: '7',
              designation: 'D-01',
              cumulative_quantity: 1,
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
          targetOrderRow: { order_id: 9001, client_id: 5 },
          duplicateRows: [{ bazis_node_id: 101, order_detail_id: 7001, matched_by: 'node_map' }],
        },
      }).service,
    );

    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP target order'));
    const result = await repository.buildOrderDraft({
      currentUser: currentUser(),
      revisionId: 82,
      selectedNodeIds: [101],
      targetOrderId: 9001,
    });

    expect(result.duplicates).toEqual([
      { bazisNodeId: 101, orderDetailId: 7001, matchedBy: 'node_map' },
    ]);
  });

  it('returns basis_fields duplicates across revisions of the same bazis project', async () => {
    const database = createDatabase({
      orderDraftState: {
        revisionRow: {
          bazis_revision_id: 82,
          bazis_project_id: 41,
          project_id: 77,
          bazis_project_name: 'Шкаф Nova',
          project_client_id: 5,
          client_name: 'ООО Клиент',
        },
        panelRows: [
          {
            bazis_node_id: 101,
            object_type: 'Панель',
            name: 'Фасад',
            position: '7',
            designation: 'D-01',
            cumulative_quantity: 1,
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
        targetOrderRow: { order_id: 9001, client_id: 5 },
        duplicateRows: [{ bazis_node_id: 101, order_detail_id: 7002, matched_by: 'basis_fields' }],
      },
    });
    const repository = new PgBazisRepository(database.service);

    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP target order'));
    const result = await repository.buildOrderDraft({
      currentUser: currentUser(),
      revisionId: 82,
      selectedNodeIds: [101],
      targetOrderId: 9001,
    });

    expect(result.duplicates).toEqual([
      { bazisNodeId: 101, orderDetailId: 7002, matchedBy: 'basis_fields' },
    ]);
    const duplicateSql = database.queries
      .map((query) => normalizeSql(query.text))
      .find((sql) => sql.startsWith('WITH sel AS ('));
    expect(duplicateSql).toContain('r.bazis_project_id = $1');
    expect(duplicateSql).toContain('o.revision_id');
  });

  it('does not match basis_fields when the selected node position is empty', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        orderDraftState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
            client_name: 'ООО Клиент',
          },
          panelRows: [
            {
              bazis_node_id: 101,
              object_type: 'Панель',
              name: 'Фасад',
              position: '',
              designation: 'D-01',
              cumulative_quantity: 1,
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
          targetOrderRow: { order_id: 9001, client_id: 5 },
          duplicateRows: [],
        },
      }).service,
    );

    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP target order'));
    const result = await repository.buildOrderDraft({
      currentUser: currentUser(),
      revisionId: 82,
      selectedNodeIds: [101],
      targetOrderId: 9001,
    });

    expect(result.duplicates).toEqual([]);
  });

  it('ignores map rows without order_detail_id when computing duplicates', async () => {
    const repository = new PgBazisRepository(
      createDatabase({
        orderDraftState: {
          revisionRow: {
            bazis_revision_id: 82,
            bazis_project_id: 41,
            project_id: 77,
            bazis_project_name: 'Шкаф Nova',
            project_client_id: 5,
            client_name: 'ООО Клиент',
          },
          panelRows: [
            {
              bazis_node_id: 101,
              object_type: 'Панель',
              name: 'Фасад',
              position: '7',
              designation: 'D-01',
              cumulative_quantity: 1,
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
          targetOrderRow: { order_id: 9001, client_id: 5 },
          duplicateRows: [],
        },
      }).service,
    );

    getOrderByIdMock.mockResolvedValue(buildDetailedOrderDto(9001, 'ERP target order'));
    const result = await repository.buildOrderDraft({
      currentUser: currentUser(),
      revisionId: 82,
      selectedNodeIds: [101],
      targetOrderId: 9001,
    });

    expect(result.duplicates).toEqual([]);
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
          order_delete_flag: true,
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
    expect(sql).toContain('delete_flag');
    // счётчик деталей — по order_detail_id, НЕ по mapping_kind (см. семантику выше)
    expect(sql).toContain('FILTER (WHERE map.order_detail_id IS NOT NULL)');
    // скоуп агрегата границей ревизии — пин против cross-revision утечки счётчиков
    expect(sql).toContain('JOIN bazis_nodes n ON n.bazis_node_id = map.node_id');
    expect(sql).toContain('WHERE n.revision_id = $1');
    expect(orders).toEqual([{
      orderId: 9001, orderName: 'Тест-заказ 1', orderDeleted: true, createdAt: '2026-07-08 10:00:00+00',
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

describe('PgBazisRepository.listProjects', () => {
  it('returns linked orders with names (id + order_name) for the projects list', async () => {
    const database = createDatabase({
      projectListRows: [
        {
          bazis_project_id: 14,
          project_id: 10,
          project_name: 'Квартира 1485',
          name: 'санузел + шкаф',
          revisions_count: 1,
          last_revision_no: 1,
          last_imported_at: '2026-07-10T12:44:00.000Z',
          bazis_order_no: null,
          linked_order_ids: [11385],
          linked_orders: [{ orderId: 11385, orderName: 'санузел' }],
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const projects = await repository.listProjects({});

    expect(projects[0].linkedOrders).toEqual([{ orderId: 11385, orderName: 'санузел' }]);
    expect(projects[0].linkedOrderIds).toEqual([11385]);
    expect(projects[0].projectName).toBe('Квартира 1485');

    const listSql = database.queries
      .map((query) => normalizeSql(query.text))
      .find((sql) => sql.startsWith('SELECT bp.bazis_project_id'));
    expect(listSql).toContain('order_name');
    expect(listSql).toContain('delete_flag');
    expect(listSql).toContain('orderDeleted');
    expect(listSql).toContain('JOIN orders');
    expect(listSql).toContain('JOIN projects erp_project');
  });

  it('returns bazisOrderNo from the latest revision column for list items', async () => {
    const database = createDatabase({
      projectListRows: [
        {
          bazis_project_id: 14,
          project_id: 10,
          project_name: 'Квартира 1485',
          name: 'санузел + шкаф',
          revisions_count: 1,
          last_revision_no: 1,
          last_imported_at: '2026-07-10T12:44:00.000Z',
          bazis_order_no: '1457',
          linked_order_ids: [11385],
          linked_orders: [{ orderId: 11385, orderName: 'санузел' }],
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const projects = await repository.listProjects({});

    expect(projects[0]).toMatchObject({
      bazisProjectId: 14,
      bazisOrderNo: '1457',
    });
  });

  it('falls back to the first root raw_json order number when the revision column is null', async () => {
    const database = createDatabase({
      projectListRows: [
        {
          bazis_project_id: 14,
          project_id: 10,
          project_name: 'Квартира 1485',
          name: 'санузел + шкаф',
          revisions_count: 1,
          last_revision_no: 1,
          last_imported_at: '2026-07-10T12:44:00.000Z',
          bazis_order_no: '1443',
          linked_order_ids: [],
          linked_orders: [],
        },
      ],
      projectRevisionRows: [
        {
          bazis_revision_id: 82,
          revision_no: 1,
          file_name: 'nova.xml',
          file_size: 2048,
          xml_sha256: 'sha-001',
          product_name: 'Шкаф Nova',
          product_price: 1200,
          summary_json: { panels: 1 },
          imported_at: '2026-07-10T12:44:00.000Z',
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const [listItem, card] = await Promise.all([repository.listProjects({}), repository.getProject(14)]);

    expect(listItem[0]?.bazisOrderNo).toBe('1443');
    expect(card.bazisOrderNo).toBe('1443');

    const projectSql = database.queries
      .map((query) => normalizeSql(query.text))
      .filter((sql) => sql.startsWith('SELECT bp.bazis_project_id'));
    expect(projectSql).toHaveLength(2);
    for (const sql of projectSql) {
      expect(sql).toContain("NULLIF(trim(n.raw_json->>'Заказ'), '')");
      expect(sql).toContain('n.revision_id = rev.bazis_revision_id');
    }
  });
});

describe('PgBazisRepository tree order provenance', () => {
  it('returns panel designation and root productOrderNo on tree nodes', async () => {
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
          designation: 'D-01',
          product_order_no: '1443',
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: 100,
          width_mm: 50,
          thickness_mm: 16,
          main_material_name: 'ЛДСП',
          user_properties: {
            Свойство: [
              { Имя: 'Фрезировка', Значение: 'Модерн' },
              { Имя: 'Плёнка', Значение: 'Белый глянец' },
              { Имя: 'Краска (обр)', Значение: 'RAL 9003' },
            ],
          },
          legacy_user_properties: null,
          children_count: 0,
          linked_orders: null,
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    await expect(repository.getTreeChildren(5, null)).resolves.toMatchObject([
      {
        bazisNodeId: 101,
        designation: 'D-01',
        productOrderNo: '1443',
        millingName: 'Модерн',
        filmName: 'Белый глянец',
        paintName: 'RAL 9003',
      },
    ]);

    const treeSql = database.queries
      .map((query) => normalizeSql(query.text))
      .find((sql) => sql.startsWith('SELECT n.bazis_node_id, n.parent_node_id'));
    expect(treeSql).toContain('n.designation');
    expect(treeSql).toContain("CASE WHEN n.parent_node_id IS NULL THEN NULLIF(trim(n.raw_json->>'Заказ'), '') ELSE NULL END AS product_order_no");
    expect(treeSql).toContain("n.raw_json->'ПользовательскиеСвойства' AS user_properties");
    expect(treeSql).toContain("n.raw_json->'Свойство' AS legacy_user_properties");
  });

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
          designation: null,
          product_order_no: null,
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: 100,
          width_mm: 50,
          thickness_mm: 16,
          main_material_name: 'ЛДСП',
          children_count: 0,
          linked_orders: [
            { orderId: 11385, orderName: 'санузел' },
            { orderId: 11390, orderName: 'шкаф' },
          ],
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
          designation: null,
          product_order_no: null,
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: null,
          width_mm: null,
          thickness_mm: null,
          main_material_name: null,
          children_count: 3,
          linked_orders: null,
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const nodes = await repository.getTreeChildren(5, null);

    // Пользователи мыслят названиями: узел несёт заказы С ИМЕНАМИ,
    // orderIds остаётся производным (rollout-совместимость).
    expect(nodes[0].orders).toEqual([
      { orderId: 11385, orderName: 'санузел' },
      { orderId: 11390, orderName: 'шкаф' },
    ]);
    expect(nodes[0].orderIds).toEqual([11385, 11390]);
    expect(nodes[1].orders).toEqual([]);
    expect(nodes[1].orderIds).toEqual([]);

    // Агрегат считает только реально созданные детали (order_detail_id NOT NULL),
    // а не любые map-строки (mapping_kind='ignored' не «добавлен в заказ»).
    const treeSql = database.queries
      .map((query) => normalizeSql(query.text))
      .find((sql) => sql.startsWith('SELECT n.bazis_node_id, n.parent_node_id'));
    expect(treeSql).toContain('bazis_node_order_detail_map');
    expect(treeSql).toContain('order_detail_id IS NOT NULL');
    expect(treeSql).toContain('order_name');
    expect(treeSql).toContain('delete_flag');
    expect(treeSql).toContain('orderDeleted');
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
          designation: null,
          product_order_no: null,
          quantity: 1,
          cumulative_quantity: 1,
          length_mm: 800,
          width_mm: 300,
          thickness_mm: 16,
          main_material_name: 'ЛДСП',
          children_count: 0,
          linked_orders: [{ orderId: 11385, orderName: 'санузел' }],
        },
      ],
    });
    const repository = new PgBazisRepository(database.service);

    const nodes = await repository.listAllTreeNodes(5);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].orders).toEqual([{ orderId: 11385, orderName: 'санузел' }]);
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
    projectRevisionRows?: Array<Record<string, unknown>>;
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
      draftNodeRows?: Array<Record<string, unknown>>;
      mappingRows?: Array<Record<string, unknown>>;
      referenceRows?: Array<Record<string, unknown>>;
      dowelingStatusDefaults?: {
        payment_status_id: number | null;
        production_status_id: number | null;
      };
      nowIso?: string;
    };
    addToOrderState?: {
      idempotencyConflict?: boolean;
      existingIdempotencyRow?: {
        request_hash: string;
        response_json: Record<string, unknown> | null;
        status: string;
        created_at: string;
      };
      revisionRow?: Record<string, unknown>;
      targetOrderRow?: Record<string, unknown> | null;
      nodeLookupRows?: Array<Record<string, unknown>>;
      panelRows?: Array<Record<string, unknown>>;
      mappingRows?: Array<Record<string, unknown>>;
      referenceRows?: Array<Record<string, unknown>>;
      duplicateRows?: Array<Record<string, unknown>>;
      nowIso?: string;
    };
    orderDraftState?: {
      revisionRow?: Record<string, unknown>;
      panelRows?: Array<Record<string, unknown>>;
      mappingRows?: Array<Record<string, unknown>>;
      referenceRows?: Array<Record<string, unknown>>;
      targetOrderRow?: Record<string, unknown> | null;
      duplicateRows?: Array<Record<string, unknown>>;
    };
    materialsSummary?: {
      summaryRow?: Record<string, unknown> | null;
      panelRows?: Array<Record<string, unknown>>;
      hardwareRows?: Array<Record<string, unknown>>;
      edgeRows?: Array<Record<string, unknown>>;
      filmRows?: Array<Record<string, unknown>>;
    };
    setNodeNotesState?: {
      existingRow?: Record<string, unknown> | null;
    };
    revisionOrders?: Array<Record<string, unknown>>;
    pruneCandidates?: Array<Record<string, unknown>>;
    projectListRows?: Array<Record<string, unknown>>;
    pruneProtectedRevisionIds?: number[];
    activeEmployees?: Array<{ employee_id: number; full_name: string }>;
    projectDesignEngineerState?: {
      existingRow?: Record<string, unknown> | null;
      employeeRow?: Record<string, unknown> | null;
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

      if (normalized === 'SELECT employee_id, full_name FROM employees WHERE is_active = true ORDER BY employee_id') {
        return {
          rows: options.activeEmployees ?? [],
          rowCount: options.activeEmployees?.length ?? 0,
        };
      }

      if (normalized.startsWith('SELECT bp.project_id, bp.design_engineer_id, employee.full_name AS design_engineer_name')) {
        const row = options.projectDesignEngineerState?.existingRow;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('SELECT full_name FROM employees WHERE employee_id = $1 AND is_active = true')) {
        const row = options.projectDesignEngineerState?.employeeRow;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        if (
          String(params[1]) === 'bazis.create_order' ||
          String(params[1]) === 'bazis.create_order_from_draft' ||
          String(params[1]) === 'bazis.add_to_order'
        ) {
          createOrderRequestHash = params[5];
          const addToOrderConflict =
            String(params[1]) === 'bazis.add_to_order'
              ? options.addToOrderState?.idempotencyConflict
              : options.createOrderState?.idempotencyConflict;
          return addToOrderConflict
            ? { rows: [], rowCount: 0 }
            : {
                rows: [
                  {
                    idempotency_key: params[0],
                    request_hash: params[5],
                    response_json: null,
                    status: 'processing',
                    created_at:
                      options.addToOrderState?.nowIso ??
                      options.createOrderState?.nowIso ??
                      '2026-07-08T12:00:00.000Z',
                  },
                ],
                rowCount: 1,
              };
        }
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash, response_json, status, created_at FROM command_idempotency_keys')) {
        const row = options.addToOrderState?.existingIdempotencyRow ?? options.createOrderState?.existingIdempotencyRow;
        return row
          ? { rows: [row], rowCount: 1 }
          : {
              rows: [{
                idempotency_key: params[0],
                request_hash: createOrderRequestHash,
                response_json: null,
                status: 'processing',
                created_at:
                  options.addToOrderState?.nowIso ??
                  options.createOrderState?.nowIso ??
                  '2026-07-08T12:00:00.000Z',
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

      if (normalized.startsWith('SELECT r.bazis_revision_id, r.bazis_project_id, bp.project_id')) {
        const row =
          options.addToOrderState?.revisionRow ??
          options.orderDraftState?.revisionRow ??
          options.createOrderState?.revisionRow;
        return row
          ? {
              rows: [{ design_engineer_id: 88, design_engineer_name: 'Конструктор Тест', ...row }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('WITH RECURSIVE sel AS')) {
        const rows =
          options.addToOrderState?.panelRows ??
          options.orderDraftState?.panelRows ??
          options.createOrderState?.panelRows ??
          [];
        return {
          rows,
          rowCount: rows.length,
        };
      }

      if (normalized.startsWith('SELECT bazis_node_id, object_type FROM bazis_nodes')) {
        const rows = options.addToOrderState?.nodeLookupRows ?? options.createOrderState?.draftNodeRows ?? [];
        return { rows, rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT source_kind, lower(bazis_name) AS name, target_kind')) {
        const rows =
          options.addToOrderState?.mappingRows ??
          options.orderDraftState?.mappingRows ??
          options.createOrderState?.mappingRows ??
          [];
        return {
          rows,
          rowCount: rows.length,
        };
      }

      if (normalized.startsWith("SELECT 'milling'::text AS reference_kind")) {
        const rows =
          options.addToOrderState?.referenceRows ??
          options.orderDraftState?.referenceRows ??
          options.createOrderState?.referenceRows ??
          [];
        return {
          rows,
          rowCount: rows.length,
        };
      }

      if (normalized.startsWith('SELECT order_id, client_id FROM orders')) {
        const row = options.addToOrderState?.targetOrderRow ?? options.orderDraftState?.targetOrderRow;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('WITH sel AS (')) {
        const rows = options.addToOrderState?.duplicateRows ?? options.orderDraftState?.duplicateRows ?? [];
        return { rows, rowCount: rows.length };
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
        const rows = options.projectListRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (normalized.startsWith('SELECT r.bazis_revision_id, r.revision_no,')) {
        const rows = options.projectRevisionRows ?? [];
        return { rows, rowCount: rows.length };
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
      if (
        normalized.startsWith(
          'SELECT n.bazis_node_id, n.notes, n.revision_id, r.bazis_project_id, bp.project_id FROM bazis_nodes n',
        )
      ) {
        const row = options.setNodeNotesState?.existingRow;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
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

      if (normalized.includes('FROM payment_statuses') && normalized.includes('FROM production_statuses')) {
        return {
          rows: [options.createOrderState?.dowelingStatusDefaults ?? {
            payment_status_id: 1,
            production_status_id: 2,
          }],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('INSERT INTO doweling_orders')) {
        return { rows: [{ doweling_order_id: 501 }], rowCount: 1 };
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

function createOrderFromDraftCommand(
  overrides: Partial<{
    revisionId: number;
    requestId: string;
    idempotencyKey: string;
    order: ReturnType<typeof createSaveOrderDto>;
    nodes: Array<{ clientKey: string; bazisNodeId: number }>;
  }> = {},
) {
  return {
    currentUser: currentUser(),
    requestId: overrides.requestId ?? 'req-create-order-draft',
    revisionId: overrides.revisionId ?? 82,
    order: overrides.order ?? createSaveOrderDto(),
    nodes: overrides.nodes ?? [
      { clientKey: 'draft-detail-1', bazisNodeId: 101 },
      { clientKey: 'draft-detail-2', bazisNodeId: 102 },
    ],
    idempotencyKey: overrides.idempotencyKey ?? 'bazis-create-order-draft-001',
  };
}

function createAddToOrderCommand(
  overrides: Partial<{
    revisionId: number;
    requestId: string;
    orderId: number;
    adds: number[];
    replaces: Array<{ bazisNodeId: number; orderDetailId: number }>;
    skips: Array<{ bazisNodeId: number; orderDetailId: number }>;
    idempotencyKey: string;
  }> = {},
) {
  return {
    currentUser: currentUser(),
    requestId: overrides.requestId ?? 'req-add-to-order',
    revisionId: overrides.revisionId ?? 82,
    orderId: overrides.orderId ?? 9001,
    adds: overrides.adds ?? [101],
    replaces: overrides.replaces ?? [],
    skips: overrides.skips ?? [],
    idempotencyKey: overrides.idempotencyKey ?? 'add-to-order-001',
  };
}

function parsedRevision(overrides: Partial<ParsedBazisRevision> = {}): ParsedBazisRevision {
  return {
    bazisVersion: '11',
    bazisOrderNo: '1457',
    designEngineerName: null,
    productName: 'Шкаф Nova',
    productPrice: 1200,
    nodes: [
      {
        index: 0,
        parentIndex: null,
        seq: 1,
        nodeKind: 'product',
        productOrderNo: '1443',
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
        productOrderNo: null,
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

function hashCreateOrderFromDraftRequestShape(
  command: ReturnType<typeof createOrderFromDraftCommand>,
): string {
  const order = {
    ...command.order,
    header: {
      ...command.order.header,
      projectId: undefined,
    },
    idempotencyKey: undefined,
  };

  return createHash('sha256')
    .update(
      stableStringify({
        order,
        nodes: [...command.nodes].sort(
          (left, right) => left.bazisNodeId - right.bazisNodeId || left.clientKey.localeCompare(right.clientKey),
        ),
        actorUserId: Number(command.currentUser.id),
        commandName: 'bazis.create_order_from_draft',
      }),
    )
    .digest('hex');
}

function hashAddToOrderRequestShape(command: ReturnType<typeof createAddToOrderCommand>): string {
  return createHash('sha256')
    .update(
      stableStringify({
        orderId: command.orderId,
        adds: [...command.adds].sort((left, right) => left - right),
        replaces: [...command.replaces].sort(
          (left, right) => left.bazisNodeId - right.bazisNodeId || left.orderDetailId - right.orderDetailId,
        ),
        skips: [...command.skips].sort(
          (left, right) => left.bazisNodeId - right.bazisNodeId || left.orderDetailId - right.orderDetailId,
        ),
        actorUserId: Number(command.currentUser.id),
        commandName: 'bazis.add_to_order',
      }),
    )
    .digest('hex');
}

function createSaveOrderDto(
  overrides: Partial<{
    header: Record<string, unknown>;
    details: Array<Record<string, unknown>>;
    idempotencyKey?: string;
  }> = {},
) {
  return {
    header: {
      orderName: 'ERP order draft',
      clientId: 5,
      orderDate: '2026-07-08',
      orderStatusId: 3,
      projectId: 999,
      ...(overrides.header ?? {}),
    },
    details: [
      {
        clientKey: 'draft-detail-1',
        detailNumber: 1,
        detailName: 'Панель 1',
        height: 1200,
        width: 450,
        quantity: 1,
        materialId: null,
        sheetMaterialTypeId: 501,
        millingTypeId: 1,
        edgeTypeId: 1,
      },
      {
        clientKey: 'draft-detail-2',
        detailNumber: 2,
        detailName: 'Панель 2',
        height: 800,
        width: 300,
        quantity: 1,
        materialId: null,
        sheetMaterialTypeId: 502,
        millingTypeId: 1,
        edgeTypeId: 1,
      },
      {
        clientKey: 'manual-detail-3',
        detailNumber: 3,
        detailName: 'Ручная деталь',
        height: 400,
        width: 200,
        quantity: 1,
        materialId: null,
        sheetMaterialTypeId: 503,
        millingTypeId: 1,
        edgeTypeId: 1,
      },
      ...((overrides.details ?? []).map((detail) => ({ ...detail })) as Array<Record<string, unknown>>),
    ],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {
      detailIds: [],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    },
    idempotencyKey: overrides.idempotencyKey ?? 'nested-order-key',
  };
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

function buildDetailedOrderDto(orderId: number, orderName: string): OrderDto {
  const order = buildOrderDto(orderId, orderName);
  return {
    ...order,
    header: {
      ...order.header,
      priority: 17,
      managerId: 3,
      paymentStatusId: 2,
      productionStatusId: 4,
      productionStatusFromDetailsEnabled: false,
      plannedCompletionDate: '2026-07-15',
      completionDate: '2026-07-18',
      issueDate: '2026-07-20',
      paymentDate: '2026-07-21',
      discount: 10,
      surcharge: 5,
      linkCuttingFile: '/cut/header.xlsx',
      linkCuttingImageFile: '/cut/header.png',
      linkCadFile: '/cad/header.dxf',
      linkPdfFile: '/pdf/header.pdf',
      notes: 'header note',
      refKey1c: 'hdr-1c',
      sheetMaterialTypeId: 777,
      millingTypeId: 6,
      edgeTypeId: 7,
      filmId: 8,
    },
    details: [
      {
        id: 7001,
        orderId,
        detailNumber: 1,
        detailName: 'Старая фасадная деталь',
        height: 1111,
        width: 444,
        quantity: 2,
        materialId: null,
        sheetMaterialTypeId: 501,
        millingTypeId: 5,
        edgeTypeId: 6,
        filmId: 601,
        area: 0.9,
        millingCostPerSqm: 11,
        detailCost: 22,
        priority: 15,
        productionStatusId: 3,
        jointOrderId: null,
        note: 'keep old 1',
        basisProject: 'old-project-1',
        basisProduct: 'old-product-1',
        basisData: 'old-data-1',
        basisDesignation: 'OLD-1',
        linkCuttingFile: '/cut/old-1.xlsx',
        linkCuttingImageFile: '/cut/old-1.png',
        linkCadFile: '/cad/old-1.dxf',
        linkPdfFile: '/pdf/old-1.pdf',
        refKey1c: 'detail-1c-1',
      },
      {
        id: 7002,
        orderId,
        detailNumber: 2,
        detailName: 'Старая полка',
        height: 999,
        width: 333,
        quantity: 4,
        materialId: null,
        sheetMaterialTypeId: 999,
        millingTypeId: 9,
        edgeTypeId: 8,
        filmId: 777,
        area: 1.2,
        millingCostPerSqm: 33,
        detailCost: 44,
        priority: 17,
        productionStatusId: 2,
        jointOrderId: 555,
        note: 'keep me',
        basisProject: 'old-project-2',
        basisProduct: 'old-product-2',
        basisData: 'old-data-2',
        basisDesignation: 'OLD-2',
        linkCuttingFile: '/cut/preserved.xlsx',
        linkCuttingImageFile: '/cut/preserved.png',
        linkCadFile: '/cad/preserved.dxf',
        linkPdfFile: '/pdf/preserved.pdf',
        refKey1c: 'detail-1c-2',
      },
    ],
    payments: [{ id: 8101, orderId, typePaidId: 1, amount: 1500, paymentDate: '2026-07-13', notes: 'payment', refKey1c: 'pay-1' }],
    workshops: [{
      id: 8201,
      orderId,
      workshopId: 4,
      productionStatusId: 2,
      receivedDate: '2026-07-14',
      startedDate: '2026-07-15',
      completedDate: null,
      plannedCompletionDate: '2026-07-18',
      sequenceOrder: 1,
      responsibleEmployeeId: 33,
      notes: 'workshop',
      refKey1c: 'ws-1',
    }],
    requirements: [{
      id: 8301,
      orderId,
      resourceType: 'material',
      materialId: null,
      filmId: null,
      edgeTypeId: 11,
      requiredQuantity: 5,
      unitId: 1,
      wastePercentage: 7,
      finalQuantity: 5.35,
      requirementStatusId: 2,
      supplierId: 17,
      purchasePrice: 100,
      requisitionId: 91,
      warehouseId: 12,
      reservedAt: '2026-07-15',
      consumedAt: null,
      notes: 'requirement',
      calculationDetails: 'calc',
      refKey1c: 'req-1',
    }],
    dowelingLinks: [{
      id: 8401,
      orderId,
      dowelingOrderId: 77,
      designEngineerId: 88,
      refKey1c: 'dow-1',
      dowelingOrder: { id: 77, name: 'Doweling 77', designEngineerId: 88 },
    }],
    version: 7,
  };
}

function baseRevisionRow() {
  return {
    bazis_revision_id: 82,
    bazis_project_id: 41,
    project_id: 77,
    bazis_project_name: 'Шкаф Nova',
    revision_bazis_order_no: '1457',
    project_client_id: 5,
    client_name: 'ООО Клиент',
    design_engineer_id: 88,
    design_engineer_name: 'Конструктор Тест',
  };
}

function panelRow101() {
  return {
    bazis_node_id: 101,
    object_type: 'Панель',
    name: 'Фасад/левая створка',
    position: '7',
    designation: 'D-01',
    cumulative_quantity: 2,
    length_mm: 1200,
    width_mm: 450,
    main_material_name: 'Laminate White',
    product_name: 'Шкаф',
    product_order_no: '1443',
    raw_json: {
      ОблицовкаПласти1: { Пласть: { Наименование: 'Snow Film' } },
    },
  };
}

function panelRow102() {
  return {
    bazis_node_id: 102,
    object_type: 'Панель',
    name: 'Полка',
    position: '8',
    designation: 'S-02',
    cumulative_quantity: 1,
    length_mm: 800,
    width_mm: 300,
    main_material_name: 'Unknown Sheet',
    product_name: 'Шкаф',
    product_order_no: '1443',
    raw_json: {},
  };
}

function panelRow104() {
  return {
    bazis_node_id: 104,
    object_type: 'Панель',
    name: 'Перегородка',
    position: '10',
    designation: 'P-04',
    cumulative_quantity: 1,
    length_mm: 700,
    width_mm: 400,
    main_material_name: 'Extra Sheet',
    product_name: 'Шкаф',
    product_order_no: '1443',
    raw_json: {},
  };
}

function sheetAndFilmMappings() {
  return [
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
  ];
}

function sheetOnlyMapping(sheetMaterialTypeId: number) {
  return [
    {
      source_kind: 'sheet',
      name: sheetMaterialTypeId === 504 ? 'extra sheet' : 'unknown sheet',
      target_kind: 'sheet',
      sheet_material_type_id: sheetMaterialTypeId,
      film_id: null,
      edge_type_id: null,
    },
  ];
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('PgBazisRepository.renameProject', () => {
  it('locks and renames project with audit + outbox', async () => {
    const database = createRenameDatabase();
    const repository = new PgBazisRepository(database.service);

    const response = await repository.renameProject({
      currentUser: currentUser('admin'),
      requestId: 'req-rename-1',
      bazisProjectId: 41,
      name: '1485',
    });

    expect(response).toEqual({ bazisProjectId: 41, projectId: 77, name: '1485' });
    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered[0]).toBe('SELECT set_session_user($1)');
    expect(ordered.some((sql) => sql.includes('FROM bazis_projects') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(ordered).toContain('UPDATE bazis_projects SET name = $2 WHERE bazis_project_id = $1');

    const audit = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log ('));
    expect(audit?.params).toContain('bazis.project_renamed');
    expect(audit?.params).toContain(JSON.stringify({ name: 'Шкаф Nova' }));
    expect(audit?.params).toContain(JSON.stringify({ name: '1485' }));

    const outbox = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO outbox_events'));
    expect(outbox?.params?.[0]).toBe('bazis.project_renamed');
    expect(outbox?.params?.[4]).toBe('bazis-project-renamed-41-req-rename-1');
  });

  it('same name is a no-op without update, audit, or outbox', async () => {
    const database = createRenameDatabase({ name: '1485' });
    const repository = new PgBazisRepository(database.service);

    await expect(repository.renameProject({
      currentUser: currentUser('admin'),
      requestId: 'req-rename-noop',
      bazisProjectId: 41,
      name: '1485',
    })).resolves.toEqual({ bazisProjectId: 41, projectId: 77, name: '1485' });

    const ordered = database.queries.map((query) => normalizeSql(query.text));
    expect(ordered.some((sql) => sql.startsWith('UPDATE bazis_projects'))).toBe(false);
    expect(ordered.some((sql) => sql.startsWith('INSERT INTO audit_log'))).toBe(false);
    expect(ordered.some((sql) => sql.startsWith('INSERT INTO outbox_events'))).toBe(false);
  });

  it('uses the audit id for outbox idempotency when request id is absent', async () => {
    const database = createRenameDatabase();
    const repository = new PgBazisRepository(database.service);

    await repository.renameProject({
      currentUser: currentUser('admin'),
      bazisProjectId: 41,
      name: '1485',
    });

    const outbox = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO outbox_events'));
    expect(outbox?.params?.[4]).toBe('bazis-project-renamed-41-audit-audit-rename-1');
  });

  it('throws BazisProjectNotFoundError for missing project', async () => {
    const repository = new PgBazisRepository(createRenameDatabase({ missing: true }).service);

    await expect(repository.renameProject({
      currentUser: currentUser('admin'),
      bazisProjectId: 404,
      name: '1485',
    })).rejects.toBeInstanceOf(BazisProjectNotFoundError);
  });
});

describe('PgBazisRepository.setProjectDesignEngineer', () => {
  it('validates the active employee and writes a manual audited selection', async () => {
    const database = createDatabase({
      projectDesignEngineerState: {
        existingRow: {
          project_id: 77,
          design_engineer_id: null,
          design_engineer_name: null,
          design_engineer_xml_name: 'Тапен Ж.К',
          design_engineer_source: null,
        },
        employeeRow: { full_name: 'Тапен Жамит' },
      },
    });
    const repository = new PgBazisRepository(database.service);

    await expect(repository.setProjectDesignEngineer({
      currentUser: currentUser('admin'),
      requestId: 'req-engineer-1',
      bazisProjectId: 41,
      designEngineerId: 10,
    })).resolves.toEqual({
      bazisProjectId: 41,
      designEngineerId: 10,
      designEngineerName: 'Тапен Жамит',
      designEngineerXmlName: 'Тапен Ж.К',
      designEngineerSource: 'manual',
    });

    expect(database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE bazis_projects SET design_engineer_id'),
    )?.params).toEqual([41, 10]);
    expect(database.queries.some((query) =>
      query.params?.[0] === 'bazis.project_design_engineer_changed'),
    ).toBe(true);
  });

  it('rejects an inactive or missing employee', async () => {
    const database = createDatabase({
      projectDesignEngineerState: {
        existingRow: {
          project_id: 77,
          design_engineer_id: null,
          design_engineer_name: null,
          design_engineer_xml_name: null,
          design_engineer_source: null,
        },
        employeeRow: null,
      },
    });
    const repository = new PgBazisRepository(database.service);

    await expect(repository.setProjectDesignEngineer({
      currentUser: currentUser('admin'),
      bazisProjectId: 41,
      designEngineerId: 999,
    })).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  });
});

function createRenameDatabase(options: { name?: string; missing?: boolean } = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const tx = {
    raw: {} as PoolClient,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);
      if (normalized.includes('FROM bazis_projects') && normalized.includes('FOR UPDATE')) {
        return options.missing
          ? { rows: [], rowCount: 0 }
          : {
              rows: [{ bazis_project_id: 41, project_id: 77, name: options.name ?? 'Шкаф Nova' }],
              rowCount: 1,
            };
      }
      if (normalized.startsWith('INSERT INTO audit_log (')) {
        return { rows: [{ audit_id: 'audit-rename-1' }], rowCount: 1 };
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
