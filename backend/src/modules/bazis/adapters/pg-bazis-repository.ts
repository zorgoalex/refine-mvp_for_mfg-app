import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  BazisRepositoryPort,
  CreateOrderFromRevisionCommand,
  ImportRevisionCommand,
} from '../application/bazis.types';
import type {
  BazisImportResponseDto,
  BazisProjectCardDto,
  BazisProjectListItemDto,
  BazisTreeNodeDto,
  CreateOrderFromRevisionResponseDto,
  MaterialMappingDto,
  UpsertMaterialMappingDto,
} from '../dto/bazis.dto';
import {
  BazisProjectNotFoundError,
  BazisReferenceNotFoundError,
  BazisRevisionDuplicateError,
} from '../errors/bazis.errors';

const SOURCE = 'backend-bazis-command';

interface ProjectListRow {
  bazis_project_id: number | string;
  project_id: number | string;
  name: string;
  revisions_count: number | string;
  last_revision_no: number | string | null;
  last_imported_at: string | null;
  linked_order_ids: Array<number | string> | null;
}

interface ProjectRevisionRow {
  bazis_revision_id: number | string;
  revision_no: number | string;
  file_name: string | null;
  file_size: number | string | null;
  xml_sha256: string;
  product_name: string | null;
  product_price: number | string | null;
  summary_json: Record<string, number>;
  imported_at: string;
}

interface TreeNodeRow {
  bazis_node_id: number | string;
  parent_node_id: number | string | null;
  seq: number | string;
  node_kind: string;
  object_type: string | null;
  name: string | null;
  detail_code: string | null;
  position: string | null;
  quantity: number | string | null;
  cumulative_quantity: number | string | null;
  length_mm: number | string | null;
  width_mm: number | string | null;
  thickness_mm: number | string | null;
  main_material_name: string | null;
  children_count: number | string;
}

interface MaterialMappingRow {
  bazis_material_mapping_id: number | string;
  source_kind: string;
  bazis_name: string;
  target_kind: string;
  sheet_material_type_id: number | string | null;
  film_id: number | string | null;
  edge_type_id: number | string | null;
}

export class PgBazisRepository implements BazisRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async importRevision(command: ImportRevisionCommand): Promise<BazisImportResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = requestIdOrFallback(command.requestId, 'bazis-import');

      let bazisProjectId = command.bazisProjectId;
      let projectId = command.projectId;
      let bazisProjectName: string;

      if (bazisProjectId != null) {
        const existing = await tx.query<{ bazis_project_id: number; project_id: number; name: string }>(
          `
          SELECT bazis_project_id, project_id, name
          FROM bazis_projects
          WHERE bazis_project_id = $1
          FOR UPDATE
          `,
          [bazisProjectId],
        );
        if (existing.rows.length === 0) {
          throw new BazisProjectNotFoundError(bazisProjectId);
        }
        projectId = Number(existing.rows[0].project_id);
        bazisProjectName = existing.rows[0].name;
      } else {
        if (projectId == null) {
          throw new BazisReferenceNotFoundError('projectId');
        }
        bazisProjectName = command.parsed.productName ?? command.fileName;
        const inserted = await tx.query<{ bazis_project_id: number | string }>(
          `
          INSERT INTO bazis_projects (project_id, name, created_by)
          VALUES ($1, $2, $3)
          RETURNING bazis_project_id
          `,
          [projectId, bazisProjectName, numericUserId(command.currentUser)],
        );
        bazisProjectId = Number(inserted.rows[0].bazis_project_id);

        await auditService.record(tx, {
          event: 'bazis.project_created',
          entityType: 'bazis_project',
          entityId: String(bazisProjectId),
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId,
          source: SOURCE,
          relatedEntities: [
            { entityType: 'project', entityId: projectId },
            { entityType: 'bazis_project', entityId: bazisProjectId },
          ],
          before: {},
          after: { bazisProjectId, projectId, name: bazisProjectName },
          metadata: {
            source: SOURCE,
            action: 'bazis_project_create',
            requestId,
          },
        });
      }

      const dupSame = await tx.query<{ revision_no: number | string }>(
        `
        SELECT revision_no
        FROM bazis_project_revisions
        WHERE bazis_project_id = $1 AND xml_sha256 = $2
        `,
        [bazisProjectId, command.xmlSha256],
      );
      if (dupSame.rows.length > 0) {
        throw new BazisRevisionDuplicateError(Number(dupSame.rows[0].revision_no));
      }

      const warnings: string[] = [];
      const dupOther = await tx.query<{ bazis_project_id: number | string; name: string }>(
        `
        SELECT r.bazis_project_id, p.name
        FROM bazis_project_revisions r
        JOIN bazis_projects p ON p.bazis_project_id = r.bazis_project_id
        WHERE r.xml_sha256 = $1
        LIMIT 1
        `,
        [command.xmlSha256],
      );
      if (dupOther.rows.length > 0) {
        warnings.push(`Такой же файл уже импортирован в Базис-проект «${dupOther.rows[0].name}»`);
      }

      const revisionNoRow = await tx.query<{ next: number | string }>(
        `
        SELECT COALESCE(MAX(revision_no), 0) + 1 AS next
        FROM bazis_project_revisions
        WHERE bazis_project_id = $1
        `,
        [bazisProjectId],
      );
      const revisionNo = Number(revisionNoRow.rows[0].next);

      const revisionRow = await tx.query<{ bazis_revision_id: number | string }>(
        `
        INSERT INTO bazis_project_revisions
          (bazis_project_id, revision_no, file_name, file_size, xml_sha256, raw_xml,
           bazis_version, product_name, product_price, summary_json, imported_by, request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
        RETURNING bazis_revision_id
        `,
        [
          bazisProjectId,
          revisionNo,
          command.fileName,
          command.fileSize,
          command.xmlSha256,
          command.rawXmlGzip,
          command.parsed.bazisVersion,
          command.parsed.productName,
          command.parsed.productPrice,
          JSON.stringify(command.parsed.summary),
          numericUserId(command.currentUser),
          requestId,
        ],
      );
      const revisionId = Number(revisionRow.rows[0].bazis_revision_id);

      const idByIndex = new Map<number, number>();
      for (const node of command.parsed.nodes) {
        const parentId = node.parentIndex === null ? null : idByIndex.get(node.parentIndex) ?? null;
        const insertedNode = await tx.query<{ bazis_node_id: number | string }>(
          `
          INSERT INTO bazis_nodes
            (revision_id, parent_node_id, seq, node_kind, object_type, name, detail_code,
             position, designation, quantity, cumulative_quantity, length_mm, width_mm,
             height_mm, thickness_mm, price, is_rectangular, texture_orientation,
             main_material_name, raw_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
          RETURNING bazis_node_id
          `,
          [
            revisionId,
            parentId,
            node.seq,
            node.nodeKind,
            node.objectType,
            node.name,
            node.detailCode,
            node.position,
            node.designation,
            node.quantity,
            node.cumulativeQuantity,
            node.lengthMm,
            node.widthMm,
            node.heightMm,
            node.thicknessMm,
            node.price,
            node.isRectangular,
            node.textureOrientation,
            node.mainMaterialName,
            JSON.stringify(node.raw),
          ],
        );
        idByIndex.set(node.index, Number(insertedNode.rows[0].bazis_node_id));
      }

      await tx.query(
        `
        UPDATE bazis_projects
        SET current_revision_id = $1
        WHERE bazis_project_id = $2
        `,
        [revisionId, bazisProjectId],
      );

      const lookup = command.parsed.materials.filter((material) => material.kindGuess !== 'hardware');
      const mapped = lookup.length
        ? await tx.query<{ source_kind: string; name: string }>(
            `
            SELECT source_kind, lower(bazis_name) AS name
            FROM bazis_material_mappings
            WHERE (source_kind, lower(bazis_name)) IN
                  (SELECT unnest($1::text[]), unnest($2::text[]))
            `,
            [lookup.map((material) => material.kindGuess), lookup.map((material) => material.name.toLowerCase())],
          )
        : { rows: [], rowCount: 0 };
      const mappedSet = new Set(mapped.rows.map((row) => `${row.source_kind}:${row.name}`));
      const unmappedMaterials = lookup.filter(
        (material) => !mappedSet.has(`${material.kindGuess}:${material.name.toLowerCase()}`),
      );

      await auditService.record(tx, {
        event: 'bazis.revision_imported',
        entityType: 'bazis_revision',
        entityId: String(revisionId),
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId,
        source: SOURCE,
        relatedEntities: [
          { entityType: 'project', entityId: projectId ?? 0 },
          { entityType: 'bazis_project', entityId: bazisProjectId },
        ],
        before: {},
        after: {
          revisionId,
          revisionNo,
          xmlSha256: command.xmlSha256,
          fileName: command.fileName,
        },
        metadata: {
          source: SOURCE,
          action: 'bazis_import',
          requestId,
          summary: command.parsed.summary,
        },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          'bazis.revision_imported',
          'bazis_revision',
          String(revisionId),
          JSON.stringify({
            eventType: 'bazis.revision_imported',
            revisionId,
            bazisProjectId,
            projectId,
            actorUserId: command.currentUser.id,
            requestId,
          }),
          `bazis-revision-imported-${command.xmlSha256}-${bazisProjectId}`,
        ],
      );

      await tx.query(
        `
        INSERT INTO bazis_import_runs (file_name, xml_sha256, status, revision_id, imported_by, request_id)
        VALUES ($1,$2,'parsed',$3,$4,$5)
        `,
        [command.fileName, command.xmlSha256, revisionId, numericUserId(command.currentUser), requestId],
      );

      return {
        bazisProject: {
          bazisProjectId,
          projectId: projectId ?? 0,
          name: bazisProjectName,
        },
        revision: {
          bazisRevisionId: revisionId,
          revisionNo,
          xmlSha256: command.xmlSha256,
          summary: command.parsed.summary,
        },
        unmappedMaterials,
        warnings,
        requestId,
      };
    });
  }

  async recordFailedImport(input: {
    currentUser: CurrentUser;
    requestId?: string;
    fileName: string;
    xmlSha256: string | null;
    errorMessage: string;
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, input.currentUser.id);
      await tx.query(
        `
        INSERT INTO bazis_import_runs (file_name, xml_sha256, status, error_json, imported_by, request_id)
        VALUES ($1,$2,'failed',$3::jsonb,$4,$5)
        `,
        [
          input.fileName,
          input.xmlSha256,
          JSON.stringify({ message: input.errorMessage }),
          numericUserId(input.currentUser),
          requestIdOrFallback(input.requestId, 'bazis-import'),
        ],
      );
    });
  }

  async listProjects(filter: { projectId?: number }): Promise<BazisProjectListItemDto[]> {
    const result = await this.database.query<ProjectListRow>(
      `
      SELECT bp.bazis_project_id,
             bp.project_id,
             bp.name,
             COUNT(DISTINCT r.bazis_revision_id)::int AS revisions_count,
             MAX(r.revision_no)::int AS last_revision_no,
             MAX(r.imported_at)::text AS last_imported_at,
             COALESCE(array_remove(array_agg(DISTINCT bol.order_id), NULL), '{}') AS linked_order_ids
      FROM bazis_projects bp
      LEFT JOIN bazis_project_revisions r ON r.bazis_project_id = bp.bazis_project_id
      LEFT JOIN bazis_order_links bol ON bol.bazis_project_id = bp.bazis_project_id
      WHERE ($1::bigint IS NULL OR bp.project_id = $1)
      GROUP BY bp.bazis_project_id, bp.project_id, bp.name
      ORDER BY bp.bazis_project_id DESC
      `,
      [filter.projectId ?? null],
    );
    return result.rows.map(mapProjectListRow);
  }

  async getProject(bazisProjectId: number): Promise<BazisProjectCardDto> {
    const project = await this.database.query<ProjectListRow>(
      `
      SELECT bp.bazis_project_id,
             bp.project_id,
             bp.name,
             COUNT(DISTINCT r.bazis_revision_id)::int AS revisions_count,
             MAX(r.revision_no)::int AS last_revision_no,
             MAX(r.imported_at)::text AS last_imported_at,
             COALESCE(array_remove(array_agg(DISTINCT bol.order_id), NULL), '{}') AS linked_order_ids
      FROM bazis_projects bp
      LEFT JOIN bazis_project_revisions r ON r.bazis_project_id = bp.bazis_project_id
      LEFT JOIN bazis_order_links bol ON bol.bazis_project_id = bp.bazis_project_id
      WHERE bp.bazis_project_id = $1
      GROUP BY bp.bazis_project_id, bp.project_id, bp.name
      `,
      [bazisProjectId],
    );
    if (project.rows.length === 0) {
      throw new BazisProjectNotFoundError(bazisProjectId);
    }

    const revisions = await this.database.query<ProjectRevisionRow>(
      `
      SELECT r.bazis_revision_id,
             r.revision_no,
             r.file_name,
             r.file_size,
             r.xml_sha256,
             r.product_name,
             r.product_price,
             r.summary_json,
             r.imported_at::text AS imported_at
      FROM bazis_project_revisions r
      WHERE r.bazis_project_id = $1
      ORDER BY r.revision_no DESC
      `,
      [bazisProjectId],
    );

    return {
      ...mapProjectListRow(project.rows[0]),
      revisions: revisions.rows.map((row) => ({
        bazisRevisionId: Number(row.bazis_revision_id),
        revisionNo: Number(row.revision_no),
        fileName: row.file_name,
        fileSize: nullableNumber(row.file_size),
        xmlSha256: row.xml_sha256,
        productName: row.product_name,
        productPrice: nullableNumber(row.product_price),
        summary: row.summary_json ?? {},
        importedAt: row.imported_at,
      })),
    };
  }

  async getTreeChildren(revisionId: number, parentNodeId: number | null): Promise<BazisTreeNodeDto[]> {
    const result = await this.database.query<TreeNodeRow>(
      `
      SELECT n.bazis_node_id, n.parent_node_id, n.seq, n.node_kind, n.object_type, n.name,
             n.detail_code, n.position, n.quantity, n.cumulative_quantity,
             n.length_mm, n.width_mm, n.thickness_mm, n.main_material_name,
             (SELECT count(*) FROM bazis_nodes c WHERE c.parent_node_id = n.bazis_node_id)::int AS children_count
      FROM bazis_nodes n
      WHERE n.revision_id = $1 AND n.parent_node_id IS NOT DISTINCT FROM $2
      ORDER BY n.seq
      `,
      [revisionId, parentNodeId],
    );

    return result.rows.map((row) => ({
      bazisNodeId: Number(row.bazis_node_id),
      parentNodeId: nullableNumber(row.parent_node_id),
      seq: Number(row.seq),
      nodeKind: row.node_kind,
      objectType: row.object_type,
      name: row.name,
      detailCode: row.detail_code,
      position: row.position,
      quantity: nullableNumber(row.quantity),
      cumulativeQuantity: nullableNumber(row.cumulative_quantity),
      lengthMm: nullableNumber(row.length_mm),
      widthMm: nullableNumber(row.width_mm),
      thicknessMm: nullableNumber(row.thickness_mm),
      mainMaterialName: row.main_material_name,
      childrenCount: Number(row.children_count),
    }));
  }

  async listMaterialMappings(names?: string[]): Promise<MaterialMappingDto[]> {
    const loweredNames = names?.map((name) => name.toLowerCase()) ?? null;
    const result = await this.database.query<MaterialMappingRow>(
      `
      SELECT bazis_material_mapping_id,
             source_kind,
             bazis_name,
             target_kind,
             sheet_material_type_id,
             film_id,
             edge_type_id
      FROM bazis_material_mappings
      WHERE ($1::text[] IS NULL OR lower(bazis_name) = ANY($1::text[]))
      ORDER BY source_kind, bazis_name
      `,
      [loweredNames],
    );
    return result.rows.map(mapMaterialMappingRow);
  }

  async upsertMaterialMappings(
    currentUser: CurrentUser,
    requestId: string | undefined,
    items: UpsertMaterialMappingDto[],
  ): Promise<MaterialMappingDto[]> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, currentUser.id);
      const saved: MaterialMappingDto[] = [];

      for (const item of items) {
        try {
          const result = await tx.query<MaterialMappingRow>(
            `
            INSERT INTO bazis_material_mappings
              (source_kind, bazis_name, target_kind, sheet_material_type_id, film_id, edge_type_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
            ON CONFLICT (source_kind, lower(bazis_name)) DO UPDATE SET
              target_kind = EXCLUDED.target_kind,
              sheet_material_type_id = EXCLUDED.sheet_material_type_id,
              film_id = EXCLUDED.film_id,
              edge_type_id = EXCLUDED.edge_type_id,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
            RETURNING *
            `,
            [
              item.sourceKind,
              item.bazisName,
              item.targetKind,
              item.sheetMaterialTypeId ?? null,
              item.filmId ?? null,
              item.edgeTypeId ?? null,
              numericUserId(currentUser),
            ],
          );
          saved.push(mapMaterialMappingRow(result.rows[0]));
        } catch (error) {
          if (isForeignKeyViolation(error)) {
            throw new BazisReferenceNotFoundError(item.bazisName);
          }
          throw error;
        }
      }

      await auditService.record(tx, {
        event: 'bazis.material_mapping_set',
        entityType: 'bazis_material_mapping',
        entityId: 'batch',
        actorUserId: currentUser.id,
        actorUsername: currentUser.username,
        actorRole: currentUser.role,
        requestId: requestIdOrFallback(requestId, 'bazis-material-mapping'),
        source: SOURCE,
        before: {},
        after: { count: saved.length },
        metadata: {
          count: saved.length,
          names: items.map((item) => item.bazisName),
        },
      });

      return saved;
    });
  }

  createOrderFromRevision(_command: CreateOrderFromRevisionCommand): Promise<CreateOrderFromRevisionResponseDto> {
    throw new Error('bazis createOrderFromRevision: implemented in Task 9');
  }
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

function requestIdOrFallback(requestId: string | undefined, fallback: string): string {
  return requestId && requestId.length > 0 ? requestId : fallback;
}

function numericUserId(currentUser: CurrentUser): number {
  const value = Number(currentUser.id);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(500, 'INVALID_CURRENT_USER', 'Current user id must be numeric');
  }
  return value;
}

function nullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  return Number(value);
}

function mapProjectListRow(row: ProjectListRow): BazisProjectListItemDto {
  return {
    bazisProjectId: Number(row.bazis_project_id),
    projectId: Number(row.project_id),
    name: row.name,
    revisionsCount: Number(row.revisions_count),
    lastRevisionNo: nullableNumber(row.last_revision_no),
    lastImportedAt: row.last_imported_at,
    linkedOrderIds: (row.linked_order_ids ?? []).map((value) => Number(value)),
  };
}

function mapMaterialMappingRow(row: MaterialMappingRow): MaterialMappingDto {
  return {
    bazisMaterialMappingId: Number(row.bazis_material_mapping_id),
    sourceKind: row.source_kind,
    bazisName: row.bazis_name,
    targetKind: row.target_kind,
    sheetMaterialTypeId: nullableNumber(row.sheet_material_type_id),
    filmId: nullableNumber(row.film_id),
    edgeTypeId: nullableNumber(row.edge_type_id),
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23503';
}
