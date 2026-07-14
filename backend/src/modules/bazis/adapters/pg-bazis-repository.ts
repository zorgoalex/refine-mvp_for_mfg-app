import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderTransactionService } from '../../orders/application/order-transaction.service';
import type { OrderDto } from '../../orders/dto/order.dto';
import type { SaveOrderDetailDto, SaveOrderDto } from '../../orders/dto/save-order.dto';
import { PgOrderReadRepository } from '../../orders/adapters/pg-order-read-repository';
import type { ParsedBazisNode } from '../application/bazis-xml-parser';
import type {
  AddToOrderCommand,
  BazisRepositoryPort,
  BuildOrderDraftCommand,
  CreateOrderFromDraftCommand,
  CreateOrderFromRevisionCommand,
  DeleteBazisProjectInput,
  ImportRevisionCommand,
  SetNodeNotesInput,
} from '../application/bazis.types';
import {
  buildDraftDetails,
  clientKeyForNode,
  collectUnmappedSheetNames,
  computeTargetOrderDuplicates,
  orderDtoToSaveDto,
} from './bazis-order-draft';
import type {
  BazisAddToOrderResponseDto,
  BazisRevisionEstimateDto,
  BazisImportResponseDto,
  BazisOrderDraftResponseDto,
  BazisProjectDeleteResponseDto,
  BazisNodeCardDto,
  BazisNodeNotesDto,
  BazisNodeSearchItemDto,
  BazisNodeSearchResponseDto,
  BazisProjectCardDto,
  BazisProjectListItemDto,
  BazisRevisionMaterialsSummaryDto,
  BazisRevisionOrderDto,
  BazisTreeNodeDto,
  CreateOrderFromRevisionResponseDto,
  MaterialMappingDto,
  UpsertMaterialMappingDto,
} from '../dto/bazis.dto';
import {
  BazisAddToOrderConflictError,
  BazisIdempotencyFailedError,
  BazisUnmappedMaterialsError,
  BazisIdempotencyInProgressError,
  BazisIdempotencyKeyReusedError,
  BazisNodeNotFoundError,
  BazisNoPanelsSelectedError,
  BazisProjectHasOrdersError,
  BazisProjectNotFoundError,
  BazisRevisionNotFoundError,
  BazisReferenceNotFoundError,
  BazisRevisionDuplicateError,
} from '../errors/bazis.errors';

const SOURCE = 'backend-bazis-command';
export const MAX_BAZIS_REVISIONS_PER_PROJECT = 3;
const CREATE_ORDER_FROM_REVISION_COMMAND_NAME = 'bazis.create_order';
const CREATE_ORDER_FROM_DRAFT_COMMAND_NAME = 'bazis.create_order_from_draft';
const ADD_TO_ORDER_COMMAND_NAME = 'bazis.add_to_order';
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// raw_json — plain jsonb без shape-constraint: legacy/битая строка не должна
// валить endpoint. Каждый источник — под jsonb_typeof-guard.
const jsonArrayOrEmpty = (expression: string): string =>
  `CASE WHEN jsonb_typeof(${expression}) = 'array' THEN ${expression} ELSE '[]'::jsonb END`;

// Число кромок панели = записи «Кромка» по 4 контейнерам (зеркало FE parseNodeRaw.edges).
const EDGE_COUNT_SQL = `(
    jsonb_array_length(${jsonArrayOrEmpty(`n.raw_json->'СписокКромок1'->'Кромка'`)})
  + jsonb_array_length(${jsonArrayOrEmpty(`n.raw_json->'СписокКромок2'->'Кромка'`)})
  + jsonb_array_length(${jsonArrayOrEmpty(`n.raw_json->'СписокКромок3'->'Кромка'`)})
  + jsonb_array_length(${jsonArrayOrEmpty(`n.raw_json->'СписокКромок4'->'Кромка'`)})
)::int`;

// Присадка = есть записи отверстий: контейнер «Отверстия->Отверстие» + прямой
// массив «Отверстие» (fallback, зеркало parseNodeRaw.holes).
const HAS_DRILLING_SQL = `(
    jsonb_array_length(${jsonArrayOrEmpty(`n.raw_json->'Отверстия'->'Отверстие'`)})
  + jsonb_array_length(${jsonArrayOrEmpty(`n.raw_json->'Отверстие'`)})
) > 0`;

// Общий SELECT-фрагмент для ОБОИХ tree-запросов (getTreeChildren + listAllTreeNodes).
const TREE_NODE_EXTRA_SELECT = `n.notes,
             ${EDGE_COUNT_SQL} AS edge_count,
             ${HAS_DRILLING_SQL} AS has_drilling`;

interface PruneCandidateRow {
  bazis_revision_id: number | string;
  revision_no: number | string;
  file_name: string | null;
  file_size: number | string | null;
  xml_sha256: string;
  bazis_version: string | null;
  product_name: string | null;
  product_price: number | string | null;
  summary_json: Record<string, unknown> | null;
  imported_by: number | string | null;
  imported_at: string | null;
  request_id: string | null;
  nodes_count: number | string;
}

interface ProjectListRow {
  bazis_project_id: number | string;
  project_id: number | string;
  name: string;
  revisions_count: number | string;
  last_revision_no: number | string | null;
  last_imported_at: string | null;
  bazis_order_no: string | null;
  linked_order_ids: Array<number | string> | null;
  linked_orders?: Array<{ orderId: number | string; orderName: string | null }> | null;
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
  designation: string | null;
  product_order_no: string | null;
  quantity: number | string | null;
  cumulative_quantity: number | string | null;
  length_mm: number | string | null;
  width_mm: number | string | null;
  thickness_mm: number | string | null;
  main_material_name: string | null;
  notes: string | null;
  edge_count: number | string;
  has_drilling: boolean;
  linked_orders: Array<{ orderId: number | string; orderName: string | null }> | null;
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

interface BazisCommandIdempotencyRow<TResponse = unknown> {
  idempotency_key: string;
  request_hash: string;
  response_json: TResponse | string | null;
  status: string;
  created_at: string;
}

interface RevisionProjectRow {
  bazis_revision_id: number | string;
  bazis_project_id: number | string;
  project_id: number | string;
  bazis_project_name: string;
  revision_bazis_order_no: string | null;
  project_client_id: number | string | null;
  client_name: string | null;
}

interface DraftNodeLookupRow {
  bazis_node_id: number | string;
  object_type: string | null;
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
  product_name: string | null;
  product_order_no: string | null;
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
  notes: string | null;
  raw_json: Record<string, unknown> | null;
  children_count: number | string;
  bazis_project_id: number | string;
  revision_no: number | string;
  project_id: number | string;
}

interface SearchRow {
  bazis_node_id: number | string;
  node_kind: string;
  object_type: string | null;
  name: string | null;
  position: string | null;
  designation: string | null;
  main_material_name: string | null;
  ancestor_id: number | string;
  ancestor_name: string | null;
  depth: number | string;
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

interface PanelsSummaryRow {
  sheet_material_type_name?: string | null;
  main_material_name: string | null;
  panel_count: number | string;
  total_quantity: number | string;
  total_area_m2: number | string;
  target_kind: string | null;
  sheet_material_type_id: number | string | null;
}

interface HardwareSummaryRow {
  name: string | null;
  total_quantity: number | string;
}

interface RawUsageRow {
  total_length_mm?: string | number | null;
  name: string;
  usage_count: number | string;
}

interface RevisionOrderRow {
  order_id: number | string;
  order_name: string | null;
  created_at: string;
  nodes_mapped: number | string;
  details_created: number | string;
}

type BazisOrderTransactions = Pick<OrderTransactionService, 'create'> &
  Partial<Pick<OrderTransactionService, 'update'>>;

export class PgBazisRepository implements BazisRepositoryPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly orderTransactions?: BazisOrderTransactions,
    // Паритет с orders-модулем: SP3 sheet-колонки в read-пути гейтятся тем же
    // BACKEND_SHEET_ORDERS_READS, а не захардкоженным default'ом.
    private readonly sheetOrdersReads: boolean = true,
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
      const bazisOrderNo = command.parsed.bazisOrderNo ?? firstRootProductOrderNo(command.parsed.nodes);

      const revisionRow = await tx.query<{ bazis_revision_id: number | string }>(
        `
        INSERT INTO bazis_project_revisions
          (bazis_project_id, revision_no, file_name, file_size, xml_sha256, raw_xml,
           bazis_version, bazis_order_no, product_name, product_price, summary_json, imported_by, request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
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
          bazisOrderNo,
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

      // Retention: храним максимум MAX_BAZIS_REVISIONS_PER_PROJECT последних
      // ревизий; более старые удаляются жёстко, КРОМЕ ревизий, из которых
      // созданы заказы (provenance деталей не разрушаем). Порядок локов
      // общий с create-order-хуком: revision (FOR UPDATE) → nodes (cascade);
      // links перепроверяются ПОСЛЕ захвата локов свежим снапшотом — окно
      // «link появился между выборкой и удалением» закрыто (Critic R1-1).
      const pruneCandidates = await tx.query<PruneCandidateRow>(
        `
        WITH prune_keep AS (
          SELECT bazis_revision_id
          FROM bazis_project_revisions
          WHERE bazis_project_id = $1
          ORDER BY revision_no DESC
          LIMIT ${MAX_BAZIS_REVISIONS_PER_PROJECT}
        )
        SELECT r.bazis_revision_id, r.revision_no, r.file_name, r.file_size,
               r.xml_sha256, r.bazis_version, r.product_name, r.product_price,
               r.summary_json, r.imported_by, r.imported_at, r.request_id,
               (SELECT count(*) FROM bazis_nodes n
                WHERE n.revision_id = r.bazis_revision_id)::int AS nodes_count
        FROM bazis_project_revisions r
        WHERE r.bazis_project_id = $1
          AND r.bazis_revision_id NOT IN (SELECT bazis_revision_id FROM prune_keep)
        ORDER BY r.revision_no
        FOR UPDATE OF r
        `,
        [bazisProjectId],
      );

      if (pruneCandidates.rows.length > 0) {
        const candidateIds = pruneCandidates.rows.map((row) => Number(row.bazis_revision_id));
        const linked = await tx.query<{ revision_id: number | string }>(
          `
          SELECT DISTINCT revision_id
          FROM bazis_order_links
          WHERE revision_id = ANY($1::bigint[])
          `,
          [candidateIds],
        );
        const protectedIds = new Set(linked.rows.map((row) => Number(row.revision_id)));
        const prunable = pruneCandidates.rows.filter(
          (row) => !protectedIds.has(Number(row.bazis_revision_id)),
        );

        if (prunable.length > 0) {
          const prunedIds = prunable.map((row) => Number(row.bazis_revision_id));
          await tx.query(
            `
            DELETE FROM bazis_import_runs
            WHERE revision_id = ANY($1::bigint[])
            `,
            [prunedIds],
          );
          await tx.query(
            `
            DELETE FROM bazis_project_revisions
            WHERE bazis_revision_id = ANY($1::bigint[])
            `,
            [prunedIds],
          );

          for (const row of prunable) {
            const prunedRevisionId = Number(row.bazis_revision_id);
            const prunedRevisionNo = Number(row.revision_no);
            await auditService.record(tx, {
              event: 'bazis.revision_pruned',
              entityType: 'bazis_revision',
              entityId: String(prunedRevisionId),
              actorUserId: command.currentUser.id,
              actorUsername: command.currentUser.username,
              actorRole: command.currentUser.role,
              requestId,
              source: SOURCE,
              relatedEntities: [
                { entityType: 'project', entityId: projectId ?? 0 },
                { entityType: 'bazis_project', entityId: bazisProjectId },
                { entityType: 'bazis_revision', entityId: prunedRevisionId },
              ],
              // Hard delete: before-снапшот несёт все метаданные ревизии,
              // кроме raw_xml (мегабайты gzip в diff_json не кладём).
              before: {
                revisionId: prunedRevisionId,
                revisionNo: prunedRevisionNo,
                fileName: row.file_name,
                fileSize: nullableNumber(row.file_size),
                xmlSha256: row.xml_sha256,
                bazisVersion: row.bazis_version,
                productName: row.product_name,
                productPrice: nullableNumber(row.product_price),
                summary: row.summary_json ?? {},
                importedBy: nullableNumber(row.imported_by),
                importedAt: row.imported_at,
                importRequestId: row.request_id,
                nodesCount: Number(row.nodes_count ?? 0),
              },
              after: {},
              metadata: {
                source: SOURCE,
                action: 'bazis_revision_prune',
                requestId,
                keepLast: MAX_BAZIS_REVISIONS_PER_PROJECT,
                triggeredByRevisionId: revisionId,
              },
            });
            await tx.query(
              `
              INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
              VALUES ($1,$2,$3,$4::jsonb,$5)
              ON CONFLICT (idempotency_key) DO NOTHING
              `,
              [
                'bazis.revision_pruned',
                'bazis_revision',
                String(prunedRevisionId),
                JSON.stringify({
                  eventType: 'bazis.revision_pruned',
                  revisionId: prunedRevisionId,
                  revisionNo: prunedRevisionNo,
                  bazisProjectId,
                  projectId,
                  actorUserId: command.currentUser.id,
                  requestId,
                }),
                `bazis-revision-pruned-${prunedRevisionId}`,
              ],
            );
            warnings.push(
              `Ревизия №${prunedRevisionNo} удалена: хранятся только ${MAX_BAZIS_REVISIONS_PER_PROJECT} последних ревизии`,
            );
          }
        }
      }

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

  async setNodeNotes(input: SetNodeNotesInput): Promise<BazisNodeNotesDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, input.currentUser.id);
      const requestId = requestIdOrFallback(input.requestId, 'bazis-node-notes');

      // Лочим ТОЛЬКО строку узла (FOR UPDATE OF n): конкурентный prune ревизии
      // каскадно удалит узел — тогда наш SELECT вернёт 0 строк → 404; глобальный
      // порядок локов revision→nodes не нарушаем (ревизию не лочим вовсе).
      const existing = await tx.query<{
        bazis_node_id: number | string;
        notes: string | null;
        revision_id: number | string;
        bazis_project_id: number | string;
        project_id: number | string;
      }>(
        `
        SELECT n.bazis_node_id, n.notes, n.revision_id, r.bazis_project_id, bp.project_id
        FROM bazis_nodes n
        JOIN bazis_project_revisions r ON r.bazis_revision_id = n.revision_id
        JOIN bazis_projects bp ON bp.bazis_project_id = r.bazis_project_id
        WHERE n.bazis_node_id = $1
        FOR UPDATE OF n
        `,
        [input.nodeId],
      );
      if (existing.rows.length === 0) {
        throw new BazisNodeNotFoundError(input.nodeId);
      }
      const row = existing.rows[0];
      const before = row.notes ?? null;
      if (before === input.notes) {
        // No-op short-circuit: без UPDATE/audit/outbox (паттерн cut-сеттеров).
        return { bazisNodeId: input.nodeId, notes: before };
      }

      await tx.query(
        `
        UPDATE bazis_nodes SET notes = $2 WHERE bazis_node_id = $1
        `,
        [input.nodeId, input.notes],
      );

      await auditService.record(tx, {
        event: 'bazis.node_notes_changed',
        entityType: 'bazis_node',
        entityId: String(input.nodeId),
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        requestId,
        source: SOURCE,
        relatedEntities: [
          { entityType: 'project', entityId: Number(row.project_id) },
          { entityType: 'bazis_project', entityId: Number(row.bazis_project_id) },
          { entityType: 'bazis_revision', entityId: Number(row.revision_id) },
        ],
        before: { notes: before },
        after: { notes: input.notes },
        metadata: {
          source: SOURCE,
          action: 'bazis_node_set_notes',
          requestId,
        },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          'bazis.node_notes_changed',
          'bazis_node',
          String(input.nodeId),
          JSON.stringify({
            eventType: 'bazis.node_notes_changed',
            bazisNodeId: input.nodeId,
            bazisRevisionId: Number(row.revision_id),
            bazisProjectId: Number(row.bazis_project_id),
            projectId: Number(row.project_id),
            actorUserId: input.currentUser.id,
            requestId,
          }),
          `bazis-node-notes-${input.nodeId}-${requestId}`,
        ],
      );

      return { bazisNodeId: input.nodeId, notes: input.notes };
    });
  }

  async deleteProject(input: DeleteBazisProjectInput): Promise<BazisProjectDeleteResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, input.currentUser.id);
      const requestId = requestIdOrFallback(input.requestId, 'bazis-delete');
      const bazisProjectId = input.bazisProjectId;

      const existing = await tx.query<{ bazis_project_id: number | string; project_id: number | string; name: string }>(
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
      const projectId = Number(existing.rows[0].project_id);
      const name = existing.rows[0].name;

      const links = await tx.query<{ order_id: number | string }>(
        `
        SELECT order_id
        FROM bazis_order_links
        WHERE bazis_project_id = $1
        ORDER BY order_id
        `,
        [bazisProjectId],
      );
      if (links.rows.length > 0) {
        throw new BazisProjectHasOrdersError(links.rows.map((row) => Number(row.order_id)));
      }

      const counts = await tx.query<{ revisions_count: number | string; nodes_count: number | string }>(
        `
        SELECT (SELECT count(*) FROM bazis_project_revisions WHERE bazis_project_id = $1)::int AS revisions_count,
               (SELECT count(*)
                FROM bazis_nodes n
                JOIN bazis_project_revisions r ON r.bazis_revision_id = n.revision_id
                WHERE r.bazis_project_id = $1)::int AS nodes_count
        `,
        [bazisProjectId],
      );
      const revisionsDeleted = Number(counts.rows[0]?.revisions_count ?? 0);
      const nodesDeleted = Number(counts.rows[0]?.nodes_count ?? 0);

      // bazis_import_runs.revision_id без CASCADE — снять до ревизий.
      await tx.query(
        `
        DELETE FROM bazis_import_runs
        WHERE revision_id IN (SELECT bazis_revision_id FROM bazis_project_revisions WHERE bazis_project_id = $1)
        `,
        [bazisProjectId],
      );
      // bazis_nodes и bazis_node_order_detail_map уходят каскадом от ревизий.
      await tx.query(
        `
        DELETE FROM bazis_project_revisions
        WHERE bazis_project_id = $1
        `,
        [bazisProjectId],
      );
      await tx.query(
        `
        DELETE FROM bazis_projects
        WHERE bazis_project_id = $1
        `,
        [bazisProjectId],
      );

      await auditService.record(tx, {
        event: 'bazis.project_deleted',
        entityType: 'bazis_project',
        entityId: String(bazisProjectId),
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        requestId,
        source: SOURCE,
        relatedEntities: [
          { entityType: 'project', entityId: projectId },
          { entityType: 'bazis_project', entityId: bazisProjectId },
        ],
        before: { bazisProjectId, projectId, name, revisionsDeleted, nodesDeleted },
        after: {},
        metadata: {
          source: SOURCE,
          action: 'bazis_project_delete',
          requestId,
        },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          'bazis.project_deleted',
          'bazis_project',
          String(bazisProjectId),
          JSON.stringify({
            eventType: 'bazis.project_deleted',
            bazisProjectId,
            projectId,
            name,
            actorUserId: input.currentUser.id,
            requestId,
          }),
          `bazis-project-deleted-${bazisProjectId}`,
        ],
      );

      return { bazisProjectId, projectId, name, revisionsDeleted, nodesDeleted };
    });
  }

  async listProjects(filter: { projectId?: number }): Promise<BazisProjectListItemDto[]> {
    const result = await this.database.query<ProjectListRow>(
      `
      SELECT bp.bazis_project_id,
             bp.project_id,
             bp.name,
             COUNT(DISTINCT r_all.bazis_revision_id)::int AS revisions_count,
             MAX(r_all.revision_no)::int AS last_revision_no,
             MAX(r_all.imported_at)::text AS last_imported_at,
             COALESCE(
               rev.bazis_order_no,
               (
                 SELECT NULLIF(trim(n.raw_json->>'Заказ'), '')
                 FROM bazis_nodes n
                 WHERE n.revision_id = rev.bazis_revision_id
                   AND n.parent_node_id IS NULL
                   AND NULLIF(trim(n.raw_json->>'Заказ'), '') IS NOT NULL
                 ORDER BY n.seq
                 LIMIT 1
               )
             ) AS bazis_order_no,
             COALESCE(array_remove(array_agg(DISTINCT bol.order_id), NULL), '{}') AS linked_order_ids,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object('orderId', l.order_id, 'orderName', o.order_name) ORDER BY l.order_id)
               FROM bazis_order_links l
               JOIN orders o ON o.order_id = l.order_id
               WHERE l.bazis_project_id = bp.bazis_project_id
             ), '[]'::jsonb) AS linked_orders
      FROM bazis_projects bp
      LEFT JOIN bazis_project_revisions r_all ON r_all.bazis_project_id = bp.bazis_project_id
      LEFT JOIN LATERAL (
        SELECT r_latest.bazis_revision_id, r_latest.bazis_order_no
        FROM bazis_project_revisions r_latest
        WHERE r_latest.bazis_project_id = bp.bazis_project_id
        ORDER BY r_latest.revision_no DESC, r_latest.imported_at DESC, r_latest.bazis_revision_id DESC
        LIMIT 1
      ) rev ON TRUE
      LEFT JOIN bazis_order_links bol ON bol.bazis_project_id = bp.bazis_project_id
      WHERE ($1::bigint IS NULL OR bp.project_id = $1)
      GROUP BY bp.bazis_project_id, bp.project_id, bp.name, rev.bazis_revision_id, rev.bazis_order_no
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
             COUNT(DISTINCT r_all.bazis_revision_id)::int AS revisions_count,
             MAX(r_all.revision_no)::int AS last_revision_no,
             MAX(r_all.imported_at)::text AS last_imported_at,
             COALESCE(
               rev.bazis_order_no,
               (
                 SELECT NULLIF(trim(n.raw_json->>'Заказ'), '')
                 FROM bazis_nodes n
                 WHERE n.revision_id = rev.bazis_revision_id
                   AND n.parent_node_id IS NULL
                   AND NULLIF(trim(n.raw_json->>'Заказ'), '') IS NOT NULL
                 ORDER BY n.seq
                 LIMIT 1
               )
             ) AS bazis_order_no,
             COALESCE(array_remove(array_agg(DISTINCT bol.order_id), NULL), '{}') AS linked_order_ids,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object('orderId', l.order_id, 'orderName', o.order_name) ORDER BY l.order_id)
               FROM bazis_order_links l
               JOIN orders o ON o.order_id = l.order_id
               WHERE l.bazis_project_id = bp.bazis_project_id
             ), '[]'::jsonb) AS linked_orders
      FROM bazis_projects bp
      LEFT JOIN bazis_project_revisions r_all ON r_all.bazis_project_id = bp.bazis_project_id
      LEFT JOIN LATERAL (
        SELECT r_latest.bazis_revision_id, r_latest.bazis_order_no
        FROM bazis_project_revisions r_latest
        WHERE r_latest.bazis_project_id = bp.bazis_project_id
        ORDER BY r_latest.revision_no DESC, r_latest.imported_at DESC, r_latest.bazis_revision_id DESC
        LIMIT 1
      ) rev ON TRUE
      LEFT JOIN bazis_order_links bol ON bol.bazis_project_id = bp.bazis_project_id
      WHERE bp.bazis_project_id = $1
      GROUP BY bp.bazis_project_id, bp.project_id, bp.name, rev.bazis_revision_id, rev.bazis_order_no
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
             n.detail_code, n.position, n.designation,
             CASE WHEN n.parent_node_id IS NULL THEN NULLIF(trim(n.raw_json->>'Заказ'), '') ELSE NULL END AS product_order_no,
             n.quantity, n.cumulative_quantity,
             n.length_mm, n.width_mm, n.thickness_mm, n.main_material_name,
             ${TREE_NODE_EXTRA_SELECT},
             (SELECT jsonb_agg(DISTINCT jsonb_build_object('orderId', m.order_id, 'orderName', o.order_name))
              FROM bazis_node_order_detail_map m
              JOIN orders o ON o.order_id = m.order_id
              WHERE m.node_id = n.bazis_node_id
                AND m.order_detail_id IS NOT NULL) AS linked_orders,
             (SELECT count(*) FROM bazis_nodes c WHERE c.parent_node_id = n.bazis_node_id)::int AS children_count
      FROM bazis_nodes n
      WHERE n.revision_id = $1 AND n.parent_node_id IS NOT DISTINCT FROM $2
      ORDER BY n.seq
      `,
      [revisionId, parentNodeId],
    );

    if (result.rows.length === 0) {
      // Пустой результат ПОСЛЕ чтения: либо легитимно пустой контейнер, либо
      // ревизию удалил retention-prune. Проверка существования вторым
      // statement'ом (свежий снапшот READ COMMITTED) закрывает TOCTOU: prune,
      // закоммитившийся между чтениями, даёт 404, а не тихое пустое дерево
      // (Critic R1-3/R2). Непустой результат существование доказывает сам.
      await this.assertRevisionExists(revisionId);
    }

    return result.rows.map(mapTreeNodeRow);
  }

  async listAllTreeNodes(revisionId: number): Promise<BazisTreeNodeDto[]> {
    await this.assertRevisionExists(revisionId);

    const result = await this.database.query<TreeNodeRow>(
      `
      SELECT n.bazis_node_id, n.parent_node_id, n.seq, n.node_kind, n.object_type, n.name,
             n.detail_code, n.position, n.designation,
             CASE WHEN n.parent_node_id IS NULL THEN NULLIF(trim(n.raw_json->>'Заказ'), '') ELSE NULL END AS product_order_no,
             n.quantity, n.cumulative_quantity,
             n.length_mm, n.width_mm, n.thickness_mm, n.main_material_name,
             ${TREE_NODE_EXTRA_SELECT},
             (SELECT jsonb_agg(DISTINCT jsonb_build_object('orderId', m.order_id, 'orderName', o.order_name))
              FROM bazis_node_order_detail_map m
              JOIN orders o ON o.order_id = m.order_id
              WHERE m.node_id = n.bazis_node_id
                AND m.order_detail_id IS NOT NULL) AS linked_orders,
             (SELECT count(*) FROM bazis_nodes c
              WHERE c.parent_node_id = n.bazis_node_id
                AND c.revision_id = n.revision_id)::int AS children_count
      FROM bazis_nodes n
      WHERE n.revision_id = $1
      ORDER BY n.parent_node_id NULLS FIRST, n.seq
      `,
      [revisionId],
    );

    return result.rows.map(mapTreeNodeRow);
  }

  async getNodeCard(nodeId: number): Promise<BazisNodeCardDto> {
    const nodeResult = await this.database.query<NodeCardRow>(
      `
      SELECT n.bazis_node_id, n.revision_id, n.parent_node_id, n.seq, n.node_kind, n.object_type,
             n.name, n.detail_code, n.position, n.designation, n.quantity, n.cumulative_quantity,
             n.length_mm, n.width_mm, n.height_mm, n.thickness_mm, n.price, n.is_rectangular,
             n.texture_orientation, n.main_material_name, n.notes, n.raw_json,
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
      notes: row.notes,
      childrenCount: Number(row.children_count),
      rawJson: (row.raw_json ?? {}) as Record<string, unknown>,
      orderLinks: links.rows.map((link) => ({
        orderId: Number(link.order_id),
        orderDetailId: nullableNumber(link.order_detail_id),
        mappingKind: link.mapping_kind,
      })),
    };
  }

  async searchNodes(input: {
    revisionId: number;
    q: string | null;
    objectType: string | null;
    limit: number;
  }): Promise<BazisNodeSearchResponseDto> {
    await this.assertRevisionExists(input.revisionId);

    const pattern = input.q == null
      ? null
      : `%${input.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

    const matchPredicate = `
      n.revision_id = $1
      AND ($2::text IS NULL OR n.object_type = $2)
      AND ($3::text IS NULL
        OR n.name ILIKE $3 OR n.detail_code ILIKE $3 OR n.position ILIKE $3
        OR n.designation ILIKE $3 OR n.main_material_name ILIKE $3)
    `;

    const countResult = await this.database.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM bazis_nodes n WHERE ${matchPredicate}`,
      [input.revisionId, input.objectType, pattern],
    );

    const result = await this.database.query<SearchRow>(
      `
      WITH RECURSIVE matches AS (
        SELECT n.bazis_node_id, n.node_kind, n.object_type, n.name, n.position,
               n.designation, n.main_material_name, n.seq
        FROM bazis_nodes n
        WHERE ${matchPredicate}
        ORDER BY n.bazis_node_id
        LIMIT $4
      ),
      ancestry AS (
        SELECT m.bazis_node_id AS match_id, n.bazis_node_id, n.parent_node_id,
               n.name, n.object_type, n.node_kind, 0 AS depth,
               ARRAY[n.bazis_node_id] AS visited
        FROM matches m
        JOIN bazis_nodes n ON n.bazis_node_id = m.bazis_node_id
        UNION ALL
        SELECT a.match_id, p.bazis_node_id, p.parent_node_id,
               p.name, p.object_type, p.node_kind, a.depth + 1,
               a.visited || p.bazis_node_id
        FROM ancestry a
        JOIN bazis_nodes p ON p.bazis_node_id = a.parent_node_id
        WHERE p.revision_id = $1
          AND NOT p.bazis_node_id = ANY(a.visited)
          AND a.depth < 100
      )
      SELECT m.bazis_node_id, m.node_kind, m.object_type, m.name, m.position,
             m.designation, m.main_material_name,
             a.bazis_node_id AS ancestor_id, a.name AS ancestor_name, a.depth
      FROM matches m
      JOIN ancestry a ON a.match_id = m.bazis_node_id
      ORDER BY m.bazis_node_id, a.depth DESC
      `,
      [input.revisionId, input.objectType, pattern, input.limit],
    );

    const itemsById = new Map<number, BazisNodeSearchItemDto>();
    for (const row of result.rows) {
      const matchId = Number(row.bazis_node_id);
      let item = itemsById.get(matchId);
      if (!item) {
        item = {
          bazisNodeId: matchId,
          nodeKind: row.node_kind,
          objectType: row.object_type,
          name: row.name,
          position: row.position,
          designation: row.designation,
          mainMaterialName: row.main_material_name,
          pathNodeIds: [],
          pathTitles: [],
        };
        itemsById.set(matchId, item);
      }
      // depth DESC → первым приходит корень; depth 0 — сам узел, в путь не входит
      if (Number(row.depth) > 0) {
        item.pathNodeIds.push(Number(row.ancestor_id));
        item.pathTitles.push(row.ancestor_name);
      }
    }

    return { items: [...itemsById.values()], totalMatched: Number(countResult.rows[0]?.total ?? 0) };
  }

  async getMaterialsSummary(revisionId: number): Promise<BazisRevisionMaterialsSummaryDto> {
    const revision = await this.database.query<{ summary_json: Record<string, number> | null }>(
      `SELECT summary_json FROM bazis_project_revisions WHERE bazis_revision_id = $1`,
      [revisionId],
    );
    if (revision.rows.length === 0) {
      throw new BazisRevisionNotFoundError(revisionId);
    }

    const panels = await this.database.query<PanelsSummaryRow>(
      `
      SELECT n.main_material_name,
             count(*)::int AS panel_count,
             COALESCE(SUM(COALESCE(n.cumulative_quantity, n.quantity, 1)), 0)::float8 AS total_quantity,
             (COALESCE(SUM(COALESCE(n.length_mm, 0) * COALESCE(n.width_mm, 0)
               * COALESCE(n.cumulative_quantity, n.quantity, 1)), 0) / 1000000.0)::float8 AS total_area_m2,
             mm.target_kind, mm.sheet_material_type_id,
             smt.name AS sheet_material_type_name
      FROM bazis_nodes n
      LEFT JOIN bazis_material_mappings mm
        ON mm.source_kind = 'sheet' AND lower(mm.bazis_name) = lower(n.main_material_name)
      LEFT JOIN sheet_material_types smt
        ON smt.sheet_material_type_id = mm.sheet_material_type_id
      WHERE n.revision_id = $1 AND n.object_type = 'Панель'
      GROUP BY n.main_material_name, mm.target_kind, mm.sheet_material_type_id, smt.name
      ORDER BY panel_count DESC, n.main_material_name
      `,
      [revisionId],
    );

    const hardware = await this.database.query<HardwareSummaryRow>(
      `
      SELECT n.name,
             COALESCE(SUM(COALESCE(n.cumulative_quantity, n.quantity, 1)), 0)::float8 AS total_quantity
      FROM bazis_nodes n
      WHERE n.revision_id = $1 AND n.object_type = 'Фурнитура'
      GROUP BY n.name
      ORDER BY total_quantity DESC, n.name
      `,
      [revisionId],
    );

    const edges = await this.database.query<RawUsageRow>(
      `
      SELECT e.elem->>'Наименование' AS name, count(*)::int AS usage_count,
             SUM(
               CASE WHEN e.elem->>'Длина' ~ '^[0-9]+([.,][0-9]+)?$'
                    THEN replace(e.elem->>'Длина', ',', '.')::numeric
                    ELSE 0 END
             )::float8 AS total_length_mm
      FROM bazis_nodes n
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements(
          ${jsonArrayOrEmpty(`n.raw_json->'СписокКромок1'->'Кромка'`)}
          || ${jsonArrayOrEmpty(`n.raw_json->'СписокКромок2'->'Кромка'`)}
          || ${jsonArrayOrEmpty(`n.raw_json->'СписокКромок3'->'Кромка'`)}
          || ${jsonArrayOrEmpty(`n.raw_json->'СписокКромок4'->'Кромка'`)}
        ) AS elem
      ) e
      WHERE n.revision_id = $1
        AND COALESCE(e.elem->>'Наименование', '') <> ''
      GROUP BY 1
      ORDER BY usage_count DESC, name
      `,
      [revisionId],
    );

    const films = await this.database.query<RawUsageRow>(
      `
      SELECT e.elem->>'Наименование' AS name, count(*)::int AS usage_count
      FROM bazis_nodes n
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements(
          ${jsonArrayOrEmpty(`n.raw_json->'ОблицовкаПласти1'->'Пласть'`)}
          || ${jsonArrayOrEmpty(`n.raw_json->'ОблицовкаПласти2'->'Пласть'`)}
        ) AS elem
      ) e
      WHERE n.revision_id = $1
        AND COALESCE(e.elem->>'Наименование', '') <> ''
      GROUP BY 1
      ORDER BY usage_count DESC, name
      `,
      [revisionId],
    );

    return {
      summary: revision.rows[0].summary_json ?? {},
      panelsByMaterial: panels.rows.map((row) => ({
        materialName: row.main_material_name,
        panelCount: Number(row.panel_count),
        totalQuantity: Number(row.total_quantity),
        totalAreaM2: Number(row.total_area_m2),
        mappingTargetKind: row.target_kind ?? null,
        sheetMaterialTypeId: nullableNumber(row.sheet_material_type_id),
        sheetMaterialTypeName: row.sheet_material_type_name ?? null,
      })),
      hardwareByName: hardware.rows.map((row) => ({
        name: row.name,
        totalQuantity: Number(row.total_quantity),
      })),
      edgesByName: edges.rows.map((row) => ({
        name: row.name,
        usageCount: Number(row.usage_count),
        totalLengthMm: row.total_length_mm != null ? Number(row.total_length_mm) : null,
      })),
      filmsByName: films.rows.map((row) => ({ name: row.name, usageCount: Number(row.usage_count), totalLengthMm: null })),
    };
  }

  async listRevisionOrders(revisionId: number): Promise<BazisRevisionOrderDto[]> {
    await this.assertRevisionExists(revisionId);

    const result = await this.database.query<RevisionOrderRow>(
      `
      SELECT bol.order_id,
             o.order_name,
             bol.created_at::text AS created_at,
             COALESCE(m.nodes_mapped, 0)::int AS nodes_mapped,
             COALESCE(m.details_created, 0)::int AS details_created
      FROM bazis_order_links bol
      JOIN orders o ON o.order_id = bol.order_id
      LEFT JOIN (
        SELECT map.order_id,
               count(*)::int AS nodes_mapped,
               count(*) FILTER (WHERE map.order_detail_id IS NOT NULL)::int AS details_created
        FROM bazis_node_order_detail_map map
        JOIN bazis_nodes n ON n.bazis_node_id = map.node_id
        WHERE n.revision_id = $1
        GROUP BY map.order_id
      ) m ON m.order_id = bol.order_id
      WHERE bol.revision_id = $1
      ORDER BY bol.order_id DESC
      `,
      [revisionId],
    );

    return result.rows.map((row) => ({
      orderId: Number(row.order_id),
      orderName: row.order_name ?? null,
      createdAt: row.created_at,
      nodesMapped: Number(row.nodes_mapped),
      detailsCreated: Number(row.details_created),
    }));
  }

  async getRevisionEstimate(revisionId: number): Promise<BazisRevisionEstimateDto> {
    await this.assertRevisionExists(revisionId);

    // Материалы: ОсновнойМатериал каждого узла (jsonb без shape-constraint —
    // объект проверяем через jsonb_typeof, битые строки не должны 500-ить)
    const materials = await this.database.query<EstimateMaterialRow>(
      `
      SELECT n.bazis_node_id, n.name AS node_name, n.object_type,
             n.raw_json->>'Код' AS node_code,
             'main' AS source,
             m.value->>'ID' AS material_id,
             m.value->>'Код' AS code,
             m.value->>'Наименование' AS name,
             m.value->>'ЕдИзм' AS unit,
             m.value->>'Количество' AS quantity,
             m.value->>'Цена' AS price,
             m.value->>'Стоимость' AS total
      FROM bazis_nodes n
      CROSS JOIN LATERAL (SELECT n.raw_json->'ОсновнойМатериал' AS value) m
      WHERE n.revision_id = $1
        AND jsonb_typeof(n.raw_json->'ОсновнойМатериал') = 'object'
        AND COALESCE(m.value->>'Наименование', '') <> ''
      UNION ALL
      SELECT n.bazis_node_id, n.name AS node_name, n.object_type,
             n.raw_json->>'Код' AS node_code,
             'related' AS source,
             r.value->>'ID' AS material_id,
             r.value->>'Код' AS code,
             r.value->>'Наименование' AS name,
             r.value->>'ЕдИзм' AS unit,
             r.value->>'Количество' AS quantity,
             r.value->>'Цена' AS price,
             r.value->>'Стоимость' AS total
      FROM bazis_nodes n
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(n.raw_json->'СопутствующиеМатериалы'->'СопутствующийМатериал') = 'array'
             THEN n.raw_json->'СопутствующиеМатериалы'->'СопутствующийМатериал'
             ELSE '[]'::jsonb END
      ) AS r(value)
      WHERE n.revision_id = $1
        AND COALESCE(r.value->>'Наименование', '') <> ''
      ORDER BY 1
      `,
      [revisionId],
    );

    const operations = await this.database.query<EstimateOperationRow>(
      `
      SELECT n.bazis_node_id, n.name AS node_name,
             o.value->>'Наименование' AS name,
             o.value->>'Код' AS code,
             o.value->>'ЕдИзм' AS unit,
             o.value->>'Количество' AS quantity,
             o.value->>'Цена' AS price,
             o.value->>'Стоимость' AS total
      FROM bazis_nodes n
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(n.raw_json->'СписокОпераций'->'СдельнаяОперация') = 'array'
             THEN n.raw_json->'СписокОпераций'->'СдельнаяОперация'
             ELSE '[]'::jsonb END
      ) AS o(value)
      WHERE n.revision_id = $1
        AND COALESCE(o.value->>'Наименование', '') <> ''
      ORDER BY n.bazis_node_id
      `,
      [revisionId],
    );

    return {
      materials: materials.rows.map((row) => ({
        nodeId: Number(row.bazis_node_id),
        nodeName: row.node_name,
        nodeObjectType: row.object_type,
        source: row.source === 'related' ? 'related' as const : 'main' as const,
        nodeCode: emptyToNull(row.node_code),
        materialId: emptyToNull(row.material_id),
        code: emptyToNull(row.code),
        name: row.name ?? '',
        unit: emptyToNull(row.unit),
        quantity: parseNumeric(row.quantity),
        price: parseNumeric(row.price),
        total: parseNumeric(row.total),
      })),
      operations: operations.rows.map((row) => ({
        nodeId: Number(row.bazis_node_id),
        nodeName: row.node_name,
        name: row.name ?? '',
        code: emptyToNull(row.code),
        unit: emptyToNull(row.unit),
        quantity: parseNumeric(row.quantity),
        price: parseNumeric(row.price),
        total: parseNumeric(row.total),
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
      return reconcileBazisIdempotency<CreateOrderFromRevisionResponseDto>(tx, {
        currentUser: command.currentUser,
        idempotencyKey: command.idempotencyKey,
        commandName: CREATE_ORDER_FROM_REVISION_COMMAND_NAME,
        requestHash: hashCreateOrderFromRevisionRequestShape(command),
        entityType: 'bazis_create_order',
      });
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
            responseOrderName: command.orderName,
            relatedClientId: command.clientId,
            revision,
            panels,
            created,
            detailsCreated: dto.details.length,
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

  async createOrderFromDraft(
    command: CreateOrderFromDraftCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    if (!this.orderTransactions) {
      throw new ApiError(500, 'BAZIS_ORDER_CREATE_UNAVAILABLE', 'Order transaction service is not configured');
    }

    const requestId = requestIdOrFallback(command.requestId, 'bazis-create-order-from-draft');
    const orderForHash = normalizeDraftOrderForHash(command.order);
    const idempotency = await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      return reconcileBazisIdempotency<CreateOrderFromRevisionResponseDto>(tx, {
        currentUser: command.currentUser,
        idempotencyKey: command.idempotencyKey,
        commandName: CREATE_ORDER_FROM_DRAFT_COMMAND_NAME,
        requestHash: hashCreateOrderFromDraftRequestShape({
          order: orderForHash,
          nodes: command.nodes,
          actorUserId: numericUserId(command.currentUser),
        }),
        entityType: 'bazis_create_order',
      });
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

      const order = sanitizeDraftOrder(command.order, revision.projectId);
      if (revision.projectClientId !== order.header.clientId) {
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

      assertUniqueDraftNodeMappings(command.nodes);
      assertDraftNodeClientKeys(command.nodes, order);

      await this.assertPanelNodesBelongToRevision(
        command.revisionId,
        command.nodes.map((node) => node.bazisNodeId),
        'nodes',
      );
      let response: CreateOrderFromRevisionResponseDto | null = null;
      const clientKeyByNodeId = new Map(command.nodes.map((node) => [node.bazisNodeId, node.clientKey]));

      await this.orderTransactions.create({
        currentUser: command.currentUser,
        requestId,
        dto: order,
        postPersistHook: async (uow, created) => {
          response = await this.runCreateOrderHook({
            tx: uow.getTransactionClient(),
            requestId,
            command,
            responseOrderName: order.header.orderName,
            relatedClientId: order.header.clientId,
            revision,
            panels: command.nodes.map((node) => ({ bazisNodeId: node.bazisNodeId })),
            created,
            detailsCreated: order.details.length,
            clientKeyByNodeId,
            metadataSource: 'panels_draft',
            outboxIdempotencyKey: `bazis-order-created-draft-${created.orderId}`,
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

  async addToOrder(command: AddToOrderCommand): Promise<BazisAddToOrderResponseDto> {
    if (!this.orderTransactions?.update) {
      throw new ApiError(500, 'BAZIS_ADD_TO_ORDER_UNAVAILABLE', 'Order transaction service is not configured');
    }

    assertValidAddToOrderShape(command);

    const requestId = requestIdOrFallback(command.requestId, 'bazis-add-to-order');
    const idempotency = await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      return reconcileBazisIdempotency<BazisAddToOrderResponseDto>(tx, {
        currentUser: command.currentUser,
        idempotencyKey: command.idempotencyKey,
        commandName: ADD_TO_ORDER_COMMAND_NAME,
        requestHash: hashAddToOrderRequestShape(command),
        entityType: 'bazis_add_to_order',
      });
    });
    if (idempotency.completedResponse) {
      return idempotency.completedResponse;
    }

    try {
      const revision = await this.loadRevisionProject(command.revisionId);
      if (!revision) {
        await this.failBazisIdempotency(command.currentUser, command.idempotencyKey);
        throw new BazisRevisionNotFoundError(command.revisionId);
      }

      const currentOrder = await this.loadOrderById(command.currentUser, command.orderId);
      if (!currentOrder || currentOrder.header.clientId !== revision.projectClientId) {
        await this.failBazisIdempotency(command.currentUser, command.idempotencyKey);
        throw validationErrorForField(
          'orderId',
          'Заказ должен существовать и принадлежать клиенту проекта Базис',
        );
      }

      const selectedNodeIds = uniqueNumbers([
        ...command.adds,
        ...command.replaces.map((pair) => pair.bazisNodeId),
      ]);
      await this.assertPanelNodesBelongToRevision(command.revisionId, selectedNodeIds, 'adds');
      const panels = await this.loadSelectedPanels(command.revisionId, selectedNodeIds);
      const panelsByNodeId = new Map(panels.map((panel) => [panel.bazisNodeId, panel] as const));

      const mappings = await this.loadMaterialMappingsForPanels(panels);
      const unmappedSheetNames = collectUnmappedSheetNames(panels, mappings);
      if (unmappedSheetNames.length > 0) {
        await this.failBazisIdempotency(command.currentUser, command.idempotencyKey);
        throw new BazisUnmappedMaterialsError(unmappedSheetNames);
      }

      const merge = buildAddToOrderSaveDto({
        order: currentOrder,
        revision,
        command,
        panelsByNodeId,
        mappings,
      });
      let response: BazisAddToOrderResponseDto | null = null;

      await this.orderTransactions.update({
        currentUser: command.currentUser,
        requestId,
        orderId: command.orderId,
        dto: merge.dto,
        prePersistHook: async (uow) => {
          const conflicts = await detectAddToOrderConflicts({
            db: uow.getTransactionClient(),
            bazisProjectId: revision.bazisProjectId,
            orderId: command.orderId,
            adds: command.adds,
            replaces: command.replaces,
            skips: command.skips,
          });
          if (conflicts) {
            throw new BazisAddToOrderConflictError(conflicts);
          }
        },
        postPersistHook: async (uow, updated) => {
          const tx = uow.getTransactionClient();

          for (const bazisNodeId of command.adds) {
            const clientKey = clientKeyForNode(bazisNodeId);
            const orderDetailId = updated.detailIdsByClientKey.get(clientKey);
            if (!orderDetailId) {
              throw new ApiError(500, 'BAZIS_ADD_TO_ORDER_FAILED', `Detail id missing for ${clientKey}`);
            }
            await upsertBazisNodeOrderDetailMap(tx, {
              bazisNodeId,
              orderDetailId,
              orderId: command.orderId,
            });
          }

          for (const pair of command.replaces) {
            await tx.query(
              `
              DELETE FROM bazis_node_order_detail_map
              WHERE order_id = $1
                AND order_detail_id = $2
              `,
              [command.orderId, pair.orderDetailId],
            );
            await upsertBazisNodeOrderDetailMap(tx, {
              bazisNodeId: pair.bazisNodeId,
              orderDetailId: pair.orderDetailId,
              orderId: command.orderId,
            });
          }

          await tx.query(
            `
            INSERT INTO bazis_order_links (bazis_project_id, order_id, revision_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (bazis_project_id, order_id) DO NOTHING
            `,
            [revision.bazisProjectId, command.orderId, revision.revisionId],
          );

          const auditId = await auditService.record(tx, {
            event: 'bazis.order_details_added',
            entityType: 'order',
            entityId: String(command.orderId),
            actorUserId: command.currentUser.id,
            actorUsername: command.currentUser.username,
            actorRole: command.currentUser.role,
            requestId,
            source: SOURCE,
            relatedOrderId: command.orderId,
            relatedClientId: currentOrder.header.clientId,
            before: { replaced: merge.replacedBefore },
            after: {
              addedNodeIds: command.adds,
              replacedPairs: command.replaces,
              detailsAdded: command.adds.length,
              detailsReplaced: command.replaces.length,
            },
            metadata: {
              revisionId: revision.revisionId,
              bazisProjectId: revision.bazisProjectId,
              idempotencyKey: command.idempotencyKey,
            },
            relatedEntities: [
              { entityType: 'project', entityId: revision.projectId },
              { entityType: 'bazis_project', entityId: revision.bazisProjectId },
              { entityType: 'bazis_revision', entityId: revision.revisionId },
            ],
          });

          await tx.query(
            `
            INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
            VALUES ($1, $2, $3, $4::jsonb, $5)
            ON CONFLICT (idempotency_key) DO NOTHING
            `,
            [
              'bazis.order_details_added',
              'order',
              String(command.orderId),
              JSON.stringify({
                orderId: command.orderId,
                clientId: currentOrder.header.clientId,
                bazisProjectId: revision.bazisProjectId,
                revisionId: revision.revisionId,
                projectId: revision.projectId,
                addedNodeIds: command.adds,
                replacedPairs: command.replaces,
                auditId,
              }),
              `bazis-order-details-added-${command.orderId}-${command.idempotencyKey}`,
            ],
          );

          response = {
            orderId: command.orderId,
            detailsAdded: command.adds.length,
            detailsReplaced: command.replaces.length,
            requestId,
          };
          await completeBazisIdempotency(tx, command.idempotencyKey, response);
        },
      });

      if (!response) {
        throw new ApiError(500, 'BAZIS_ADD_TO_ORDER_FAILED', 'Не удалось сохранить результат добавления панелей');
      }

      return response;
    } catch (error) {
      await this.failBazisIdempotency(command.currentUser, command.idempotencyKey);
      throw error;
    }
  }

  async buildOrderDraft(command: BuildOrderDraftCommand): Promise<BazisOrderDraftResponseDto> {
    const revision = await this.loadRevisionProject(command.revisionId);
    if (!revision) {
      throw new BazisRevisionNotFoundError(command.revisionId);
    }

    const panels = await this.loadSelectedPanels(command.revisionId, command.selectedNodeIds);
    if (panels.length === 0) {
      throw new BazisNoPanelsSelectedError();
    }

    const mappings = await this.loadMaterialMappingsForPanels(panels);
    const unmappedSheetNames = collectUnmappedSheetNames(panels, mappings);
    if (unmappedSheetNames.length > 0) {
      throw new BazisUnmappedMaterialsError(unmappedSheetNames);
    }

    if (command.targetOrderId != null) {
      // Единый read-путь с GET /orders/:id и командой add-to-order (paritет
      // sheet-флагов/delete_flag; отдельного raw-SQL входа в orders нет).
      const targetOrder = await this.loadOrderById(command.currentUser, command.targetOrderId);
      if (!targetOrder || targetOrder.header.clientId !== revision.projectClientId) {
        throw new ApiError(
          422,
          'VALIDATION_ERROR',
          'Целевой заказ должен принадлежать клиенту проекта Базис',
          {
            errors: [
              {
                field: 'targetOrderId',
                message: 'Целевой заказ должен принадлежать клиенту проекта Базис',
              },
            ],
          },
        );
      }
    }

    const details = buildDraftDetails(panels, mappings, revision);
    const duplicates =
      command.targetOrderId == null
        ? []
        : await computeTargetOrderDuplicates(this.database, {
            bazisProjectId: revision.bazisProjectId,
            orderId: command.targetOrderId,
            nodeIds: details.map((detail) => detail.bazisNodeId),
          });

    return {
      revisionId: revision.revisionId,
      projectId: revision.projectId,
      clientId: revision.projectClientId,
      clientName: revision.clientName,
      bazisProjectName: revision.bazisProjectName,
      bazisOrderNo: revision.revisionBazisOrderNo,
      details,
      duplicates,
    };
  }

  private async assertRevisionExists(revisionId: number): Promise<void> {
    const result = await this.database.query<{ ok: number }>(
      `SELECT 1 AS ok FROM bazis_project_revisions WHERE bazis_revision_id = $1`,
      [revisionId],
    );
    if (result.rows.length === 0) {
      throw new BazisRevisionNotFoundError(revisionId);
    }
  }

  private async loadRevisionProject(revisionId: number): Promise<{
    revisionId: number;
    bazisProjectId: number;
    projectId: number;
    bazisProjectName: string;
    revisionBazisOrderNo: string | null;
    projectClientId: number | null;
    clientName: string | null;
  } | null> {
    const result = await this.database.query<RevisionProjectRow>(
      `
      SELECT r.bazis_revision_id,
             r.bazis_project_id,
             bp.project_id,
             bp.name AS bazis_project_name,
             r.bazis_order_no AS revision_bazis_order_no,
             p.client_id AS project_client_id,
             c.client_name
      FROM bazis_project_revisions r
      JOIN bazis_projects bp ON bp.bazis_project_id = r.bazis_project_id
      LEFT JOIN projects p ON p.project_id = bp.project_id
      LEFT JOIN clients c ON c.client_id = p.client_id
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
      revisionBazisOrderNo: row.revision_bazis_order_no,
      projectClientId: nullableNumber(row.project_client_id),
      clientName: row.client_name,
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
    productName: string | null;
    productOrderNo: string | null;
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
      ),
      panels AS (
        SELECT DISTINCT
               s.bazis_node_id,
               s.parent_node_id,
               s.object_type,
               s.name,
               s.position,
               s.designation,
               s.cumulative_quantity,
               s.length_mm,
               s.width_mm,
               s.main_material_name,
               s.raw_json
        FROM sel s
        WHERE s.object_type = 'Панель'
      ),
      panel_ancestry AS (
        SELECT p.bazis_node_id AS panel_id,
               p.bazis_node_id,
               p.parent_node_id,
               p.name,
               p.raw_json,
               0 AS depth,
               ARRAY[p.bazis_node_id] AS visited
        FROM panels p
        UNION ALL
        SELECT a.panel_id,
               parent.bazis_node_id,
               parent.parent_node_id,
               parent.name,
               parent.raw_json,
               a.depth + 1,
               a.visited || parent.bazis_node_id
        FROM panel_ancestry a
        JOIN bazis_nodes parent ON parent.bazis_node_id = a.parent_node_id
        WHERE parent.revision_id = $1
          AND NOT parent.bazis_node_id = ANY(a.visited)
          AND a.depth < 100
      ),
      root_products AS (
        SELECT DISTINCT ON (panel_id)
               panel_id,
               name AS product_name,
               NULLIF(trim(raw_json->>'Заказ'), '') AS product_order_no
        FROM panel_ancestry
        ORDER BY panel_id, depth DESC
      )
      SELECT p.bazis_node_id,
             p.object_type,
             p.name,
             p.position,
             p.designation,
             p.cumulative_quantity,
             p.length_mm,
             p.width_mm,
             p.main_material_name,
             rp.product_name,
             rp.product_order_no,
             p.raw_json
      FROM panels p
      LEFT JOIN root_products rp ON rp.panel_id = p.bazis_node_id
      ORDER BY p.bazis_node_id
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
      productName: row.product_name,
      productOrderNo: row.product_order_no,
      rawJson: row.raw_json ?? null,
    }));
  }

  private async assertPanelNodesBelongToRevision(
    revisionId: number,
    nodeIds: readonly number[],
    field: string,
  ): Promise<void> {
    if (nodeIds.length === 0) {
      return;
    }

    const uniqueNodeIds = [...new Set(nodeIds)];
    const result = await this.database.query<DraftNodeLookupRow>(
      `
      SELECT bazis_node_id, object_type
      FROM bazis_nodes
      WHERE revision_id = $1
        AND bazis_node_id = ANY($2::bigint[])
      ORDER BY bazis_node_id
      `,
      [revisionId, uniqueNodeIds],
    );
    const rows = result.rows.map((row) => ({
      bazisNodeId: Number(row.bazis_node_id),
      objectType: row.object_type,
    }));

    if (rows.length !== uniqueNodeIds.length || rows.some((row) => row.objectType !== 'Панель')) {
      throw validationErrorForField(field, 'Указанные узлы должны быть панелями из выбранной ревизии');
    }
  }

  private async loadOrderById(currentUser: CurrentUser, orderId: number): Promise<OrderDto | null> {
    const reader = new PgOrderReadRepository(this.database, this.sheetOrdersReads);
    return reader.getOrderById({ currentUser, orderId });
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
    command: CreateOrderFromRevisionCommand | CreateOrderFromDraftCommand;
    responseOrderName: string;
    relatedClientId: number;
    revision: {
      revisionId: number;
      bazisProjectId: number;
      projectId: number;
      bazisProjectName: string;
    };
    panels: ReadonlyArray<{ bazisNodeId: number }>;
    created: { orderId: number; detailIdsByClientKey: Map<string, number> };
    detailsCreated: number;
    clientKeyByNodeId?: ReadonlyMap<number, string>;
    metadataSource?: 'panels_draft';
    outboxIdempotencyKey?: string;
  }): Promise<CreateOrderFromRevisionResponseDto> {
    // Единый порядок локов с retention-prune (revision → nodes): сначала
    // KEY SHARE на строку ревизии, потом FK-локи на nodes через map-инсерты.
    // Ревизия исчезла (конкурентный prune) → 404, а не FK-ошибка/deadlock.
    const revisionLock = await input.tx.query<{ bazis_revision_id: number | string }>(
      `
      SELECT bazis_revision_id
      FROM bazis_project_revisions
      WHERE bazis_revision_id = $1
      FOR KEY SHARE
      `,
      [input.revision.revisionId],
    );
    if (revisionLock.rows.length === 0) {
      throw new BazisRevisionNotFoundError(input.revision.revisionId);
    }

    for (const panel of input.panels) {
      const clientKey = input.clientKeyByNodeId?.get(panel.bazisNodeId) ?? clientKeyForNode(panel.bazisNodeId);
      await input.tx.query(
        `
        INSERT INTO bazis_node_order_detail_map (node_id, order_detail_id, order_id, mapping_kind)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (node_id, order_id) DO NOTHING
        `,
        [
          panel.bazisNodeId,
          input.created.detailIdsByClientKey.get(clientKey) ?? null,
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
      input.created.detailIdsByClientKey.has(
        input.clientKeyByNodeId?.get(panel.bazisNodeId) ?? clientKeyForNode(panel.bazisNodeId),
      ),
    ).length;
    const response: CreateOrderFromRevisionResponseDto = {
      orderId: input.created.orderId,
      orderName: input.responseOrderName,
      detailsCreated: input.detailsCreated,
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
      relatedClientId: input.relatedClientId,
      before: {},
      after: { ...response },
      metadata: {
        panelsSelected: input.panels.length,
        detailsCreated: input.detailsCreated,
        revisionId: input.revision.revisionId,
        ...(input.metadataSource ? { source: input.metadataSource } : {}),
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
        input.outboxIdempotencyKey ?? `bazis-order-created-${input.command.idempotencyKey}`,
      ],
    );

    await completeBazisIdempotency(input.tx, input.command.idempotencyKey, response);
    return response;
  }

  private async failCreateOrderIdempotency(
    command: Pick<CreateOrderFromRevisionCommand, 'currentUser' | 'idempotencyKey'>,
  ): Promise<void> {
    await this.failBazisIdempotency(command.currentUser, command.idempotencyKey);
  }

  private async failBazisIdempotency(currentUser: CurrentUser, idempotencyKey: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, currentUser.id);
      await markBazisIdempotencyFailed(tx, idempotencyKey);
    }).catch(() => undefined);
  }
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

function requestIdOrFallback(requestId: string | undefined, fallback: string): string {
  return requestId && requestId.length > 0 ? requestId : fallback;
}

function firstRootProductOrderNo(nodes: ParsedBazisNode[]): string | null {
  for (const node of nodes) {
    if (node.parentIndex === null && node.productOrderNo) {
      return node.productOrderNo;
    }
  }
  return null;
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

interface EstimateMaterialRow {
  bazis_node_id: number | string;
  node_name: string | null;
  object_type: string | null;
  source: string;
  node_code: string | null;
  material_id: string | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  quantity: string | null;
  price: string | null;
  total: string | null;
}

interface EstimateOperationRow {
  bazis_node_id: number | string;
  node_name: string | null;
  name: string | null;
  code: string | null;
  unit: string | null;
  quantity: string | null;
  price: string | null;
  total: string | null;
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Числа из XML-текста ('13800', '0.15', '1 234,5') → number | null */
function parseNumeric(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') {
    return null;
  }
  const parsed = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function mapTreeNodeRow(row: TreeNodeRow): BazisTreeNodeDto {
  return {
    bazisNodeId: Number(row.bazis_node_id),
    parentNodeId: nullableNumber(row.parent_node_id),
    seq: Number(row.seq),
    nodeKind: row.node_kind,
    objectType: row.object_type,
    name: row.name,
    detailCode: row.detail_code,
    position: row.position,
    designation: row.designation,
    productOrderNo: row.product_order_no,
    quantity: nullableNumber(row.quantity),
    cumulativeQuantity: nullableNumber(row.cumulative_quantity),
    lengthMm: nullableNumber(row.length_mm),
    widthMm: nullableNumber(row.width_mm),
    thicknessMm: nullableNumber(row.thickness_mm),
    mainMaterialName: row.main_material_name,
    edgeCount: Number(row.edge_count),
    hasDrilling: Boolean(row.has_drilling),
    notes: row.notes,
    childrenCount: Number(row.children_count),
    orders: (row.linked_orders ?? [])
      .map((entry) => ({ orderId: Number(entry.orderId), orderName: entry.orderName ?? '' }))
      .sort((left, right) => left.orderId - right.orderId),
    orderIds: (row.linked_orders ?? [])
      .map((entry) => Number(entry.orderId))
      .sort((left, right) => left - right),
  };
}

function mapProjectListRow(row: ProjectListRow): BazisProjectListItemDto {
  const linkedOrders = (row.linked_orders ?? []).map((entry) => ({
    orderId: Number(entry.orderId),
    orderName: entry.orderName ?? '',
  }));
  return {
    bazisProjectId: Number(row.bazis_project_id),
    projectId: Number(row.project_id),
    name: row.name,
    revisionsCount: Number(row.revisions_count),
    lastRevisionNo: nullableNumber(row.last_revision_no),
    lastImportedAt: row.last_imported_at,
    bazisOrderNo: row.bazis_order_no,
    linkedOrderIds: (row.linked_order_ids ?? []).map((value) => Number(value)),
    linkedOrders,
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

function buildAddToOrderSaveDto(input: {
  order: OrderDto;
  revision: { bazisProjectName: string; revisionBazisOrderNo: string | null };
  command: AddToOrderCommand;
  panelsByNodeId: ReadonlyMap<
    number,
    {
      bazisNodeId: number;
      name: string | null;
      position: string | null;
      designation: string | null;
      cumulativeQuantity: number | null;
      lengthMm: number | null;
      widthMm: number | null;
      mainMaterialName: string | null;
      productName: string | null;
      productOrderNo: string | null;
      rawJson: Record<string, unknown> | null;
    }
  >;
  mappings: Map<string, MaterialLookupRow>;
}): {
  dto: SaveOrderDto;
  replacedBefore: Array<{
    orderDetailId: number;
    detailName: string | null;
    height: number;
    width: number;
    quantity: number;
    sheetMaterialTypeId: number | null;
    filmId: number | null;
    basisProject: string | null;
    basisProduct: string | null;
    basisDesignation: string | null;
    basisData: string | null;
  }>;
} {
  const merged = orderDtoToSaveDto(input.order);
  const draftDetailsByNodeId = new Map(
    buildDraftDetails(
      uniqueNumbers([
        ...input.command.adds,
        ...input.command.replaces.map((pair) => pair.bazisNodeId),
      ]).map((nodeId) => requirePanel(input.panelsByNodeId, nodeId)),
      input.mappings,
      input.revision,
    ).map((detail) => [detail.bazisNodeId, detail] as const),
  );

  const details = merged.details.map((detail) => ({ ...detail }));
  const detailsById = new Map(
    details
      .filter((detail): detail is SaveOrderDetailDto & { id: number } => typeof detail.id === 'number')
      .map((detail) => [detail.id, detail] as const),
  );
  const replacedBefore: Array<{
    orderDetailId: number;
    detailName: string | null;
    height: number;
    width: number;
    quantity: number;
    sheetMaterialTypeId: number | null;
    filmId: number | null;
    basisProject: string | null;
    basisProduct: string | null;
    basisDesignation: string | null;
    basisData: string | null;
  }> = [];

  for (const pair of input.command.replaces) {
    const target = detailsById.get(pair.orderDetailId);
    if (!target) {
      throw validationErrorForField('replaces', `Деталь заказа ${pair.orderDetailId} не найдена`);
    }
    const next = toSaveDetailFromDraftDetail(draftDetailsByNodeId.get(pair.bazisNodeId), pair.bazisNodeId);
    replacedBefore.push(snapshotReplacedDetail(target));
    target.detailName = next.detailName;
    // Variant B: replace переводит деталь на sheet-режим; висящий legacy
    // materialId валидатор заказа отвергает (material_id is not allowed) —
    // нормализуем явно, а не «наследуем как есть».
    target.materialId = null;
    target.height = next.height;
    target.width = next.width;
    target.quantity = next.quantity;
    target.sheetMaterialTypeId = next.sheetMaterialTypeId;
    target.filmId = next.filmId;
    target.basisProject = next.basisProject;
    target.basisProduct = next.basisProduct;
    target.basisDesignation = next.basisDesignation;
    target.basisData = next.basisData;
  }

  details.push(
    ...input.command.adds.map((bazisNodeId) =>
      toSaveDetailFromDraftDetail(draftDetailsByNodeId.get(bazisNodeId), bazisNodeId),
    ),
  );

  return {
    dto: {
      ...merged,
      details,
      deleted: {
        detailIds: [],
        paymentIds: [],
        workshopIds: [],
        requirementIds: [],
        dowelingLinkIds: [],
      },
    },
    replacedBefore,
  };
}

function buildOrderCreateDto(
  command: CreateOrderFromRevisionCommand,
  revision: { projectId: number; bazisProjectName: string; revisionBazisOrderNo: string | null },
  panels: ReadonlyArray<{
    bazisNodeId: number;
    name: string | null;
    position: string | null;
    designation: string | null;
    cumulativeQuantity: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    mainMaterialName: string | null;
    productName: string | null;
    productOrderNo: string | null;
    rawJson: Record<string, unknown> | null;
  }>,
  mappings: Map<string, MaterialLookupRow>,
): SaveOrderDto {
  const orderDate = new Date().toISOString().slice(0, 10);
  const details: SaveOrderDetailDto[] = buildDraftDetails(panels, mappings, revision).map(
    ({ bazisNodeId: _bazisNodeId, ...detail }) => ({
      ...detail,
      materialId: null,
    }),
  );

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

function sanitizeDraftOrder(order: SaveOrderDto, projectId: number): SaveOrderDto {
  return {
    ...order,
    header: {
      ...order.header,
      projectId,
    },
    idempotencyKey: undefined,
  };
}

function requirePanel<T>(panelsByNodeId: ReadonlyMap<number, T>, bazisNodeId: number): T {
  const panel = panelsByNodeId.get(bazisNodeId);
  if (!panel) {
    throw validationErrorForField('adds', 'Указанные узлы должны быть панелями из выбранной ревизии');
  }
  return panel;
}

function toSaveDetailFromDraftDetail(
  detail: ReturnType<typeof buildDraftDetails>[number] | undefined,
  bazisNodeId: number,
): SaveOrderDetailDto {
  if (!detail) {
    throw validationErrorForField('adds', `Не найдена панель ${bazisNodeId}`);
  }
  const { bazisNodeId: _bazisNodeId, ...rest } = detail;
  return {
    ...rest,
    materialId: null,
  };
}

function snapshotReplacedDetail(detail: SaveOrderDetailDto & { id?: number }): {
  orderDetailId: number;
  detailName: string | null;
  height: number;
  width: number;
  quantity: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  basisProject: string | null;
  basisProduct: string | null;
  basisDesignation: string | null;
  basisData: string | null;
} {
  return {
    orderDetailId: Number(detail.id),
    detailName: detail.detailName ?? null,
    height: detail.height,
    width: detail.width,
    quantity: detail.quantity,
    sheetMaterialTypeId: detail.sheetMaterialTypeId ?? null,
    filmId: detail.filmId ?? null,
    basisProject: detail.basisProject ?? null,
    basisProduct: detail.basisProduct ?? null,
    basisDesignation: detail.basisDesignation ?? null,
    basisData: detail.basisData ?? null,
  };
}

function normalizeDraftOrderForHash(order: SaveOrderDto): SaveOrderDto {
  return {
    ...order,
    header: {
      ...order.header,
      projectId: undefined,
    },
    idempotencyKey: undefined,
  };
}

function assertUniqueDraftNodeMappings(
  nodes: ReadonlyArray<{ clientKey: string; bazisNodeId: number }>,
): void {
  const seenNodeIds = new Set<number>();
  const seenClientKeys = new Set<string>();

  for (const node of nodes) {
    if (seenNodeIds.has(node.bazisNodeId)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Повторяющиеся bazisNodeId в nodes недопустимы', {
        errors: [{ field: 'nodes', message: 'Повторяющиеся bazisNodeId в nodes недопустимы' }],
      });
    }
    if (seenClientKeys.has(node.clientKey)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Повторяющиеся clientKey в nodes недопустимы', {
        errors: [{ field: 'nodes', message: 'Повторяющиеся clientKey в nodes недопустимы' }],
      });
    }
    seenNodeIds.add(node.bazisNodeId);
    seenClientKeys.add(node.clientKey);
  }
}

function assertDraftNodeClientKeys(
  nodes: ReadonlyArray<{ clientKey: string }>,
  order: Pick<SaveOrderDto, 'details'>,
): void {
  const detailClientKeys = new Set(
    order.details
      .map((detail) => detail.clientKey)
      .filter((clientKey): clientKey is string => typeof clientKey === 'string' && clientKey.length > 0),
  );

  for (const node of nodes) {
    if (!detailClientKeys.has(node.clientKey)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Каждый clientKey из nodes должен присутствовать в order.details', {
        errors: [
          {
            field: 'nodes',
            message: 'Каждый clientKey из nodes должен присутствовать в order.details',
          },
        ],
      });
    }
  }
}

function assertValidAddToOrderShape(command: AddToOrderCommand): void {
  if (command.adds.length === 0 && command.replaces.length === 0) {
    throw validationErrorForField('adds', 'Нужно указать хотя бы одну панель в adds или replaces');
  }

  const seenNodeIds = new Set<number>();
  for (const bazisNodeId of command.adds) {
    if (seenNodeIds.has(bazisNodeId)) {
      throw validationErrorForField('adds', 'Повторяющиеся bazisNodeId в adds/replaces/skips недопустимы');
    }
    seenNodeIds.add(bazisNodeId);
  }
  for (const pair of command.replaces) {
    if (seenNodeIds.has(pair.bazisNodeId)) {
      throw validationErrorForField('replaces', 'Повторяющиеся bazisNodeId в adds/replaces/skips недопустимы');
    }
    seenNodeIds.add(pair.bazisNodeId);
  }
  for (const pair of command.skips) {
    if (seenNodeIds.has(pair.bazisNodeId)) {
      throw validationErrorForField('skips', 'Повторяющиеся bazisNodeId в adds/replaces/skips недопустимы');
    }
    seenNodeIds.add(pair.bazisNodeId);
  }

  const seenOrderDetailIds = new Set<number>();
  for (const pair of command.replaces) {
    if (seenOrderDetailIds.has(pair.orderDetailId)) {
      throw validationErrorForField('replaces', 'Повторяющиеся orderDetailId в replaces недопустимы');
    }
    seenOrderDetailIds.add(pair.orderDetailId);
  }
}

async function detectAddToOrderConflicts(input: {
  db: Pick<TransactionClient, 'query'>;
  bazisProjectId: number;
  orderId: number;
  adds: readonly number[];
  replaces: ReadonlyArray<{ bazisNodeId: number; orderDetailId: number }>;
  skips: ReadonlyArray<{ bazisNodeId: number; orderDetailId: number }>;
}): Promise<Record<string, unknown> | null> {
  const freshPairs = await computeTargetOrderDuplicates(input.db, {
    bazisProjectId: input.bazisProjectId,
    orderId: input.orderId,
    nodeIds: uniqueNumbers([
      ...input.adds,
      ...input.replaces.map((pair) => pair.bazisNodeId),
      ...input.skips.map((pair) => pair.bazisNodeId),
    ]),
  });
  const actualPairKeys = new Set(freshPairs.map(pairKey));
  const expectedPairs = [...input.replaces, ...input.skips];
  const expectedPairKeys = new Set(expectedPairs.map(pairKey));
  const skipPairKeys = new Set(input.skips.map(pairKey));
  const addNodeIdsWithDuplicates = uniqueNumbers(
    freshPairs.filter((pair) => input.adds.includes(pair.bazisNodeId)).map((pair) => pair.bazisNodeId),
  );
  const missingPairs = expectedPairs.filter((pair) => !actualPairKeys.has(pairKey(pair)));
  const unexpectedPairs = freshPairs.filter(
    (pair) => !expectedPairKeys.has(pairKey(pair)) && !input.adds.includes(pair.bazisNodeId),
  );

  const nodeCounts = new Map<number, number>();
  const detailCounts = new Map<number, number>();
  for (const pair of freshPairs) {
    nodeCounts.set(pair.bazisNodeId, (nodeCounts.get(pair.bazisNodeId) ?? 0) + 1);
    detailCounts.set(pair.orderDetailId, (detailCounts.get(pair.orderDetailId) ?? 0) + 1);
  }
  const ambiguousPairs = freshPairs.filter((pair) => {
    const ambiguous = (nodeCounts.get(pair.bazisNodeId) ?? 0) > 1 || (detailCounts.get(pair.orderDetailId) ?? 0) > 1;
    return ambiguous && !skipPairKeys.has(pairKey(pair));
  });

  if (
    missingPairs.length === 0 &&
    unexpectedPairs.length === 0 &&
    addNodeIdsWithDuplicates.length === 0 &&
    ambiguousPairs.length === 0
  ) {
    return null;
  }

  return {
    missingPairs,
    unexpectedPairs,
    addNodeIdsWithDuplicates,
    ambiguousPairs,
    freshPairs,
  };
}

async function upsertBazisNodeOrderDetailMap(
  tx: TransactionClient,
  input: { bazisNodeId: number; orderDetailId: number; orderId: number },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO bazis_node_order_detail_map (node_id, order_detail_id, order_id, mapping_kind)
    VALUES ($1, $2, $3, 'created')
    ON CONFLICT (node_id, order_id)
    DO UPDATE
    SET order_detail_id = EXCLUDED.order_detail_id,
        mapping_kind = 'created'
    `,
    [input.bazisNodeId, input.orderDetailId, input.orderId],
  );
}

function validationErrorForField(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, {
    errors: [{ field, message }],
  });
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function pairKey(pair: { bazisNodeId: number; orderDetailId: number }): string {
  return `${pair.bazisNodeId}:${pair.orderDetailId}`;
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

async function reconcileBazisIdempotency<TResponse>(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    idempotencyKey: string;
    commandName: string;
    requestHash: string;
    entityType: string;
  },
): Promise<{ completedResponse?: TResponse }> {
  const inserted = await tx.query<BazisCommandIdempotencyRow<TResponse>>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status, created_at
    `,
    [
      input.idempotencyKey,
      input.commandName,
      numericUserId(input.currentUser),
      input.entityType,
      'pending',
      input.requestHash,
    ],
  );

  if (inserted.rows[0]) {
    return {};
  }

  const existing = await tx.query<BazisCommandIdempotencyRow<TResponse>>(
    `
    SELECT idempotency_key, request_hash, response_json, status, created_at
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new BazisIdempotencyInProgressError();
  }
  if (row.request_hash !== input.requestHash) {
    throw new BazisIdempotencyKeyReusedError();
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredResponse<TResponse>(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new BazisIdempotencyFailedError();
  }
  if (row.status === 'processing') {
    const ageMs = Date.now() - Date.parse(row.created_at);
    if (Number.isFinite(ageMs) && ageMs >= STALE_PROCESSING_MS) {
      await markBazisIdempotencyFailed(tx, input.idempotencyKey);
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

function hashCreateOrderFromRevisionRequestShape(command: CreateOrderFromRevisionCommand): string {
  return hashRequest({
    revisionId: command.revisionId,
    clientId: command.clientId,
    orderName: command.orderName,
    orderStatusId: command.orderStatusId,
    selectedNodeIds: [...command.selectedNodeIds].sort((left, right) => left - right),
    actorUserId: numericUserId(command.currentUser),
    commandName: CREATE_ORDER_FROM_REVISION_COMMAND_NAME,
  });
}

function hashCreateOrderFromDraftRequestShape(input: {
  order: SaveOrderDto;
  nodes: ReadonlyArray<{ clientKey: string; bazisNodeId: number }>;
  actorUserId: number;
}): string {
  return hashRequest({
    order: input.order,
    nodes: [...input.nodes].sort(
      (left, right) => left.bazisNodeId - right.bazisNodeId || left.clientKey.localeCompare(right.clientKey),
    ),
    actorUserId: input.actorUserId,
    commandName: CREATE_ORDER_FROM_DRAFT_COMMAND_NAME,
  });
}

function hashAddToOrderRequestShape(command: AddToOrderCommand): string {
  return hashRequest({
    orderId: command.orderId,
    adds: [...command.adds].sort((left, right) => left - right),
    replaces: [...command.replaces].sort(
      (left, right) => left.bazisNodeId - right.bazisNodeId || left.orderDetailId - right.orderDetailId,
    ),
    skips: [...command.skips].sort(
      (left, right) => left.bazisNodeId - right.bazisNodeId || left.orderDetailId - right.orderDetailId,
    ),
    actorUserId: numericUserId(command.currentUser),
    commandName: ADD_TO_ORDER_COMMAND_NAME,
  });
}

async function completeBazisIdempotency<TResponse>(
  tx: TransactionClient,
  idempotencyKey: string,
  response: TResponse,
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

async function markBazisIdempotencyFailed(
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

function parseStoredResponse<TResponse>(responseJson: TResponse | string): TResponse {
  return typeof responseJson === 'string' ? (JSON.parse(responseJson) as TResponse) : responseJson;
}
