import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { DatabaseService } from '../../../database/database.service';
import { appendOrderReadScopeSql } from '../../../permissions/policies/order-read-scope-sql';
import type { CurrentUser } from '../../../permissions/current-user';
import { evaluateMdfOrderMachineFilesPresentAutomation } from '../../status-automation/application/status-automation-runtime';
import { buildBazisCutXls, buildBazisCutXlsFromTemplate } from '../application/bazis-xls-writer';
import { ExportTemplatesService } from '../../export-templates/application/export-templates.service';
import {
  buildBazisBathCutNumber,
  mapBazisCutSnapshotFields,
  resolveErpOrderBazisLabels,
} from '../application/bazis-cut-snapshot-mapper';
export { resolveBazisDetailLabels, resolveErpOrderBazisLabels } from '../application/bazis-cut-snapshot-mapper';
import type {
  AddBazisCutDetailsCommand,
  BazisCutRepositoryPort,
  CreateBazisCutSetFromPickerCommand,
  CreateBazisCutSetCommand,
  DeleteBazisCutDetailCommand,
  DeleteBazisCutSetCommand,
  RenameBazisCutSetCommand,
  UpdateBazisCutDetailCommand,
} from '../application/bazis-cut.types';
import {
  buildBazisCutPickerSelectionToken,
  hashBazisCutPickerCriteria,
  normalizeBazisCutPickerCriteria,
  PgBazisCutPicker,
  type PickerRow,
} from './pg-bazis-cut-picker';
import type {
  BazisCutDeleteSetResultDto,
  BazisCutDetailFields,
  BazisCutMutationResultDto,
  BazisCutSetDetailDto,
  BazisCutSetDto,
  BazisCutSetListDto,
  BazisCutSetSummaryDto,
  BazisCutSourceRefDto,
} from '../dto/bazis-cut.dto';

const AUDIT_SOURCE = 'backend.bazis-cut';

const DETAIL_FIELD_COLUMNS = [
  'cut_enabled', 'material_type', 'material_name', 'material_article', 'thickness_mm',
  'position', 'part_name', 'finished_length_mm', 'finished_width_mm', 'cut_length_mm',
  'cut_width_mm', 'quantity', 'orientation', 'groove', 'l1_name', 'l1_designation',
  'l1_thickness_mm', 'l2_name', 'l2_designation', 'l2_thickness_mm', 'w1_name',
  'w1_designation', 'w1_thickness_mm', 'w2_name', 'w2_designation', 'w2_thickness_mm',
  'priority', 'comment', 'custom_property', 'glue', 'milling', 'route', 'film',
] as const;

interface SetRow extends QueryResultRow {
  bazis_cut_set_id: string | number;
  name: string;
  version: number;
  created_by: string | number | null;
  updated_by: string | number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ListRow extends SetRow {
  quantity: string | number;
  position_count: string | number;
  total_area_m2: string | number;
  orders: unknown;
  projects: unknown;
  bazis_projects: unknown;
  bazis_orders: unknown;
  total_count: string | number;
}

interface DetailRow extends QueryResultRow {
  [key: string]: unknown;
  bazis_cut_set_detail_id: string | number;
  bazis_cut_set_id: string | number;
  sort_order: number;
}

interface SourceRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  project_id: string | number;
  order_name: string;
  order_full_number: string;
  project_code: string;
  material_name: string | null;
  thickness_mm: string | number | null;
  detail_number: number;
  basis_designation: string | null;
  basis_data: string | null;
  detail_bazis_project: string | null;
  detail_bazis_product: string | null;
  detail_name: string | null;
  height: string | number | null;
  width: string | number | null;
  quantity: string | number | null;
  note: string | null;
  milling: string | null;
  film: string | null;
  doweling: boolean;
  exact_count: string | number;
  exact_node_id: string | number | null;
  exact_revision_id: string | number | null;
  exact_bazis_project_id: string | number | null;
  exact_vertical: boolean | null;
  fallback_revision_id: string | number | null;
  fallback_bazis_project_id: string | number | null;
  inferred_revision_id: string | number | null;
  inferred_bazis_project_id: string | number | null;
  bath_cut_job_id: string | number | null;
  bath_cut_result_no: string | number | null;
}

interface OrderScopeRow extends QueryResultRow {
  order_id: string | number;
}

interface Snapshot {
  provenance: {
    sourceType: 'order_detail' | 'order_hdf_detail';
    sourceOrderDetailId: number | null;
    sourceOrderHdfDetailId: number | null;
    sourceOrderId: number;
    sourceProjectId: number;
    sourceBazisProjectId: number | null;
    sourceBazisRevisionId: number | null;
    sourceBazisNodeId: number | null;
    sourceOrderName: string;
    sourceOrderFullNumber: string;
    sourceProjectCode: string;
    sourceBazisProjectName: string;
    sourceBazisOrderNo: string;
    sourceBazisProductName: string;
    sourceBathCutNumber: string;
  };
  fields: BazisCutDetailFields;
}

export class PgBazisCutRepository implements BazisCutRepositoryPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly exportTemplates?: ExportTemplatesService,
  ) {}

  async list(input: Parameters<BazisCutRepositoryPort['list']>[0]): Promise<BazisCutSetListDto> {
    const offset = (input.page - 1) * input.pageSize;
    const result = await this.database.query<ListRow>(
      `SELECT s.*,
              COALESCE(SUM(d.quantity), 0)::bigint AS quantity,
              COUNT(d.bazis_cut_set_detail_id)::bigint AS position_count,
              COALESCE(SUM(d.finished_length_mm * d.finished_width_mm * d.quantity / 1000000.0), 0)::numeric AS total_area_m2,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'id', d.source_order_id,
                'label', d.source_order_name,
                'deleted', COALESCE(source_order.delete_flag, false)
              ))
                FILTER (WHERE d.source_order_id IS NOT NULL), '[]'::jsonb) AS orders,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', d.source_project_id, 'label', d.source_project_code))
                FILTER (WHERE d.source_project_id IS NOT NULL), '[]'::jsonb) AS projects,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'id', COALESCE(d.source_bazis_project_id, -d.source_order_detail_id),
                'label', d.source_bazis_project_name
              )) FILTER (
                WHERE NULLIF(btrim(d.source_bazis_project_name), '') IS NOT NULL
                  AND (d.source_bazis_project_id IS NOT NULL OR d.source_order_detail_id IS NOT NULL)
              ), '[]'::jsonb) AS bazis_projects,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'id', COALESCE(d.source_bazis_revision_id, -d.source_order_detail_id),
                'label', d.source_bazis_order_no
              )) FILTER (
                WHERE NULLIF(btrim(d.source_bazis_order_no), '') IS NOT NULL
                  AND (d.source_bazis_revision_id IS NOT NULL OR d.source_order_detail_id IS NOT NULL)
              ), '[]'::jsonb) AS bazis_orders,
              COUNT(*) OVER() AS total_count
       FROM bazis_cut_sets s
       LEFT JOIN bazis_cut_set_details d ON d.bazis_cut_set_id=s.bazis_cut_set_id
       LEFT JOIN orders source_order ON source_order.order_id=d.source_order_id
       WHERE ($1='' OR s.name ILIKE '%' || $1 || '%'
         OR EXISTS (
           SELECT 1 FROM bazis_cut_set_details sd
           WHERE sd.bazis_cut_set_id=s.bazis_cut_set_id
             AND concat_ws(' ', sd.source_order_name, sd.source_order_full_number,
               sd.source_project_code, sd.source_bazis_project_name, sd.source_bazis_order_no,
               sd.source_bazis_product_name) ILIKE '%' || $1 || '%'
         ))
       GROUP BY s.bazis_cut_set_id
       ORDER BY s.created_at DESC, s.bazis_cut_set_id DESC
       LIMIT $2 OFFSET $3`,
      [input.search, input.pageSize, offset],
    );
    return {
      items: result.rows.map(mapSummaryRow),
      page: input.page,
      pageSize: input.pageSize,
      total: result.rows.length === 0 ? 0 : toNumber(result.rows[0].total_count),
    };
  }

  async get(input: Parameters<BazisCutRepositoryPort['get']>[0]): Promise<BazisCutSetDto> {
    return loadSet(this.database, input.setId);
  }

  async pickerFacets(
    input: Parameters<BazisCutRepositoryPort['pickerFacets']>[0],
  ) {
    return new PgBazisCutPicker(this.database).listFacets(input.currentUser, input);
  }

  async pickerSearch(
    input: Parameters<BazisCutRepositoryPort['pickerSearch']>[0],
  ) {
    return new PgBazisCutPicker(this.database)
      .search(input.currentUser, input.criteria, input.page, input.pageSize);
  }

  async orderMemberships(
    input: Parameters<BazisCutRepositoryPort['orderMemberships']>[0],
  ) {
    const params: unknown[] = [input.orderId];
    const scope = appendOrderReadScopeSql(params, input.currentUser, 'o');
    const result = await this.database.query<{
      order_id: string | number;
      detail_id: string | number | null;
      bazis_cut_sets: unknown;
    }>(
      `WITH scoped_order AS (
         SELECT o.order_id FROM orders o
         WHERE o.order_id=$1 AND o.delete_flag=false AND ${scope.predicate}
       )
       SELECT scoped.order_id, od.detail_id,
         COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
           'bazisCutSetId', set.bazis_cut_set_id, 'name', set.name
         )) FILTER (WHERE set.bazis_cut_set_id IS NOT NULL), '[]'::jsonb) AS bazis_cut_sets
       FROM scoped_order scoped
       LEFT JOIN order_details od ON od.order_id=scoped.order_id AND od.delete_flag=false
       LEFT JOIN bazis_cut_set_details detail ON detail.source_order_detail_id=od.detail_id
       LEFT JOIN bazis_cut_sets set ON set.bazis_cut_set_id=detail.bazis_cut_set_id
       GROUP BY scoped.order_id, od.detail_id
       ORDER BY od.detail_id`,
      params,
    );
    if (result.rows.length === 0) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    return {
      orderId: input.orderId,
      details: result.rows.flatMap((row) => row.detail_id === null ? [] : [{
        detailId: toNumber(row.detail_id),
        bazisCutSets: parseMembershipRefs(row.bazis_cut_sets),
      }]),
    };
  }

  async create(command: CreateBazisCutSetCommand): Promise<BazisCutMutationResultDto> {
    await this.assertOrderReadable(this.database, command.currentUser, command.orderId, command.requestId);
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser);
      const detailIds = uniqueIds(command.detailIds);
      const hdfDetailIds = uniqueIds(command.hdfDetailIds ?? []);
      const requestHash = hashRequest('bazis_cut_set.create', command.currentUser, {
        orderId: command.orderId, detailIds, hdfDetailIds,
      });
      const replay = await claimIdempotency<BazisCutMutationResultDto>(tx, command.idempotencyKey,
        'bazis_cut_set.create', actorId(command.currentUser), 'bazis_cut_set', 'pending', requestHash);
      if (replay) return replay;

      const setId = await insertSetHeader(tx, 'БР', actorId(command.currentUser));
      await tx.query(
        'UPDATE bazis_cut_sets SET name=$2 WHERE bazis_cut_set_id=$1',
        [setId, buildBazisCutSetName(setId)],
      );
      const snapshots = [
        ...(detailIds.length > 0 ? await loadSnapshots(tx, command.orderId, detailIds) : []),
        ...(hdfDetailIds.length > 0 ? await loadHdfSnapshots(tx, command.orderId, hdfDetailIds) : []),
      ];
      await insertSnapshots(tx, setId, snapshots, 0, actorId(command.currentUser));
      const set = await loadSet(tx, setId);
      const result = { set, addedCount: snapshots.length };
      await recordMutation(tx, command.currentUser, command.requestId, 'bazis_cut_set.created', setId,
        command.idempotencyKey, null, summaryAudit(set), set, set.details,
        {
          addedDetailIds: snapshots.map((item) => item.provenance.sourceOrderDetailId).filter((id): id is number => id !== null),
          addedHdfDetailIds: snapshots.map((item) => item.provenance.sourceOrderHdfDetailId).filter((id): id is number => id !== null),
        });
      await evaluateBazisCutSetMachineFilesPresentAutomation(tx, command.currentUser, command.requestId, set, 'created');
      await completeIdempotency(tx, command.idempotencyKey, result);
      return result;
    });
  }

  async createFromPicker(command: CreateBazisCutSetFromPickerCommand): Promise<BazisCutMutationResultDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser);
      const criteria = normalizeBazisCutPickerCriteria(command.criteria);
      const requested = normalizePickerDetails(command.details);
      const requestHash = hashRequest('bazis_cut_set.create_from_picker', command.currentUser, {
        criteria, criteriaHash: command.criteriaHash, details: requested,
      });
      const replay = await claimIdempotency<BazisCutMutationResultDto>(tx, command.idempotencyKey,
        'bazis_cut_set.create_from_picker', actorId(command.currentUser), 'bazis_cut_set', 'pending', requestHash);
      if (replay) return replay;

      const canonicalHash = hashBazisCutPickerCriteria(criteria);
      if (canonicalHash !== command.criteriaHash) throw pickerSelectionStale();

      const picker = new PgBazisCutPicker(tx);
      const initial = await picker.loadSelection(command.currentUser, criteria, requested.map((item) => item.detailId));
      assertPickerSelection(requested, initial.rows, canonicalHash);
      const orderIds = uniqueIds(initial.rows.map((row) => toNumber(row.order_id)));
      await lockPickerOrders(tx, command.currentUser, orderIds);
      await lockPickerDetails(tx, requested.map((item) => item.detailId));

      const fresh = await picker.loadSelection(command.currentUser, criteria, requested.map((item) => item.detailId));
      assertPickerSelection(requested, fresh.rows, canonicalHash);
      const detailIds = fresh.rows.map((row) => toNumber(row.detail_id));
      const snapshots = await loadSnapshots(tx, null, detailIds);

      const setId = await insertSetHeader(tx, 'БР', actorId(command.currentUser));
      await tx.query('UPDATE bazis_cut_sets SET name=$2 WHERE bazis_cut_set_id=$1',
        [setId, buildBazisCutSetName(setId)]);
      await insertSnapshots(tx, setId, snapshots, 0, actorId(command.currentUser));
      const set = await loadSet(tx, setId);
      const result = { set, addedCount: snapshots.length };
      await recordMutation(tx, command.currentUser, command.requestId, 'bazis_cut_set.created', setId,
        command.idempotencyKey, null, summaryAudit(set), set, set.details, {
          creationSource: 'picker', criteriaHash: canonicalHash,
          addedDetailIds: snapshots.map((item) => item.provenance.sourceOrderDetailId),
        });
      await evaluateBazisCutSetMachineFilesPresentAutomation(tx, command.currentUser, command.requestId, set, 'created');
      await completeIdempotency(tx, command.idempotencyKey, result);
      return result;
    });
  }

  async rename(command: RenameBazisCutSetCommand): Promise<BazisCutMutationResultDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser);
      const name = command.name.trim();
      const requestHash = hashRequest('bazis_cut_set.rename', command.currentUser,
        { setId: command.setId, expectedVersion: command.expectedVersion, name });
      const replay = await claimIdempotency<BazisCutMutationResultDto>(tx, command.idempotencyKey,
        'bazis_cut_set.rename', actorId(command.currentUser), 'bazis_cut_set', String(command.setId), requestHash);
      if (replay) return replay;
      const before = await lockSet(tx, command.setId, command.expectedVersion);

      if (before.name === name) {
        const result = { set: await loadSet(tx, command.setId) };
        await completeIdempotency(tx, command.idempotencyKey, result);
        return result;
      }
      await tx.query(
        `UPDATE bazis_cut_sets SET name=$2, version=version+1, updated_by=$3
         WHERE bazis_cut_set_id=$1`,
        [command.setId, name, actorId(command.currentUser)],
      );
      const set = await loadSet(tx, command.setId);
      const result = { set };
      await recordMutation(tx, command.currentUser, command.requestId, 'bazis_cut_set.renamed', command.setId,
        command.idempotencyKey, { name: before.name, version: before.version }, summaryAudit(set), set, set.details);
      await completeIdempotency(tx, command.idempotencyKey, result);
      return result;
    });
  }

  async addDetails(command: AddBazisCutDetailsCommand): Promise<BazisCutMutationResultDto> {
    await this.assertOrderReadable(this.database, command.currentUser, command.orderId, command.requestId, command.setId);
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser);
      const detailIds = uniqueIds(command.detailIds);
      const hdfDetailIds = uniqueIds(command.hdfDetailIds ?? []);
      const requestHash = hashRequest('bazis_cut_set.details.add', command.currentUser,
        { setId: command.setId, orderId: command.orderId, detailIds, hdfDetailIds, expectedVersion: command.expectedVersion });
      const replay = await claimIdempotency<BazisCutMutationResultDto>(tx, command.idempotencyKey,
        'bazis_cut_set.details.add', actorId(command.currentUser), 'bazis_cut_set', String(command.setId), requestHash);
      if (replay) return replay;
      await lockSet(tx, command.setId, command.expectedVersion);

      const snapshots = [
        ...(detailIds.length > 0 ? await loadSnapshots(tx, command.orderId, detailIds) : []),
        ...(hdfDetailIds.length > 0 ? await loadHdfSnapshots(tx, command.orderId, hdfDetailIds) : []),
      ];
      const currentCount = await countSetDetails(tx, command.setId);
      const existing = await tx.query<{ source_order_detail_id: string | number | null; source_order_hdf_detail_id: string | number | null }>(
        `SELECT source_order_detail_id, source_order_hdf_detail_id FROM bazis_cut_set_details
         WHERE bazis_cut_set_id=$1
           AND (
             source_order_detail_id=ANY($2::bigint[])
             OR source_order_hdf_detail_id=ANY($3::bigint[])
           )`,
        [command.setId, detailIds, hdfDetailIds],
      );
      const existingKeys = new Set(existing.rows.map((row) => sourceKey({
        sourceType: row.source_order_hdf_detail_id === null ? 'order_detail' : 'order_hdf_detail',
        sourceOrderDetailId: nullableNumber(row.source_order_detail_id),
        sourceOrderHdfDetailId: nullableNumber(row.source_order_hdf_detail_id),
      })));
      const additions = snapshots.filter((item) => !existingKeys.has(sourceKey(item.provenance)));
      if (currentCount + additions.length > 65_535) {
        throw new ApiError(422, 'BAZIS_CUT_SET_TOO_LARGE', 'Набор превышает лимит BIFF8');
      }
      if (additions.length === 0) {
        const result = { set: await loadSet(tx, command.setId), addedCount: 0 };
        await completeIdempotency(tx, command.idempotencyKey, result);
        return result;
      }
      const nextSort = await nextSortOrder(tx, command.setId);
      await insertSnapshots(tx, command.setId, additions, nextSort, actorId(command.currentUser));
      await bumpSet(tx, command.setId, actorId(command.currentUser));
      const set = await loadSet(tx, command.setId);
      const result = { set, addedCount: additions.length };
      await recordMutation(tx, command.currentUser, command.requestId, 'bazis_cut_set.details_added', command.setId,
        command.idempotencyKey, null, { addedCount: additions.length, version: set.version }, set,
        set.details.filter((detail) => additions.some((item) => item.provenance.sourceOrderDetailId === detail.sourceOrderDetailId)),
        {
          addedDetailIds: additions.map((item) => item.provenance.sourceOrderDetailId).filter((id): id is number => id !== null),
          addedHdfDetailIds: additions.map((item) => item.provenance.sourceOrderHdfDetailId).filter((id): id is number => id !== null),
        });
      await evaluateBazisCutSetMachineFilesPresentAutomation(tx, command.currentUser, command.requestId, set, 'details-added');
      await completeIdempotency(tx, command.idempotencyKey, result);
      return result;
    });
  }

  async updateDetail(command: UpdateBazisCutDetailCommand): Promise<BazisCutMutationResultDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser);
      const requestHash = hashRequest('bazis_cut_set.detail.update', command.currentUser,
        { setId: command.setId, detailId: command.detailId, expectedVersion: command.expectedVersion, fields: command.fields });
      const replay = await claimIdempotency<BazisCutMutationResultDto>(tx, command.idempotencyKey,
        'bazis_cut_set.detail.update', actorId(command.currentUser), 'bazis_cut_set_detail', String(command.detailId), requestHash);
      if (replay) return replay;
      await lockSet(tx, command.setId, command.expectedVersion);
      const beforeResult = await tx.query<DetailRow>(
        `SELECT * FROM bazis_cut_set_details
         WHERE bazis_cut_set_id=$1 AND bazis_cut_set_detail_id=$2 FOR UPDATE`,
        [command.setId, command.detailId],
      );
      if (beforeResult.rowCount === 0) throw detailNotFound(command.detailId);
      const before = mapDetail(beforeResult.rows[0]);
      if (sameFields(before, command.fields)) {
        const result = { set: await loadSet(tx, command.setId) };
        await completeIdempotency(tx, command.idempotencyKey, result);
        return result;
      }
      const values = fieldsToValues(command.fields);
      const assignments = DETAIL_FIELD_COLUMNS.map((column, index) => `${column}=$${index + 3}`).join(', ');
      await tx.query(
        `UPDATE bazis_cut_set_details SET ${assignments}, updated_by=$${values.length + 3}
         WHERE bazis_cut_set_id=$1 AND bazis_cut_set_detail_id=$2`,
        [command.setId, command.detailId, ...values, actorId(command.currentUser)],
      );
      await bumpSet(tx, command.setId, actorId(command.currentUser));
      const set = await loadSet(tx, command.setId);
      const result = { set };
      await recordMutation(tx, command.currentUser, command.requestId, 'bazis_cut_set.detail_updated', command.setId,
        command.idempotencyKey, fieldsAudit(before), command.fields, set,
        set.details.filter((detail) => detail.bazisCutSetDetailId === command.detailId),
        { updatedDetailId: command.detailId });
      await completeIdempotency(tx, command.idempotencyKey, result);
      return result;
    });
  }

  async deleteDetail(command: DeleteBazisCutDetailCommand): Promise<BazisCutMutationResultDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser);
      const requestHash = hashRequest('bazis_cut_set.detail.delete', command.currentUser,
        { setId: command.setId, detailId: command.detailId, expectedVersion: command.expectedVersion });
      const replay = await claimIdempotency<BazisCutMutationResultDto>(tx, command.idempotencyKey,
        'bazis_cut_set.detail.delete', actorId(command.currentUser), 'bazis_cut_set_detail', String(command.detailId), requestHash);
      if (replay) return replay;
      await lockSet(tx, command.setId, command.expectedVersion);
      const beforeResult = await tx.query<DetailRow>(
        `SELECT * FROM bazis_cut_set_details
         WHERE bazis_cut_set_id=$1 AND bazis_cut_set_detail_id=$2 FOR UPDATE`,
        [command.setId, command.detailId],
      );
      if (beforeResult.rowCount === 0) throw detailNotFound(command.detailId);
      const before = mapDetail(beforeResult.rows[0]);
      await tx.query(`DELETE FROM bazis_cut_set_details WHERE bazis_cut_set_detail_id=$1`, [command.detailId]);
      await bumpSet(tx, command.setId, actorId(command.currentUser));
      const set = await loadSet(tx, command.setId);
      const result = { set };
      await recordMutation(tx, command.currentUser, command.requestId, 'bazis_cut_set.detail_removed', command.setId,
        command.idempotencyKey, fieldsAudit(before), null, set, [before],
        { removedDetailId: command.detailId });
      await completeIdempotency(tx, command.idempotencyKey, result);
      return result;
    });
  }

  async deleteEmptySet(command: DeleteBazisCutSetCommand): Promise<BazisCutDeleteSetResultDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser);
      const requestHash = hashRequest('bazis_cut_set.delete_empty', command.currentUser,
        { setId: command.setId, expectedVersion: command.expectedVersion });
      const replay = await claimIdempotency<BazisCutDeleteSetResultDto>(tx, command.idempotencyKey,
        'bazis_cut_set.delete_empty', actorId(command.currentUser), 'bazis_cut_set', String(command.setId), requestHash);
      if (replay) return replay;
      await lockSet(tx, command.setId, command.expectedVersion);
      const detailCount = await countSetDetails(tx, command.setId);
      if (detailCount !== 0) {
        throw new ApiError(409, 'BAZIS_CUT_SET_NOT_EMPTY', 'Удалять можно только пустые наборы', {
          setId: command.setId, positionCount: detailCount,
        });
      }
      const before = await loadSet(tx, command.setId);
      const result = { deleted: true as const, set: setSummary(before) };
      await recordMutation(tx, command.currentUser, command.requestId, 'bazis_cut_set.deleted', command.setId,
        command.idempotencyKey, summaryAudit(before), null, before, [],
        { deletedSetId: command.setId });
      await tx.query(`DELETE FROM bazis_cut_sets WHERE bazis_cut_set_id=$1`, [command.setId]);
      await completeIdempotency(tx, command.idempotencyKey, result);
      return result;
    });
  }

  async export(input: Parameters<BazisCutRepositoryPort['export']>[0]): Promise<{ set: BazisCutSetDto; bytes: Buffer }> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, input.currentUser);
      const set = await loadSet(tx, input.setId);
      const template = this.exportTemplates ? await this.exportTemplates.resolveForExport({
        templateId: input.templateId, targetScreen: 'bazis_cut_set', sourceType: 'bazis_cut_set_detail',
        format: 'xls_biff8', client: tx,
      }) : null;
      const bytes = template ? buildBazisCutXlsFromTemplate(set.details, template) : buildBazisCutXls(set.details);
      await auditService.record(tx, {
        event: 'bazis_cut_set.exported', entityType: 'bazis_cut_set', entityId: input.setId,
        actorUserId: actorId(input.currentUser), actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role, requestId: input.requestId ?? `bazis-cut-export-${input.setId}`, source: AUDIT_SOURCE,
        before: null, after: { setId: input.setId, version: set.version, positionCount: set.positionCount },
        diff: {}, metadata: { format: 'biff8', bytes: bytes.length, actorUserId: actorId(input.currentUser),
          requestId: input.requestId ?? null, setVersion: set.version, physicalQuantity: set.quantity,
          ...(template ? { templateId: template.exportTemplateId, templateCode: template.code,
            templateVersion: template.version, templateHash: template.templateHash } : {}),
          ...relatedDimensions(set.details) },
        relatedEntities: auditRelatedEntities(input.setId, set.details),
      });
      return { set, bytes };
    });
  }

  private async assertOrderReadable(tx: DatabaseClient, user: CurrentUser, orderId: number,
    requestId?: string, setId?: number): Promise<void> {
    const params: unknown[] = [orderId];
    const scope = appendOrderReadScopeSql(params, user, 'o');
    const result = await tx.query<OrderScopeRow>(
      `SELECT o.order_id FROM orders o
       WHERE o.order_id=$1
         AND o.delete_flag=false
         AND o.order_kind='production_order'
         AND ${scope.predicate}`,
      params,
    );
    const row = result.rows[0];
    if (!row) {
      try {
        await auditService.recordDenied(this.database, {
          event: 'bazis_cut_set.order_scope_denied', entityType: 'bazis_cut_set', entityId: setId ?? 'create',
          actorUserId: actorId(user), actorUsername: user.username, actorRole: user.role,
          requestId: requestId ?? 'bazis-cut-order-scope', source: AUDIT_SOURCE,
          relatedOrderId: orderId, reason: 'ORDER_SCOPE_DENIED', requiredPermissions: ['orders.view'],
          relatedEntities: [
            ...(setId ? [{ entityType: 'bazis_cut_set', entityId: setId }] : []),
            { entityType: 'order', entityId: orderId },
          ], metadata: { action: setId ? 'add_details' : 'create', orderId },
        });
      } catch {
        /* best-effort, outside the command transaction */
      }
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found', { orderId });
    }
  }
}

async function loadSnapshots(client: DatabaseClient, orderId: number | null, detailIds: number[]): Promise<Snapshot[]> {
  const result = await client.query<SourceRow>(
    `SELECT od.detail_id, od.order_id, o.project_id, o.order_name,
            (p.code || '-' || o.order_name) AS order_full_number, p.code::text AS project_code,
            smt.name AS material_name, smt.thickness_mm, od.detail_number,
            od.basis_designation, od.basis_data, od.basis_project AS detail_bazis_project,
            od.basis_product AS detail_bazis_product,
            od.detail_name, od.height, od.width,
            od.quantity, od.note, mt.milling_type_name AS milling, f.film_name AS film,
            COALESCE(od.doweling, false) AS doweling,
            COALESCE(exact.exact_count, 0) AS exact_count,
            exact.exact_node_id, exact.exact_revision_id, exact.exact_bazis_project_id,
            exact.exact_vertical,
            fallback.revision_id AS fallback_revision_id,
            fallback.bazis_project_id AS fallback_bazis_project_id,
            inferred.revision_id AS inferred_revision_id,
            inferred.bazis_project_id AS inferred_bazis_project_id,
            bath.cut_job_id AS bath_cut_job_id,
            bath.result_no AS bath_cut_result_no
     FROM order_details od
     JOIN orders o ON o.order_id=od.order_id AND o.delete_flag=false
     JOIN projects p ON p.project_id=o.project_id
     LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id=od.sheet_material_type_id
     LEFT JOIN milling_types mt ON mt.milling_type_id=od.milling_type_id
     LEFT JOIN films f ON f.film_id=od.film_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS exact_count,
              MIN(bn.bazis_node_id) AS exact_node_id,
              MIN(br.bazis_revision_id) AS exact_revision_id,
              MIN(br.bazis_project_id) AS exact_bazis_project_id,
              BOOL_OR(COALESCE(NULLIF(bn.texture_orientation,''), bn.raw_json->>'ОриентацияТекстуры')='Вертикальная') AS exact_vertical
       FROM bazis_node_order_detail_map bm
       JOIN bazis_nodes bn ON bn.bazis_node_id=bm.node_id
       JOIN bazis_project_revisions br ON br.bazis_revision_id=bn.revision_id
       WHERE bm.order_detail_id=od.detail_id
     ) exact ON true
     LEFT JOIN LATERAL (
       SELECT bol.revision_id, bol.bazis_project_id
       FROM bazis_order_links bol
       WHERE bol.order_id=o.order_id
       ORDER BY bol.created_at DESC, bol.bazis_order_link_id DESC LIMIT 1
     ) fallback ON true
     LEFT JOIN LATERAL (
       SELECT br.bazis_revision_id AS revision_id, br.bazis_project_id
       FROM bazis_project_revisions br
       WHERE NULLIF(btrim(od.basis_project), '') IS NOT NULL
         AND (
           NULLIF(btrim(br.bazis_order_no), '')=NULLIF(btrim(od.basis_project), '')
           OR EXISTS (
             SELECT 1
             FROM bazis_nodes root
             WHERE root.revision_id=br.bazis_revision_id
               AND root.parent_node_id IS NULL
               AND root.node_kind='product'
               AND NULLIF(btrim(root.raw_json->>'Заказ'), '')=NULLIF(btrim(od.basis_project), '')
           )
         )
       ORDER BY br.revision_no DESC, br.imported_at DESC, br.bazis_revision_id DESC
       LIMIT 1
     ) inferred ON fallback.revision_id IS NULL
     LEFT JOIN LATERAL (
       SELECT cj.cut_job_id, cr.result_no
       FROM cut_job_item cji
       JOIN cut_job cj ON cj.cut_job_id=cji.cut_job_id
       JOIN cut_result cr
         ON cr.cut_result_id=cj.current_cut_result_id
        AND cr.cut_job_id=cj.cut_job_id
       LEFT JOIN cut_result_archive_state archived
         ON archived.cut_job_id=cr.cut_job_id
        AND archived.result_no=cr.result_no
       LEFT JOIN cut_param_profiles profile
         ON profile.cut_param_profile_id=cj.param_profile_id
       WHERE cji.order_detail_id=od.detail_id
         AND cji.is_active=true
         AND cj.status='ready'
         AND cj.last_calc_basis IS NOT NULL
         AND archived.cut_job_id IS NULL
         AND COALESCE(
           cj.last_calc_params->>'layout_mode',
           profile.params->>'layout_mode',
           cj.params->>'layout_mode'
         )='vacuum_table'
       ORDER BY cj.cut_job_id DESC
       LIMIT 1
     ) bath ON true
     WHERE ($1::bigint IS NULL OR od.order_id=$1) AND od.delete_flag=false AND od.detail_id=ANY($2::bigint[])
     ORDER BY CASE WHEN $1::bigint IS NULL THEN od.order_id END,
              CASE WHEN $1::bigint IS NULL THEN od.detail_number END,
              od.detail_id`,
    [orderId, detailIds],
  );
  const found = new Set(result.rows.map((row) => toNumber(row.detail_id)));
  const missing = detailIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    // Keep guessed/deleted/cross-order detail IDs indistinguishable from an
    // inaccessible source order; never expose which requested ID exists.
    if (orderId === null) throw pickerSelectionStale();
    throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found', { orderId });
  }
  const invalid: number[] = [];
  const snapshots: Snapshot[] = [];
  for (const row of result.rows) {
    const exactCount = toNumber(row.exact_count);
    const thickness = nullableNumber(row.thickness_mm);
    const height = nullableNumber(row.height);
    const width = nullableNumber(row.width);
    const quantity = nullableNumber(row.quantity);
    if (exactCount > 1 || !row.material_name?.trim() || !positive(thickness) || !positive(height)
      || !positive(width) || !positive(quantity) || !Number.isInteger(quantity)) {
      invalid.push(toNumber(row.detail_id));
      continue;
    }
    const exactMatch = exactCount === 1;
    const fallbackRevisionId = nullableNumber(row.fallback_revision_id);
    const inferredRevisionId = nullableNumber(row.inferred_revision_id);
    const bazisLabels = resolveErpOrderBazisLabels({
      detailBazisProject: row.detail_bazis_project,
      detailBazisProduct: row.detail_bazis_product,
    });
    const snapshotSource = {
      materialName: row.material_name, thicknessMm: thickness!, detailNumber: row.detail_number,
      importedFromBazisProject: false,
      bazisProject: bazisLabels.sourceBazisProjectName,
      bazisOrder: bazisLabels.sourceBazisOrderNo,
      bazisNodeDesignation: null,
      basisDesignation: row.basis_designation,
      basisData: row.basis_data, detailName: row.detail_name,
      heightMm: height!, widthMm: width!, quantity: quantity!, note: row.note, milling: row.milling,
      film: row.film, doweling: row.doweling, verticalTexture: exactCount === 1 && row.exact_vertical === true,
    };
    const fields = mapBazisCutSnapshotFields(snapshotSource);
    if (!fields) { invalid.push(toNumber(row.detail_id)); continue; }
    const bazisProjectId = exactMatch
      ? nullableNumber(row.exact_bazis_project_id)
      : fallbackRevisionId !== null
        ? nullableNumber(row.fallback_bazis_project_id)
        : nullableNumber(row.inferred_bazis_project_id);
    const bazisRevisionId = exactMatch
      ? nullableNumber(row.exact_revision_id)
      : fallbackRevisionId ?? inferredRevisionId;
    snapshots.push({
      provenance: {
        sourceOrderDetailId: toNumber(row.detail_id), sourceOrderId: toNumber(row.order_id),
        sourceType: 'order_detail',
        sourceOrderHdfDetailId: null,
        sourceProjectId: toNumber(row.project_id), sourceBazisProjectId: bazisProjectId,
        sourceBazisRevisionId: bazisRevisionId,
        sourceBazisNodeId: exactCount === 1 ? nullableNumber(row.exact_node_id) : null,
        sourceOrderName: row.order_name, sourceOrderFullNumber: row.order_full_number,
        sourceProjectCode: row.project_code,
        sourceBathCutNumber: buildBazisBathCutNumber(
          nullableNumber(row.bath_cut_job_id),
          nullableNumber(row.bath_cut_result_no),
        ),
        ...bazisLabels,
      },
      fields,
    });
  }
  if (invalid.length > 0) {
    throw new ApiError(422, 'BAZIS_CUT_DETAIL_NOT_EXPORTABLE', 'Некоторые детали нельзя экспортировать', {
      detailIds: uniqueIds(invalid),
    });
  }
  return snapshots;
}

async function loadHdfSnapshots(client: DatabaseClient, orderId: number | null, hdfDetailIds: number[]): Promise<Snapshot[]> {
  const result = await client.query<{
    order_hdf_detail_id: string | number;
    order_id: string | number;
    project_id: string | number;
    order_name: string;
    order_full_number: string;
    project_code: string;
    material_name: string | null;
    thickness_mm: string | number | null;
    source_detail_number: string | number | null;
    source_detail_name: string | null;
    hdf_height_mm: string | number | null;
    hdf_width_mm: string | number | null;
    quantity: string | number | null;
    milling_type_name: string | null;
  }>(
    `SELECT hdf.order_hdf_detail_id,
            hdf.order_id,
            o.project_id,
            o.order_name,
            (p.code || '-' || o.order_name) AS order_full_number,
            p.code::text AS project_code,
            COALESCE(NULLIF(hdf.hdf_sheet_material_name, ''), smt.name) AS material_name,
            smt.thickness_mm,
            hdf.source_detail_number,
            hdf.source_detail_name,
            hdf.hdf_height_mm,
            hdf.hdf_width_mm,
            hdf.quantity,
            hdf.milling_type_name
     FROM order_hdf_details hdf
     JOIN hdf_calculation_config_state state ON state.id = 1
     JOIN orders o ON o.order_id = hdf.order_id AND o.delete_flag=false
     JOIN projects p ON p.project_id=o.project_id
     LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = hdf.hdf_sheet_material_type_id
     WHERE ($1::bigint IS NULL OR hdf.order_id=$1)
       AND hdf.delete_flag=false
       AND hdf.status='ok'
       AND hdf.config_revision = state.revision
       AND hdf.order_hdf_detail_id=ANY($2::bigint[])
     ORDER BY hdf.order_id, hdf.source_detail_number, hdf.order_hdf_detail_id`,
    [orderId, hdfDetailIds],
  );
  const found = new Set(result.rows.map((row) => toNumber(row.order_hdf_detail_id)));
  const missing = hdfDetailIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    if (orderId === null) throw pickerSelectionStale();
    throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found', { orderId });
  }

  const invalid: number[] = [];
  const snapshots: Snapshot[] = [];
  for (const row of result.rows) {
    const thickness = nullableNumber(row.thickness_mm);
    const height = nullableNumber(row.hdf_height_mm);
    const width = nullableNumber(row.hdf_width_mm);
    const quantity = nullableNumber(row.quantity);
    const hdfDetailId = toNumber(row.order_hdf_detail_id);
    if (!row.material_name?.trim() || !positive(thickness) || !positive(height)
      || !positive(width) || !positive(quantity) || !Number.isInteger(quantity)) {
      invalid.push(hdfDetailId);
      continue;
    }
    const detailNumber = nullableNumber(row.source_detail_number) ?? hdfDetailId;
    const snapshotSource = {
      materialName: row.material_name,
      thicknessMm: thickness!,
      detailNumber,
      importedFromBazisProject: false,
      bazisProject: '',
      bazisOrder: '',
      bazisNodeDesignation: null,
      basisDesignation: null,
      basisData: null,
      detailName: row.source_detail_name ? `ХДФ ${row.source_detail_name}` : 'ХДФ',
      heightMm: height!,
      widthMm: width!,
      quantity: quantity!,
      note: 'ХДФ',
      milling: row.milling_type_name,
      film: null,
      doweling: false,
      verticalTexture: false,
    };
    const fields = mapBazisCutSnapshotFields(snapshotSource);
    if (!fields) { invalid.push(hdfDetailId); continue; }
    snapshots.push({
      provenance: {
        sourceType: 'order_hdf_detail',
        sourceOrderDetailId: null,
        sourceOrderHdfDetailId: hdfDetailId,
        sourceOrderId: toNumber(row.order_id),
        sourceProjectId: toNumber(row.project_id),
        sourceBazisProjectId: null,
        sourceBazisRevisionId: null,
        sourceBazisNodeId: null,
        sourceOrderName: row.order_name,
        sourceOrderFullNumber: row.order_full_number,
        sourceProjectCode: row.project_code,
        sourceBathCutNumber: '',
        sourceBazisProjectName: '',
        sourceBazisOrderNo: '',
        sourceBazisProductName: '',
      },
      fields,
    });
  }
  if (invalid.length > 0) {
    throw new ApiError(422, 'BAZIS_CUT_DETAIL_NOT_EXPORTABLE', 'Некоторые ХДФ-детали нельзя экспортировать', {
      hdfDetailIds: uniqueIds(invalid),
    });
  }
  return snapshots;
}

async function insertSnapshots(client: DatabaseClient, setId: number, snapshots: Snapshot[], startSort: number, userId: number | null): Promise<void> {
  const provenanceColumns = [
    'source_type', 'source_order_detail_id', 'source_order_hdf_detail_id',
    'source_order_id', 'source_project_id', 'source_bazis_project_id',
    'source_bazis_revision_id', 'source_bazis_node_id', 'source_order_name',
    'source_order_full_number', 'source_project_code', 'source_bazis_project_name', 'source_bazis_order_no',
    'source_bazis_product_name', 'source_bath_cut_number',
  ];
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const p = snapshot.provenance;
    const values = [setId, startSort + index,
      p.sourceType, p.sourceOrderDetailId, p.sourceOrderHdfDetailId,
      p.sourceOrderId, p.sourceProjectId, p.sourceBazisProjectId,
      p.sourceBazisRevisionId, p.sourceBazisNodeId, p.sourceOrderName, p.sourceOrderFullNumber,
      p.sourceProjectCode, p.sourceBazisProjectName, p.sourceBazisOrderNo, p.sourceBazisProductName,
      p.sourceBathCutNumber,
      ...fieldsToValues(snapshot.fields), userId, userId];
    const columns = ['bazis_cut_set_id', 'sort_order', ...provenanceColumns, ...DETAIL_FIELD_COLUMNS, 'created_by', 'updated_by'];
    const conflictTarget = p.sourceType === 'order_hdf_detail'
      ? '(bazis_cut_set_id, source_order_hdf_detail_id) WHERE source_order_hdf_detail_id IS NOT NULL'
      : '(bazis_cut_set_id, source_order_detail_id) WHERE source_order_detail_id IS NOT NULL';
    await client.query(
      `INSERT INTO bazis_cut_set_details (${columns.join(',')})
       VALUES (${values.map((_, valueIndex) => `$${valueIndex + 1}`).join(',')})
       ON CONFLICT ${conflictTarget} DO NOTHING`,
      values,
    );
  }
}

async function insertSetHeader(client: TransactionClient, name: string, userId: number | null): Promise<number> {
  await client.query('LOCK TABLE bazis_cut_sets IN SHARE ROW EXCLUSIVE MODE');
  const inserted = await client.query<{ bazis_cut_set_id: string | number }>(
    `WITH next_id AS (
       SELECT candidate AS bazis_cut_set_id
       FROM generate_series(
         1::bigint,
         COALESCE((SELECT MAX(bazis_cut_set_id) FROM bazis_cut_sets), 0) + 1
       ) AS generated(candidate)
       WHERE NOT EXISTS (
         SELECT 1 FROM bazis_cut_sets WHERE bazis_cut_set_id=generated.candidate
       )
       ORDER BY generated.candidate
       LIMIT 1
     )
     INSERT INTO bazis_cut_sets (bazis_cut_set_id, name, created_by, updated_by)
     SELECT bazis_cut_set_id, $1, $2, $2 FROM next_id
     RETURNING bazis_cut_set_id`,
    [name, userId],
  );
  const setId = toNumber(inserted.rows[0].bazis_cut_set_id);
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence('bazis_cut_sets','bazis_cut_set_id'),
       (SELECT GREATEST(COALESCE(MAX(bazis_cut_set_id), 1), 1) FROM bazis_cut_sets),
       true
     )`,
  );
  return setId;
}

async function loadSet(client: DatabaseClient, setId: number): Promise<BazisCutSetDto> {
  const headerResult = await client.query<SetRow>(`SELECT * FROM bazis_cut_sets WHERE bazis_cut_set_id=$1`, [setId]);
  const header = headerResult.rows[0];
  if (!header) throw setNotFound(setId);
  const detailsResult = await client.query<DetailRow>(
    `SELECT d.*, COALESCE(source_order.delete_flag, false) AS source_order_deleted
     FROM bazis_cut_set_details d
     LEFT JOIN orders source_order ON source_order.order_id=d.source_order_id
     WHERE d.bazis_cut_set_id=$1
     ORDER BY d.sort_order, d.bazis_cut_set_detail_id`,
    [setId],
  );
  const details = detailsResult.rows.map(mapDetail);
  return {
    bazisCutSetId: setId, name: header.name, version: Number(header.version),
    createdBy: nullableNumber(header.created_by), updatedBy: nullableNumber(header.updated_by),
    createdAt: iso(header.created_at), updatedAt: iso(header.updated_at), details,
    quantity: details.reduce((sum, detail) => sum + detail.quantity, 0), positionCount: details.length,
    totalAreaM2: totalAreaM2(details),
    orders: refs(details, 'sourceOrderId', 'sourceOrderName', 'sourceOrderDeleted'),
    projects: refs(details, 'sourceProjectId', 'sourceProjectCode'),
    bazisProjects: labelRefs(details, 'sourceBazisProjectId', 'sourceBazisProjectName'),
    bazisOrders: labelRefs(details, 'sourceBazisRevisionId', 'sourceBazisOrderNo'),
  };
}

async function evaluateBazisCutSetMachineFilesPresentAutomation(
  tx: TransactionClient,
  currentUser: CurrentUser,
  requestId: string | undefined,
  set: BazisCutSetDto,
  eventSource: 'created' | 'details-added',
): Promise<void> {
  await evaluateMdfOrderMachineFilesPresentAutomation(tx, {
    orderIds: set.details.map((detail) => detail.sourceOrderId),
    actor: currentUser,
    requestId: requestId ?? `bazis-cut-set-${eventSource}-${set.bazisCutSetId}`,
    sourceIdempotencyKey: `bazis-cut-set:${set.bazisCutSetId}:version-${set.version}:${eventSource}:machine-files`,
  });
}

function mapSummaryRow(row: ListRow): BazisCutSetSummaryDto {
  return {
    bazisCutSetId: toNumber(row.bazis_cut_set_id), name: row.name, version: Number(row.version),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), quantity: toNumber(row.quantity),
    positionCount: toNumber(row.position_count), totalAreaM2: toNumber(row.total_area_m2),
    orders: parseRefs(row.orders), projects: parseRefs(row.projects),
    bazisProjects: parseRefs(row.bazis_projects), bazisOrders: parseRefs(row.bazis_orders),
  };
}

function mapDetail(row: DetailRow): BazisCutSetDetailDto {
  return {
    bazisCutSetDetailId: toNumber(row.bazis_cut_set_detail_id),
    bazisCutSetId: toNumber(row.bazis_cut_set_id), sortOrder: Number(row.sort_order),
    sourceOrderDetailId: nullableNumber(row.source_order_detail_id), sourceOrderId: nullableNumber(row.source_order_id),
    sourceOrderDeleted: row.source_order_deleted === true,
    sourceProjectId: nullableNumber(row.source_project_id), sourceBazisProjectId: nullableNumber(row.source_bazis_project_id),
    sourceBazisRevisionId: nullableNumber(row.source_bazis_revision_id), sourceBazisNodeId: nullableNumber(row.source_bazis_node_id),
    sourceOrderName: textValue(row.source_order_name), sourceOrderFullNumber: textValue(row.source_order_full_number),
    sourceProjectCode: textValue(row.source_project_code), sourceBazisProjectName: textValue(row.source_bazis_project_name),
    sourceBazisOrderNo: textValue(row.source_bazis_order_no),
    sourceBazisProductName: textValue(row.source_bazis_product_name),
    sourceBathCutNumber: textValue(row.source_bath_cut_number),
    cutEnabled: Boolean(row.cut_enabled), materialType: textValue(row.material_type), materialName: textValue(row.material_name),
    materialArticle: textValue(row.material_article), thicknessMm: toNumber(row.thickness_mm), position: textValue(row.position),
    partName: textValue(row.part_name), finishedLengthMm: toNumber(row.finished_length_mm),
    finishedWidthMm: toNumber(row.finished_width_mm), cutLengthMm: toNumber(row.cut_length_mm),
    cutWidthMm: toNumber(row.cut_width_mm), quantity: toNumber(row.quantity), orientation: textValue(row.orientation),
    groove: textValue(row.groove), l1Name: textValue(row.l1_name), l1Designation: textValue(row.l1_designation),
    l1ThicknessMm: toNumber(row.l1_thickness_mm), l2Name: textValue(row.l2_name), l2Designation: textValue(row.l2_designation),
    l2ThicknessMm: toNumber(row.l2_thickness_mm), w1Name: textValue(row.w1_name), w1Designation: textValue(row.w1_designation),
    w1ThicknessMm: toNumber(row.w1_thickness_mm), w2Name: textValue(row.w2_name), w2Designation: textValue(row.w2_designation),
    w2ThicknessMm: toNumber(row.w2_thickness_mm), priority: nullableNumber(row.priority), comment: textValue(row.comment),
    customProperty: textValue(row.custom_property), glue: textValue(row.glue), milling: textValue(row.milling),
    route: textValue(row.route), film: textValue(row.film), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function lockSet(client: DatabaseClient, setId: number, expectedVersion: number): Promise<SetRow> {
  const result = await client.query<SetRow>(`SELECT * FROM bazis_cut_sets WHERE bazis_cut_set_id=$1 FOR UPDATE`, [setId]);
  const row = result.rows[0];
  if (!row) throw setNotFound(setId);
  if (Number(row.version) !== expectedVersion) {
    throw new ApiError(409, 'BAZIS_CUT_SET_STALE_VERSION', 'Набор был изменён другим пользователем', {
      expectedVersion, actualVersion: Number(row.version),
    });
  }
  return row;
}

async function bumpSet(client: DatabaseClient, setId: number, userId: number | null): Promise<void> {
  await client.query(`UPDATE bazis_cut_sets SET version=version+1, updated_by=$2 WHERE bazis_cut_set_id=$1`, [setId, userId]);
}

async function countSetDetails(client: DatabaseClient, setId: number): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1`, [setId]);
  return Number(result.rows[0]?.count ?? 0);
}

async function nextSortOrder(client: DatabaseClient, setId: number): Promise<number> {
  const result = await client.query<{ next_sort: number }>(
    `SELECT COALESCE(MAX(sort_order)+1,0)::integer AS next_sort FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1`, [setId]);
  return Number(result.rows[0]?.next_sort ?? 0);
}

async function recordMutation(client: DatabaseClient, user: CurrentUser, requestId: string | undefined,
  event: string, setId: number, idempotencyKey: string, before: Record<string, unknown> | null,
  after: Record<string, unknown> | null, set: BazisCutSetDto,
  details: readonly BazisCutSetDetailDto[], metadata: Record<string, unknown> = {}): Promise<void> {
  const dimensions = relatedDimensions(details);
  const canonicalMetadata = {
    actorUserId: actorId(user), requestId: requestId ?? null, setVersion: set.version,
    positionCount: set.positionCount,
    physicalQuantity: details.reduce((sum, detail) => sum + detail.quantity, 0),
    ...dimensions, ...metadata,
  };
  await auditService.record(client, {
    event, entityType: 'bazis_cut_set', entityId: setId, actorUserId: actorId(user),
    actorUsername: user.username, actorRole: user.role, requestId: requestId ?? `${event}-${setId}`, source: AUDIT_SOURCE,
    relatedOrderId: dimensions.orderIds[0] ?? null, before, after, diff: after ?? {},
    metadata: { idempotencyKey, ...canonicalMetadata },
    relatedEntities: auditRelatedEntities(setId, details),
  });
  const payload = {
    actorUserId: actorId(user), requestId: requestId ?? null,
    entityType: 'bazis_cut_set', entityId: setId, setVersion: set.version,
    related: dimensions, metadata: canonicalMetadata,
  };
  await client.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ($1,'bazis_cut_set',$2,$3::jsonb,$4) ON CONFLICT (idempotency_key) DO NOTHING`,
    [event, String(setId), JSON.stringify(payload),
      `${event}:${setId}:${idempotencyKey}`],
  );
}

function relatedDimensions(details: readonly BazisCutSetDetailDto[]) {
  return {
    orderIds: uniqueNullable(details.map((detail) => detail.sourceOrderId)),
    orderDetailIds: uniqueNullable(details.map((detail) => detail.sourceOrderDetailId)),
    projectIds: uniqueNullable(details.map((detail) => detail.sourceProjectId)),
    bazisProjectIds: uniqueNullable(details.map((detail) => detail.sourceBazisProjectId)),
    bazisRevisionIds: uniqueNullable(details.map((detail) => detail.sourceBazisRevisionId)),
  };
}

function auditRelatedEntities(setId: number, details: readonly BazisCutSetDetailDto[]) {
  const dimensions = relatedDimensions(details);
  return [
    { entityType: 'bazis_cut_set', entityId: setId },
    ...dimensions.orderIds.map((entityId) => ({ entityType: 'order', entityId })),
    ...dimensions.orderDetailIds.map((entityId) => ({ entityType: 'order_detail', entityId })),
    ...dimensions.projectIds.map((entityId) => ({ entityType: 'project', entityId })),
    ...dimensions.bazisProjectIds.map((entityId) => ({ entityType: 'bazis_project', entityId })),
    ...dimensions.bazisRevisionIds.map((entityId) => ({ entityType: 'bazis_revision', entityId })),
  ];
}

function uniqueNullable(values: readonly (number | null)[]): number[] {
  return [...new Set(values.filter((value): value is number => value !== null))].sort((a, b) => a - b);
}

async function claimIdempotency<T>(client: DatabaseClient, key: string, commandName: string,
  userId: number | null, entityType: string, entityId: string, requestHash: string): Promise<T | null> {
  const inserted = await client.query(
    `INSERT INTO command_idempotency_keys
       (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
     VALUES ($1,$2,$3,$4,$5,$6,'processing') ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`, [key, commandName, userId, entityType, entityId, requestHash]);
  if (inserted.rowCount === 1) return null;
  const existing = await client.query<{ request_hash: string; response_json: T | null; status: string; actor_user_id: string | number | null }>(
    `SELECT request_hash,response_json,status,actor_user_id FROM command_idempotency_keys WHERE idempotency_key=$1 FOR UPDATE`, [key]);
  const row = existing.rows[0];
  if (!row || row.request_hash !== requestHash || nullableNumber(row.actor_user_id) !== userId) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request');
  }
  if (row.status === 'completed' && row.response_json) return row.response_json;
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
}

async function completeIdempotency(client: DatabaseClient, key: string, response: unknown): Promise<void> {
  await client.query(`UPDATE command_idempotency_keys SET status='completed',response_json=$2::jsonb,completed_at=now() WHERE idempotency_key=$1`,
    [key, JSON.stringify(response)]);
}

function fieldsToValues(fields: BazisCutDetailFields): unknown[] {
  return [fields.cutEnabled, fields.materialType, fields.materialName, fields.materialArticle,
    fields.thicknessMm, fields.position, fields.partName, fields.finishedLengthMm, fields.finishedWidthMm,
    fields.cutLengthMm, fields.cutWidthMm, fields.quantity, fields.orientation, fields.groove,
    fields.l1Name, fields.l1Designation, fields.l1ThicknessMm, fields.l2Name, fields.l2Designation,
    fields.l2ThicknessMm, fields.w1Name, fields.w1Designation, fields.w1ThicknessMm, fields.w2Name,
    fields.w2Designation, fields.w2ThicknessMm, fields.priority, fields.comment, fields.customProperty,
    fields.glue, fields.milling, fields.route, fields.film];
}

function fieldsAudit(detail: BazisCutSetDetailDto): Record<string, unknown> {
  return Object.fromEntries(Object.keys(detail).filter((key) => DETAIL_DTO_FIELD_KEYS.has(key))
    .map((key) => [key, detail[key as keyof BazisCutSetDetailDto]]));
}

const DETAIL_DTO_FIELD_KEYS = new Set([
  'cutEnabled', 'materialType', 'materialName', 'materialArticle', 'thicknessMm', 'position', 'partName',
  'finishedLengthMm', 'finishedWidthMm', 'cutLengthMm', 'cutWidthMm', 'quantity', 'orientation', 'groove',
  'l1Name', 'l1Designation', 'l1ThicknessMm', 'l2Name', 'l2Designation', 'l2ThicknessMm', 'w1Name',
  'w1Designation', 'w1ThicknessMm', 'w2Name', 'w2Designation', 'w2ThicknessMm', 'priority', 'comment',
  'customProperty', 'glue', 'milling', 'route', 'film',
]);

function sameFields(detail: BazisCutSetDetailDto, fields: BazisCutDetailFields): boolean {
  return JSON.stringify(fieldsAudit(detail)) === JSON.stringify(fields);
}

function refs(details: BazisCutSetDetailDto[], idKey: keyof BazisCutSetDetailDto,
  labelKey: keyof BazisCutSetDetailDto, deletedKey?: keyof BazisCutSetDetailDto): BazisCutSourceRefDto[] {
  const map = new Map<number, { label: string; deleted: boolean }>();
  for (const detail of details) {
    const id = detail[idKey]; const label = detail[labelKey];
    const deleted = deletedKey ? detail[deletedKey] === true : false;
    if (typeof id === 'number' && typeof label === 'string' && label) map.set(id, { label, deleted });
  }
  return [...map].map(([id, ref]) => ({ id, label: ref.label, ...(ref.deleted ? { deleted: true } : {}) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

function labelRefs(details: BazisCutSetDetailDto[], idKey: keyof BazisCutSetDetailDto,
  labelKey: keyof BazisCutSetDetailDto): BazisCutSourceRefDto[] {
  const map = new Map<string, number>();
  for (const detail of details) {
    const label = detail[labelKey];
    if (typeof label !== 'string' || !label.trim()) continue;
    const linkedId = detail[idKey];
    const fallbackId = detail.sourceOrderDetailId;
    const id = typeof linkedId === 'number'
      ? linkedId
      : typeof fallbackId === 'number' ? -fallbackId : null;
    if (id !== null && !map.has(label.trim())) map.set(label.trim(), id);
  }
  return [...map].map(([label, id]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

function parseRefs(value: unknown): BazisCutSourceRefDto[] {
  if (!Array.isArray(value)) return [];
  const map = new Map<string, { id: number; deleted: boolean }>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const ref = item as { id?: unknown; label?: unknown; deleted?: unknown };
    const id = nullableNumber(ref.id); const label = textValue(ref.label);
    if (id !== null && label && !map.has(label)) map.set(label, { id, deleted: ref.deleted === true });
  }
  return [...map].map(([label, ref]) => ({ id: ref.id, label, ...(ref.deleted ? { deleted: true } : {}) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

function hashRequest(command: string, user: CurrentUser, body: unknown): string {
  return createHash('sha256').update(JSON.stringify({ commandName: command, actorUserId: user.id, body })).digest('hex');
}

function normalizePickerDetails(
  details: readonly { detailId: number; selectionToken: string }[],
): Array<{ detailId: number; selectionToken: string }> {
  const byId = new Map<number, string>();
  for (const detail of details) {
    if (byId.has(detail.detailId)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Деталь выбрана более одного раза');
    }
    byId.set(detail.detailId, detail.selectionToken);
  }
  return [...byId].map(([detailId, selectionToken]) => ({ detailId, selectionToken }))
    .sort((left, right) => left.detailId - right.detailId);
}

function assertPickerSelection(
  requested: readonly { detailId: number; selectionToken: string }[],
  rows: readonly PickerRow[],
  criteriaHash: string,
): void {
  if (rows.length !== requested.length) throw pickerSelectionStale();
  const rowById = new Map(rows.map((row) => [toNumber(row.detail_id), row]));
  for (const item of requested) {
    const row = rowById.get(item.detailId);
    if (!row || buildBazisCutPickerSelectionToken(criteriaHash, row) !== item.selectionToken) {
      throw pickerSelectionStale();
    }
  }
}

async function lockPickerOrders(
  client: DatabaseClient,
  user: CurrentUser,
  orderIds: readonly number[],
): Promise<void> {
  const params: unknown[] = [[...orderIds]];
  const scope = appendOrderReadScopeSql(params, user, 'o');
  const result = await client.query<OrderScopeRow>(
    `SELECT o.order_id FROM orders o
     WHERE o.order_id=ANY($1::bigint[]) AND o.delete_flag=false AND ${scope.predicate}
     ORDER BY o.order_id FOR UPDATE`,
    params,
  );
  if (result.rows.length !== orderIds.length) throw pickerSelectionStale();
}

async function lockPickerDetails(client: DatabaseClient, detailIds: readonly number[]): Promise<void> {
  const result = await client.query<{ detail_id: string | number }>(
    `SELECT od.detail_id FROM order_details od
     WHERE od.detail_id=ANY($1::bigint[]) AND od.delete_flag=false
     ORDER BY od.order_id, od.detail_number, od.detail_id FOR UPDATE`,
    [[...detailIds]],
  );
  if (result.rows.length !== detailIds.length) throw pickerSelectionStale();
}

function parseMembershipRefs(value: unknown): Array<{ bazisCutSetId: number; name: string }> {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source) as unknown; } catch { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const ref = entry as { bazisCutSetId?: unknown; name?: unknown };
    const bazisCutSetId = nullableNumber(ref.bazisCutSetId);
    return bazisCutSetId === null ? [] : [{ bazisCutSetId, name: textValue(ref.name) }];
  }).sort((left, right) => left.bazisCutSetId - right.bazisCutSetId);
}

function summaryAudit(set: BazisCutSetDto): Record<string, unknown> {
  return { setId: set.bazisCutSetId, name: set.name, version: set.version,
    quantity: set.quantity, positionCount: set.positionCount, totalAreaM2: set.totalAreaM2 };
}

function setSummary(set: BazisCutSetDto): BazisCutSetSummaryDto {
  return {
    bazisCutSetId: set.bazisCutSetId, name: set.name, version: set.version,
    createdAt: set.createdAt, updatedAt: set.updatedAt, quantity: set.quantity,
    positionCount: set.positionCount, totalAreaM2: set.totalAreaM2,
    orders: set.orders, projects: set.projects, bazisProjects: set.bazisProjects,
    bazisOrders: set.bazisOrders,
  };
}

function totalAreaM2(details: readonly Pick<BazisCutSetDetailDto, 'finishedLengthMm' | 'finishedWidthMm' | 'quantity'>[]): number {
  return details.reduce((sum, detail) => sum + detail.finishedLengthMm * detail.finishedWidthMm * detail.quantity / 1_000_000, 0);
}

async function setSessionUser(client: TransactionClient, user: CurrentUser): Promise<void> {
  await client.query('SELECT set_session_user($1)', [user.id]);
}

function actorId(user: CurrentUser): number | null { return nullableNumber(user.id); }
export function buildBazisCutSetName(setId: number): string { return `БР-${setId}`; }
function pickerSelectionStale() {
  return new ApiError(409, 'BAZIS_CUT_PICKER_SELECTION_STALE',
    'Отбор деталей устарел. Обновите список и повторите выбор');
}
function setNotFound(id: number) { return new ApiError(404, 'BAZIS_CUT_SET_NOT_FOUND', 'Набор Базис-раскрой не найден', { setId: id }); }
function detailNotFound(id: number) { return new ApiError(404, 'BAZIS_CUT_DETAIL_NOT_FOUND', 'Деталь набора не найдена', { detailId: id }); }
function uniqueIds(ids: number[]): number[] { return [...new Set(ids)].sort((a, b) => a - b); }

function sourceKey(input: {
  sourceType: 'order_detail' | 'order_hdf_detail';
  sourceOrderDetailId: number | null;
  sourceOrderHdfDetailId: number | null;
}): string {
  return input.sourceType === 'order_hdf_detail'
    ? `hdf:${input.sourceOrderHdfDetailId ?? 0}`
    : `detail:${input.sourceOrderDetailId ?? 0}`;
}
function positive(value: number | null): value is number { return value !== null && Number.isFinite(value) && value > 0; }
function toNumber(value: unknown): number { return Number(value); }
function nullableNumber(value: unknown): number | null { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function textValue(value: unknown): string { return value == null ? '' : String(value); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
