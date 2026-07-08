import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderTransactionService } from '../../orders/application/order-transaction.service';
import type { SaveOrderDetailDto, SaveOrderDto } from '../../orders/dto/save-order.dto';
import type {
  BazisRepositoryPort,
  CreateOrderFromRevisionCommand,
  ImportRevisionCommand,
} from '../application/bazis.types';
import type {
  BazisImportResponseDto,
  BazisNodeCardDto,
  BazisProjectCardDto,
  BazisProjectListItemDto,
  BazisTreeNodeDto,
  CreateOrderFromRevisionResponseDto,
  MaterialMappingDto,
  UpsertMaterialMappingDto,
} from '../dto/bazis.dto';
import {
  BazisIdempotencyFailedError,
  BazisUnmappedMaterialsError,
  BazisIdempotencyInProgressError,
  BazisIdempotencyKeyReusedError,
  BazisNodeNotFoundError,
  BazisNoPanelsSelectedError,
  BazisProjectNotFoundError,
  BazisRevisionNotFoundError,
  BazisReferenceNotFoundError,
  BazisRevisionDuplicateError,
} from '../errors/bazis.errors';

const SOURCE = 'backend-bazis-command';
const COMMAND_NAME = 'bazis.create_order';
const STALE_PROCESSING_MS = 10 * 60 * 1000;

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

interface CreateOrderIdempotencyRow {
  idempotency_key: string;
  request_hash: string;
  response_json: CreateOrderFromRevisionResponseDto | string | null;
  status: string;
  created_at: string;
}

interface RevisionProjectRow {
  bazis_revision_id: number | string;
  bazis_project_id: number | string;
  project_id: number | string;
  bazis_project_name: string;
  project_client_id: number | string | null;
}

interface SelectedPanelRow {
  bazis_node_id: number | string;
  object_type: string | null;
  name: string | null;
  position: string | null;
  designation: string | null;
  cumulative_quantity: number | string | null;
  length_mm: number | string | null;
  width_mm: number | string | null;
  main_material_name: string | null;
  raw_json: Record<string, unknown> | null;
}

interface NodeCardRow {
  bazis_node_id: number | string;
  revision_id: number | string;
  parent_node_id: number | string | null;
  seq: number | string;
  node_kind: string;
  object_type: string | null;
  name: string | null;
  detail_code: string | null;
  position: string | null;
  designation: string | null;
  quantity: number | string | null;
  cumulative_quantity: number | string | null;
  length_mm: number | string | null;
  width_mm: number | string | null;
  height_mm: number | string | null;
  thickness_mm: number | string | null;
  price: number | string | null;
  is_rectangular: boolean | null;
  texture_orientation: string | null;
  main_material_name: string | null;
  raw_json: Record<string, unknown> | null;
  children_count: number | string;
  bazis_project_id: number | string;
  revision_no: number | string;
  project_id: number | string;
}

interface NodeOrderLinkRow {
  order_id: number | string;
  order_detail_id: number | string | null;
  mapping_kind: string;
}

interface MaterialLookupRow {
  source_kind: string;
  name: string;
  target_kind: string;
  sheet_material_type_id: number | string | null;
  film_id: number | string | null;
  edge_type_id: number | string | null;
}

export class PgBazisRepository implements BazisRepositoryPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly orderTransactions?: Pick<OrderTransactionService, 'create'>,
  ) {}

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
          { entityType: 'bazis_revision', entityId: revisionId },
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

  async getNodeCard(nodeId: number): Promise<BazisNodeCardDto> {
    const nodeResult = await this.database.query<NodeCardRow>(
      `
      SELECT n.bazis_node_id, n.revision_id, n.parent_node_id, n.seq, n.node_kind, n.object_type,
             n.name, n.detail_code, n.position, n.designation, n.quantity, n.cumulative_quantity,
             n.length_mm, n.width_mm, n.height_mm, n.thickness_mm, n.price, n.is_rectangular,
             n.texture_orientation, n.main_material_name, n.raw_json,
             (SELECT count(*) FROM bazis_nodes c
              WHERE c.parent_node_id = n.bazis_node_id
                AND c.revision_id = n.revision_id)::int AS children_count,
             r.bazis_project_id, r.revision_no, bp.project_id
      FROM bazis_nodes n
      JOIN bazis_project_revisions r ON r.bazis_revision_id = n.revision_id
      JOIN bazis_projects bp ON bp.bazis_project_id = r.bazis_project_id
      WHERE n.bazis_node_id = $1
      `,
      [nodeId],
    );
    if (nodeResult.rows.length === 0) {
      throw new BazisNodeNotFoundError(nodeId);
    }

    const links = await this.database.query<NodeOrderLinkRow>(
      `
      SELECT m.order_id, m.order_detail_id, m.mapping_kind
      FROM bazis_node_order_detail_map m
      WHERE m.node_id = $1
      ORDER BY m.order_id DESC
      `,
      [nodeId],
    );

    const row = nodeResult.rows[0];
    return {
      bazisNodeId: Number(row.bazis_node_id),
      revisionId: Number(row.revision_id),
      bazisProjectId: Number(row.bazis_project_id),
      projectId: Number(row.project_id),
      revisionNo: Number(row.revision_no),
      parentNodeId: nullableNumber(row.parent_node_id),
      seq: Number(row.seq),
      nodeKind: row.node_kind,
      objectType: row.object_type,
      name: row.name,
      detailCode: row.detail_code,
      position: row.position,
      designation: row.designation,
      quantity: nullableNumber(row.quantity),
      cumulativeQuantity: nullableNumber(row.cumulative_quantity),
      lengthMm: nullableNumber(row.length_mm),
      widthMm: nullableNumber(row.width_mm),
      heightMm: nullableNumber(row.height_mm),
      thicknessMm: nullableNumber(row.thickness_mm),
      price: nullableNumber(row.price),
      isRectangular: row.is_rectangular ?? null,
      textureOrientation: row.texture_orientation,
      mainMaterialName: row.main_material_name,
      childrenCount: Number(row.children_count),
      rawJson: (row.raw_json ?? {}) as Record<string, unknown>,
      orderLinks: links.rows.map((link) => ({
        orderId: Number(link.order_id),
        orderDetailId: nullableNumber(link.order_detail_id),
        mappingKind: link.mapping_kind,
      })),
    };
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

  async createOrderFromRevision(
    command: CreateOrderFromRevisionCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    if (!this.orderTransactions) {
      throw new ApiError(500, 'BAZIS_ORDER_CREATE_UNAVAILABLE', 'Order transaction service is not configured');
    }

    const requestId = requestIdOrFallback(command.requestId, 'bazis-create-order');
    const idempotency = await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      return reconcileCreateOrderIdempotency(tx, command);
    });
    if (idempotency.completedResponse) {
      return idempotency.completedResponse;
    }

    try {
      const revision = await this.loadRevisionProject(command.revisionId);
      if (!revision) {
        await this.failCreateOrderIdempotency(command);
        throw new BazisRevisionNotFoundError(command.revisionId);
      }
      if (revision.projectClientId !== command.clientId) {
        await this.failCreateOrderIdempotency(command);
        throw new ApiError(
          422,
          'VALIDATION_ERROR',
          'Клиент заказа должен совпадать с клиентом проекта Базис',
          {
            errors: [{ field: 'clientId', message: 'Клиент заказа должен совпадать с клиентом проекта Базис' }],
          },
        );
      }

      const panels = await this.loadSelectedPanels(command.revisionId, command.selectedNodeIds);
      if (panels.length === 0) {
        await this.failCreateOrderIdempotency(command);
        throw new BazisNoPanelsSelectedError();
      }

      const mappings = await this.loadMaterialMappingsForPanels(panels);
      const unmappedSheetNames = collectUnmappedSheetNames(panels, mappings);
      if (unmappedSheetNames.length > 0) {
        await this.failCreateOrderIdempotency(command);
        throw new BazisUnmappedMaterialsError(unmappedSheetNames);
      }
      const dto = buildOrderCreateDto(command, revision, panels, mappings);
      let response: CreateOrderFromRevisionResponseDto | null = null;

      await this.orderTransactions.create({
        currentUser: command.currentUser,
        requestId,
        dto,
        postPersistHook: async (uow, created) => {
          response = await this.runCreateOrderHook({
            tx: uow.getTransactionClient(),
            requestId,
            command,
            revision,
            panels,
            created,
          });
        },
      });

      if (!response) {
        throw new ApiError(500, 'BAZIS_ORDER_CREATE_FAILED', 'Не удалось сохранить результат создания заказа');
      }

      return response;
    } catch (error) {
      await this.failCreateOrderIdempotency(command);
      throw error;
    }
  }

  private async loadRevisionProject(revisionId: number): Promise<{
    revisionId: number;
    bazisProjectId: number;
    projectId: number;
    bazisProjectName: string;
    projectClientId: number | null;
  } | null> {
    const result = await this.database.query<RevisionProjectRow>(
      `
      SELECT r.bazis_revision_id,
             r.bazis_project_id,
             bp.project_id,
             bp.name AS bazis_project_name,
             p.client_id AS project_client_id
      FROM bazis_project_revisions r
      JOIN bazis_projects bp ON bp.bazis_project_id = r.bazis_project_id
      LEFT JOIN projects p ON p.project_id = bp.project_id
      WHERE r.bazis_revision_id = $1
      `,
      [revisionId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (row.project_id == null) {
      throw new BazisReferenceNotFoundError('projectId');
    }
    return {
      revisionId: Number(row.bazis_revision_id),
      bazisProjectId: Number(row.bazis_project_id),
      projectId: Number(row.project_id),
      bazisProjectName: row.bazis_project_name,
      projectClientId: nullableNumber(row.project_client_id),
    };
  }

  private async loadSelectedPanels(
    revisionId: number,
    selectedNodeIds: readonly number[],
  ): Promise<Array<{
    bazisNodeId: number;
    name: string | null;
    position: string | null;
    designation: string | null;
    cumulativeQuantity: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    mainMaterialName: string | null;
    rawJson: Record<string, unknown> | null;
  }>> {
    const result = await this.database.query<SelectedPanelRow>(
      `
      WITH RECURSIVE sel AS (
        SELECT n.*
        FROM bazis_nodes n
        WHERE n.revision_id = $1
          AND n.bazis_node_id = ANY($2::bigint[])
        UNION
        SELECT n.*
        FROM bazis_nodes n
        JOIN sel s ON n.parent_node_id = s.bazis_node_id
        WHERE n.revision_id = $1
      )
      SELECT DISTINCT
             bazis_node_id,
             object_type,
             name,
             position,
             designation,
             cumulative_quantity,
             length_mm,
             width_mm,
             main_material_name,
             raw_json
      FROM sel
      WHERE object_type = 'Панель'
      ORDER BY bazis_node_id
      `,
      [revisionId, [...new Set(selectedNodeIds)]],
    );

    return result.rows.map((row) => ({
      bazisNodeId: Number(row.bazis_node_id),
      name: row.name,
      position: row.position,
      designation: row.designation,
      cumulativeQuantity: nullableNumber(row.cumulative_quantity),
      lengthMm: nullableNumber(row.length_mm),
      widthMm: nullableNumber(row.width_mm),
      mainMaterialName: row.main_material_name,
      rawJson: row.raw_json ?? null,
    }));
  }

  private async loadMaterialMappingsForPanels(
    panels: ReadonlyArray<{
      mainMaterialName: string | null;
      rawJson: Record<string, unknown> | null;
    }>,
  ): Promise<Map<string, MaterialLookupRow>> {
    const pairs = new Map<string, { sourceKind: string; name: string }>();

    for (const panel of panels) {
      if (panel.mainMaterialName) {
        const lowered = panel.mainMaterialName.toLowerCase();
        pairs.set(`sheet:${lowered}`, { sourceKind: 'sheet', name: lowered });
      }
      for (const filmName of extractFilmNames(panel.rawJson)) {
        const lowered = filmName.toLowerCase();
        pairs.set(`film:${lowered}`, { sourceKind: 'film', name: lowered });
      }
    }

    if (pairs.size === 0) {
      return new Map();
    }

    const rows = await this.database.query<MaterialLookupRow>(
      `
      SELECT source_kind,
             lower(bazis_name) AS name,
             target_kind,
             sheet_material_type_id,
             film_id,
             edge_type_id
      FROM bazis_material_mappings
      WHERE (source_kind, lower(bazis_name)) IN
            (SELECT unnest($1::text[]), unnest($2::text[]))
      `,
      [
        [...pairs.values()].map((pair) => pair.sourceKind),
        [...pairs.values()].map((pair) => pair.name),
      ],
    );

    return new Map(rows.rows.map((row) => [`${row.source_kind}:${row.name}`, row]));
  }

  private async runCreateOrderHook(input: {
    tx: TransactionClient;
    requestId: string;
    command: CreateOrderFromRevisionCommand;
    revision: {
      revisionId: number;
      bazisProjectId: number;
      projectId: number;
      bazisProjectName: string;
    };
    panels: ReadonlyArray<{ bazisNodeId: number }>;
    created: { orderId: number; detailIdsByClientKey: Map<string, number> };
  }): Promise<CreateOrderFromRevisionResponseDto> {
    for (const panel of input.panels) {
      await input.tx.query(
        `
        INSERT INTO bazis_node_order_detail_map (node_id, order_detail_id, order_id, mapping_kind)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (node_id, order_id) DO NOTHING
        `,
        [
          panel.bazisNodeId,
          input.created.detailIdsByClientKey.get(clientKeyForNode(panel.bazisNodeId)) ?? null,
          input.created.orderId,
          'created',
        ],
      );
    }

    await input.tx.query(
      `
      INSERT INTO bazis_order_links (bazis_project_id, order_id, revision_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (bazis_project_id, order_id) DO NOTHING
      `,
      [input.revision.bazisProjectId, input.created.orderId, input.revision.revisionId],
    );

    const mappedNodes = input.panels.filter((panel) =>
      input.created.detailIdsByClientKey.has(clientKeyForNode(panel.bazisNodeId)),
    ).length;
    const response: CreateOrderFromRevisionResponseDto = {
      orderId: input.created.orderId,
      orderName: input.command.orderName,
      detailsCreated: input.panels.length,
      mappedNodes,
      requestId: input.requestId,
    };
    const auditId = await auditService.record(input.tx, {
      event: 'bazis.order_created',
      entityType: 'order',
      entityId: String(input.created.orderId),
      actorUserId: input.command.currentUser.id,
      actorUsername: input.command.currentUser.username,
      actorRole: input.command.currentUser.role,
      requestId: input.requestId,
      source: SOURCE,
      relatedOrderId: input.created.orderId,
      relatedClientId: input.command.clientId,
      before: {},
      after: { ...response },
      metadata: {
        panelsSelected: input.panels.length,
        detailsCreated: input.panels.length,
        revisionId: input.revision.revisionId,
      },
      relatedEntities: [
        { entityType: 'project', entityId: input.revision.projectId },
        { entityType: 'bazis_project', entityId: input.revision.bazisProjectId },
        { entityType: 'bazis_revision', entityId: input.revision.revisionId },
      ],
    });
    response.auditId = auditId;

    await input.tx.query(
      `
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        'bazis.order_created',
        'order',
        String(input.created.orderId),
        JSON.stringify({
          eventType: 'bazis.order_created',
          orderId: input.created.orderId,
          bazisProjectId: input.revision.bazisProjectId,
          revisionId: input.revision.revisionId,
          actorUserId: input.command.currentUser.id,
          requestId: input.requestId,
        }),
        `bazis-order-created-${input.command.idempotencyKey}`,
      ],
    );

    await completeCreateOrderIdempotency(input.tx, input.command.idempotencyKey, response);
    return response;
  }

  private async failCreateOrderIdempotency(command: CreateOrderFromRevisionCommand): Promise<void> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      await markCreateOrderIdempotencyFailed(tx, command.idempotencyKey);
    }).catch(() => undefined);
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

function clientKeyForNode(bazisNodeId: number): string {
  return `bazis-node-${bazisNodeId}`;
}

/**
 * Variant B: sheet_material_type_id обязателен у каждой детали. Панель без
 * действующего sheet-маппинга (нет строки, target=ignore, нет имени материала)
 * не может стать деталью заказа — собираем имена для 422 до create.
 */
function collectUnmappedSheetNames(
  panels: ReadonlyArray<{ mainMaterialName: string | null }>,
  mappings: Map<string, MaterialLookupRow>,
): string[] {
  const names = new Set<string>();
  for (const panel of panels) {
    if (!panel.mainMaterialName) {
      names.add('(панель без материала)');
      continue;
    }
    const mapping = mappings.get(`sheet:${panel.mainMaterialName.toLowerCase()}`);
    if (mapping?.target_kind !== 'sheet' || mapping.sheet_material_type_id == null) {
      names.add(panel.mainMaterialName);
    }
  }
  return [...names];
}

function buildOrderCreateDto(
  command: CreateOrderFromRevisionCommand,
  revision: { projectId: number; bazisProjectName: string },
  panels: ReadonlyArray<{
    bazisNodeId: number;
    name: string | null;
    position: string | null;
    designation: string | null;
    cumulativeQuantity: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    mainMaterialName: string | null;
    rawJson: Record<string, unknown> | null;
  }>,
  mappings: Map<string, MaterialLookupRow>,
): SaveOrderDto {
  const orderDate = new Date().toISOString().slice(0, 10);
  const details: SaveOrderDetailDto[] = panels.map((panel) => {
    const filmNames = extractFilmNames(panel.rawJson);
    const uniqueFilmNames = [...new Set(filmNames.map((name) => name.toLowerCase()))];
    const filmMapping =
      uniqueFilmNames.length === 1 ? mappings.get(`film:${uniqueFilmNames[0]}`) : undefined;
    const sheetMapping = panel.mainMaterialName
      ? mappings.get(`sheet:${panel.mainMaterialName.toLowerCase()}`)
      : undefined;

    return {
      clientKey: clientKeyForNode(panel.bazisNodeId),
      detailName: panel.name,
      height: panel.lengthMm ?? 0,
      width: panel.widthMm ?? 0,
      quantity: panel.cumulativeQuantity ?? 0,
      materialId: null,
      sheetMaterialTypeId:
        sheetMapping?.target_kind === 'sheet' ? nullableNumber(sheetMapping.sheet_material_type_id) : null,
      millingTypeId: 1,
      edgeTypeId: 1,
      filmId: filmMapping?.target_kind === 'film' ? nullableNumber(filmMapping.film_id) : null,
      priority: 100,
      basisProject: revision.bazisProjectName,
      basisDesignation: panel.designation,
      basisData: `${panel.position ?? ''}/${panel.designation ?? ''}/${panel.name ?? ''}`,
    };
  });

  return {
    header: {
      projectId: revision.projectId,
      orderName: command.orderName,
      clientId: command.clientId,
      orderDate,
      orderStatusId: command.orderStatusId,
    },
    details,
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
  };
}

function extractFilmNames(rawJson: Record<string, unknown> | null): string[] {
  if (!rawJson) {
    return [];
  }

  const result: string[] = [];
  for (const faceKey of ['ОблицовкаПласти1', 'ОблицовкаПласти2']) {
    const face = rawJson[faceKey];
    if (typeof face !== 'object' || face === null) {
      continue;
    }
    const plasti = (face as Record<string, unknown>)['Пласть'];
    const list = Array.isArray(plasti) ? plasti : plasti ? [plasti] : [];
    for (const plast of list) {
      if (typeof plast !== 'object' || plast === null) {
        continue;
      }
      const value = (plast as Record<string, unknown>)['Наименование'];
      if (typeof value === 'string' && value.trim().length > 0) {
        result.push(value.trim());
      }
    }
  }

  return result;
}

async function reconcileCreateOrderIdempotency(
  tx: TransactionClient,
  command: CreateOrderFromRevisionCommand,
): Promise<{ completedResponse?: CreateOrderFromRevisionResponseDto }> {
  const requestHash = hashRequest({
    revisionId: command.revisionId,
    clientId: command.clientId,
    orderName: command.orderName,
    orderStatusId: command.orderStatusId,
    selectedNodeIds: [...command.selectedNodeIds].sort((left, right) => left - right),
    actorUserId: numericUserId(command.currentUser),
    commandName: COMMAND_NAME,
  });

  const inserted = await tx.query<CreateOrderIdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status, created_at
    `,
    [command.idempotencyKey, COMMAND_NAME, numericUserId(command.currentUser), 'bazis_create_order', 'pending', requestHash],
  );

  if (inserted.rows[0]) {
    return {};
  }

  const existing = await tx.query<CreateOrderIdempotencyRow>(
    `
    SELECT idempotency_key, request_hash, response_json, status, created_at
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [command.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new BazisIdempotencyInProgressError();
  }
  if (row.request_hash !== requestHash) {
    throw new BazisIdempotencyKeyReusedError();
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredCreateOrderResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new BazisIdempotencyFailedError();
  }
  if (row.status === 'processing') {
    const ageMs = Date.now() - Date.parse(row.created_at);
    if (Number.isFinite(ageMs) && ageMs >= STALE_PROCESSING_MS) {
      await markCreateOrderIdempotencyFailed(tx, command.idempotencyKey);
      throw new ApiError(
        409,
        'BAZIS_IDEMPOTENCY_FAILED',
        'Предыдущее выполнение зависло, повторите с новым ключом',
      );
    }
    throw new BazisIdempotencyInProgressError();
  }

  throw new BazisIdempotencyInProgressError();
}

async function completeCreateOrderIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: CreateOrderFromRevisionResponseDto,
): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed',
        response_json = $2::jsonb,
        completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function markCreateOrderIdempotencyFailed(
  tx: TransactionClient,
  idempotencyKey: string,
): Promise<void> {
  // Только из 'processing': заказ мог закоммититься вместе с complete (status='completed'),
  // а упасть уже post-commit (deadline sync). Перетирание completed→failed заставило бы
  // клиента взять новый ключ и создать дубль заказа; replay по completed — контракт R3.
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'failed'
    WHERE idempotency_key = $1
      AND status = 'processing'
    `,
    [idempotencyKey],
  );
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
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

function parseStoredCreateOrderResponse(
  responseJson: CreateOrderFromRevisionResponseDto | string,
): CreateOrderFromRevisionResponseDto {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as CreateOrderFromRevisionResponseDto)
    : responseJson;
}
