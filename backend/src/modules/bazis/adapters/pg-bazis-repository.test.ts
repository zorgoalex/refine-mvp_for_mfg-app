import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { ParsedBazisRevision } from '../application/bazis-xml-parser';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { BazisProjectNotFoundError, BazisRevisionDuplicateError } from '../errors/bazis.errors';
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
    expect(ordered.filter((sql) => sql.startsWith('INSERT INTO audit_log_related_entity'))).toHaveLength(4);
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

function createDatabase(
  options: {
    duplicateRevisionNo?: number;
    duplicateOtherProjectName?: string;
    materialMappings?: Array<{ source_kind: string; name: string }>;
    treeChildren?: Array<Record<string, unknown>>;
    upsertedMappings?: Array<Record<string, unknown>>;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let auditId = 0;
  let nodeId = 500;
  let mappingIndex = 0;
  const tx = {
    raw: {} as PoolClient,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

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
