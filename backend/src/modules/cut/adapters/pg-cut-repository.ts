import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { buildCutAuditEvent, buildCutDeniedEvent, CUT_AUDIT_EVENTS, type CutAuditActor } from '../application/cut-audit';
import {
  classifyDetailEligibility,
  type DetailEligibilityCandidate,
} from '../application/cut-eligibility';
import {
  assertWithinBodyLimit,
  assertWithinInstanceLimit,
  backMapSolutions,
  buildOptimizeRequest,
  freecutItemId,
  parseFreecutItemId,
  type FreecutItem,
  type FreecutParams,
  type FreecutPlacement,
  type SheetPlacementsJson,
} from '../application/cut-freecut-mapping';
import { computeRequestHash } from '../application/cut-request-hash';
import { type CutConfigPort } from '../application/cut-config';
import { PgCutConfigRepository } from './pg-cut-config-repository';
import type {
  AddCutItemsCommand,
  ArchiveCutJobCommand,
  CalculateCutJobCommand,
  CreateCutJobCommand,
  CutRepositoryPort,
  EligibleDetailsQuery,
  GetCutJobQuery,
  ListCutJobsQuery,
  RemoveCutItemCommand,
  RenderGroupPdfQuery,
  RenderJobPdfQuery,
  RenderSheetPngQuery,
  RenderSheetSvgQuery,
  SetPdfPrewarmStateQuery,
} from '../application/cut-command.types';
import type {
  CutGroupDto,
  CutJobDto,
  EligibleDetailDto,
  EligibleDetailsResponseDto,
} from '../dto/cut.dto';
import { buildSheetSvg, computeGroupItemQuantities, formatPieceLabel } from '../render/sheet-svg';
import { renderSheetPng } from '../render/sheet-png';
import { buildSheetsPdf } from '../render/sheet-pdf';
import {
  CutGroupSheetNotFoundError,
  CutJobItemNotFoundError,
  CutJobNotFoundError,
  CutDetailNotEligibleError,
  CutJobNotMutableError,
  CutNoItemsError,
  CutOrderDetailNotFoundError,
  CutStaleVersionError,
} from '../errors/cut.errors';
import { CutDetailAlreadyReservedError } from '../errors/cut.errors';

const AUDIT_SOURCE = 'backend-cut-command';

/**
 * Ready-to-cut statuses and the default freecut params are sourced from the
 * editable `cut_config` tables (migration 023) via {@link CutConfigPort}, with a
 * documented in-code fallback when the config is empty (see cut-config.ts).
 */

/** Reservation is active (and the job mutable) only in these states. */
const MUTABLE_STATUSES = new Set(['draft', 'calculating', 'ready']);

interface FreecutClientLike {
  optimize: (
    request: ReturnType<typeof buildOptimizeRequest>,
  ) => Promise<import('../application/cut-freecut-mapping').FreecutOptimizeResponse>;
}


interface CutJobLockRow extends QueryResultRow {
  cut_job_id: string | number;
  name: string;
  status: string;
  source: string;
  version: string | number;
  pdf_prewarm_state: string;
  params: Record<string, unknown> | null;
}

interface CalcItemRow extends QueryResultRow {
  cut_job_item_id: string | number;
  order_detail_id: string | number;
  order_id: string | number;
  qty: string | number;
  width_mm: string | number;
  height_mm: string | number;
  material_id?: string | number | null;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  film_texture: boolean | null;
  smt_width_mm: string | number | null;
  smt_height_mm: string | number | null;
}

export class PgCutRepository implements CutRepositoryPort {
  private readonly config: CutConfigPort;

  constructor(
    private readonly database: DatabaseService,
    private readonly freecut: FreecutClientLike,
    config?: CutConfigPort,
  ) {
    this.config = config ?? new PgCutConfigRepository(database);
  }

  /** Audited RBAC denial (plan §11). Best-effort: a failed audit write must not
   *  mask the 403, so callers fire-and-forget and swallow errors. Uses the audit
   *  service's own connection (no surrounding tx needed). */
  async recordPermissionDenied(input: import('../application/cut-command.types').CutPermissionDeniedInput): Promise<void> {
    const actor: CutAuditActor = {
      id: input.currentUser.id,
      username: input.currentUser.username,
      role: input.currentUser.role,
    };
    await auditService.recordDenied(
      this.database,
      buildCutDeniedEvent({
        cutJobId: input.cutJobId ?? 0,
        actor,
        requestId: input.requestId ?? AUDIT_SOURCE,
        source: AUDIT_SOURCE,
        reason: 'permission_denied',
        requiredPermissions: input.requiredPermissions,
      }),
    );
  }

  createJob(command: CreateCutJobCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      // Snapshot the freecut params at creation (config-as-data, plan §4a): a
      // config edit after the draft exists must NOT retro-mutate this job. The
      // snapshot is the authoritative payload at calculate time.
      const paramsSnapshot = await this.config.getDefaultParams();
      const inserted = await tx.query<{ cut_job_id: string | number }>(
        `
        INSERT INTO cut_job (name, source, selection_criteria, params, created_by)
        VALUES ($1, 'manual', $2::jsonb, $3::jsonb, $4)
        RETURNING cut_job_id
        `,
        [
          command.dto.name,
          command.dto.criteria ? JSON.stringify(command.dto.criteria) : null,
          JSON.stringify(paramsSnapshot),
          numOrNull(command.currentUser.id),
        ],
      );
      const cutJobId = toNum(inserted.rows[0].cut_job_id);

      const readyStatusIds = await this.resolveReadyStatusIds();
      const reservedOrderIds: number[] = [];
      for (const detailId of command.dto.detailIds ?? []) {
        const orderId = await this.reserveDetail(tx, cutJobId, detailId, readyStatusIds);
        reservedOrderIds.push(orderId);
      }

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.created,
        cutJobId,
        requestId: command.requestId,
        related: { orderIds: reservedOrderIds },
        metadata: { detailCount: command.dto.detailIds?.length ?? 0 },
      });

      return loadJob(tx, cutJobId);
    });
  }

  addItems(command: AddCutItemsCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);
      assertMutable(job);

      const readyStatusIds = await this.resolveReadyStatusIds();
      const reservedOrderIds: number[] = [];
      for (const detailId of command.dto.detailIds) {
        reservedOrderIds.push(await this.reserveDetail(tx, command.cutJobId, detailId, readyStatusIds));
      }

      await bumpVersion(tx, command.cutJobId);
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.itemAdded,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { orderIds: reservedOrderIds },
        metadata: { detailIds: command.dto.detailIds },
      });

      return loadJob(tx, command.cutJobId);
    });
  }

  removeItem(command: RemoveCutItemCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);
      assertMutable(job);

      const released = await tx.query<{ order_id: string | number; order_detail_id: string | number }>(
        `
        UPDATE cut_job_item
        SET is_active = false, updated_at = now()
        WHERE cut_job_item_id = $1 AND cut_job_id = $2 AND is_active = true
        RETURNING order_id, order_detail_id
        `,
        [command.cutJobItemId, command.cutJobId],
      );
      if (released.rowCount === 0) {
        throw new CutJobItemNotFoundError(command.cutJobItemId);
      }

      await bumpVersion(tx, command.cutJobId);
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.itemRemoved,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { orderIds: [toNum(released.rows[0].order_id)] },
        metadata: { cutJobItemId: command.cutJobItemId },
      });

      return loadJob(tx, command.cutJobId);
    });
  }

  async calculate(command: CalculateCutJobCommand): Promise<CutJobDto> {
    // Phase 1 — read + validate + build request under a short lock (NOT held
    // across the external freecut call).
    const prep = await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);
      assertMutable(job);

      const items = await loadCalcItems(tx, command.cutJobId);
      if (items.length === 0) {
        throw new CutNoItemsError(command.cutJobId);
      }

      // Recalculation: drop the PREVIOUS result set under the lock so a re-cut
      // leaves exactly the new groups, and a failed re-cut (status -> failed in
      // Phase 2) leaves NO groups — never a stale layout mixed into the manifest
      // or PDF. cut_group_sheet cascades; cut_job_item.cut_group_id is FK
      // ON DELETE SET NULL (items stay active/reserved), set explicitly for clarity.
      await tx.query(`UPDATE cut_job_item SET cut_group_id = NULL WHERE cut_job_id = $1 AND cut_group_id IS NOT NULL`, [command.cutJobId]);
      await tx.query(`DELETE FROM cut_group WHERE cut_job_id = $1`, [command.cutJobId]);

      // Multi-material fan-out (plan §6): one cut_group + one freecut call per
      // cuttable key (sheet_material_type_id, film_id). Slice-2 removes the
      // single-group 422 — a mixed-material job fans out to N groups.
      const groups = [...groupByCuttableKey(items).values()];
      // Use the job's params snapshot (taken at createJob) — never the CURRENT
      // config defaults — so a config edit after creation can't retro-mutate this
      // calculation (§4a). Legacy jobs without a snapshot fall back to defaults.
      const params = (
        job.params && Object.keys(job.params).length > 0
          ? job.params
          : await this.config.getDefaultParams()
      ) as FreecutParams;
      const grainRules = await this.config.getGrainRules();

      const groupPreps = groups.map((group) => {
        if (group.sheetMaterialTypeId === null || group.smtWidthMm === null || group.smtHeightMm === null) {
          // A group whose material has no sheet spec cannot be cut; eligibility
          // surfaces this as no_sheet_spec before add, but fail closed here too.
          throw new CutNoItemsError(command.cutJobId);
        }
        const freecutItems: FreecutItem[] = group.items.map((item) => ({
          id: freecutItemId(item.orderDetailId),
          width_mm: item.widthMm,
          height_mm: item.heightMm,
          qty: item.qty,
          ...(item.filmTexture === true ? grainRules.textured : grainRules.plain),
        }));
        const request = buildOptimizeRequest({
          stock: { id: `smt-${group.sheetMaterialTypeId}`, width_mm: group.smtWidthMm, height_mm: group.smtHeightMm },
          items: freecutItems,
          params,
          includeSvg: false,
        });
        // Per-group pre-call guards (a fan-out group can independently exceed limits).
        assertWithinInstanceLimit(freecutItems);
        assertWithinBodyLimit(request);
        return { group, request };
      });

      // Reflect the lifecycle: draft|ready -> calculating, and BUMP version so a
      // second concurrent calculate with the same client version is rejected at
      // its own Phase 1 (FOR UPDATE serializes) BEFORE it dispatches freecut —
      // no wasted optimize call, no racing Phase 3 writes. Also reset the PDF
      // pre-warm state: the new version's PDF is not yet rendered, so a stale
      // 'ready' from the previous version must not linger.
      await tx.query(
        `UPDATE cut_job
         SET status = 'calculating', version = version + 1,
             pdf_prewarm_state = 'pending', pdf_prewarm_failure_reason = NULL, updated_at = now()
         WHERE cut_job_id = $1`,
        [command.cutJobId],
      );

      return { groupPreps, params, expectedVersion: job.version + 1 };
    });

    // Related dimensions aggregated across ALL groups (audit query/report-ready).
    const allOrderIds = prep.groupPreps.flatMap((p) => p.group.orderIds);
    const allMaterialIds = prep.groupPreps.flatMap((p) => p.group.materialIds);
    const allSheetMaterialTypeIds = prep.groupPreps.map((p) => p.group.sheetMaterialTypeId as number);

    // Phase 2 — external freecut calls (no DB lock held), one per group.
    // Partial-failure policy: ANY group error fails the WHOLE job (status=failed
    // + cut_job.calculate_failed). All-or-nothing — no group is persisted on a
    // partial failure, so the operator never sees a half-cut job. (Sequential so
    // a failure short-circuits the remaining optimize calls.)
    const responses: Array<{ group: (typeof prep.groupPreps)[number]['group']; response: Awaited<ReturnType<FreecutClientLike['optimize']>> }> = [];
    try {
      for (const groupPrep of prep.groupPreps) {
        responses.push({ group: groupPrep.group, response: await this.freecut.optimize(groupPrep.request) });
      }
    } catch (error) {
      await this.database.transaction(async (tx) => {
        await setSessionUser(tx, command.currentUser.id);
        // Only mark THIS calculation's version as failed. If a newer calculate /
        // mutation bumped the version while freecut was in flight, the stale
        // failure must NOT clobber the newer result (skip status + audit).
        const failed = await tx.query(
          `UPDATE cut_job SET status = 'failed', version = version + 1, updated_at = now()
           WHERE cut_job_id = $1 AND version = $2`,
          [command.cutJobId, prep.expectedVersion],
        );
        if (failed.rowCount === 0) {
          return;
        }
        await this.audit(tx, command.currentUser, {
          event: CUT_AUDIT_EVENTS.calculateFailed,
          cutJobId: command.cutJobId,
          requestId: command.requestId,
          related: { orderIds: allOrderIds, materialIds: allMaterialIds, sheetMaterialTypeIds: allSheetMaterialTypeIds },
          metadata: {
            error: error instanceof Error ? error.message : 'freecut error',
            code: (error as { code?: string })?.code ?? null,
          },
        });
      });
      throw error;
    }

    // Phase 3 — persist ALL groups + a single audit + a single outbox row.
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, prep.expectedVersion);

      const cutGroupIds: number[] = [];
      let totalSheets = 0;
      let totalUnplaced = 0;
      for (const { group, response } of responses) {
        const groupInsert = await tx.query<{ cut_group_id: string | number }>(
          `
          INSERT INTO cut_group (cut_job_id, sheet_material_type_id, film_id, status, summary)
          VALUES ($1, $2, $3, 'ready', $4::jsonb)
          RETURNING cut_group_id
          `,
          [
            command.cutJobId,
            group.sheetMaterialTypeId,
            group.filmId,
            response.summary ? JSON.stringify(response.summary) : null,
          ],
        );
        const cutGroupId = toNum(groupInsert.rows[0].cut_group_id);
        cutGroupIds.push(cutGroupId);

        // Assign only THIS group's items to the new cut_group (scoped by detail).
        await tx.query(
          `UPDATE cut_job_item SET cut_group_id = $1, updated_at = now()
           WHERE cut_job_id = $2 AND is_active = true AND order_detail_id = ANY($3::bigint[])`,
          [cutGroupId, command.cutJobId, group.items.map((item) => item.orderDetailId)],
        );

        for (const sheet of backMapSolutions(response)) {
          await tx.query(
            `
            INSERT INTO cut_group_sheet (cut_group_id, sheet_index, sheet_material_type_id, placements)
            VALUES ($1, $2, $3, $4::jsonb)
            `,
            [cutGroupId, sheet.sheetIndex, group.sheetMaterialTypeId, JSON.stringify(sheet.placements)],
          );
          totalSheets += 1;
        }
        totalUnplaced += response.unplaced_items?.length ?? 0;
      }

      // Idempotency anchor over the WHOLE resolved item set (all groups). The
      // hash covers each detail's geometry + cuttable key + qty, so a re-cut after
      // a geometry/material/film change emits a fresh outbox row (not suppressed),
      // while an identical re-cut stays one row.
      const allHashItems = prep.groupPreps.flatMap((p) =>
        p.group.items.map((item) => ({
          detailId: item.orderDetailId,
          qty: item.qty,
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          sheetMaterialTypeId: p.group.sheetMaterialTypeId,
          filmId: p.group.filmId,
          filmTexture: item.filmTexture,
        })),
      );
      const requestHash = computeRequestHash({
        items: allHashItems,
        params: prep.params as unknown as Record<string, unknown>,
      });
      await tx.query(
        `
        UPDATE cut_job
        SET status = 'ready', request_hash = $2, params = $3::jsonb, version = version + 1, updated_at = now()
        WHERE cut_job_id = $1
        `,
        [command.cutJobId, requestHash, JSON.stringify(prep.params)],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.calculated,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          orderIds: allOrderIds,
          materialIds: allMaterialIds,
          sheetMaterialTypeIds: allSheetMaterialTypeIds,
          cutGroupIds,
        },
        metadata: {
          groupCount: responses.length,
          sheetCount: totalSheets,
          unplacedCount: totalUnplaced,
        },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.calculated,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            cutGroupIds,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
            orderIds: allOrderIds,
            sheetMaterialTypeIds: allSheetMaterialTypeIds,
            requestHash,
          }),
          `${CUT_AUDIT_EVENTS.calculated}:${requestHash}`,
        ],
      );

      return loadJob(tx, command.cutJobId);
    });
  }

  archive(command: ArchiveCutJobCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);

      const released = await tx.query<{ order_id: string | number }>(
        `
        UPDATE cut_job_item SET is_active = false, updated_at = now()
        WHERE cut_job_id = $1 AND is_active = true
        RETURNING order_id
        `,
        [command.cutJobId],
      );
      await tx.query(
        `UPDATE cut_job SET status = 'archived', version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.archived,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { orderIds: released.rows.map((row) => toNum(row.order_id)) },
        metadata: { releasedCount: released.rowCount ?? 0 },
      });

      return loadJob(tx, command.cutJobId);
    });
  }

  getJob(query: GetCutJobQuery): Promise<CutJobDto> {
    return loadJob(this.database, query.cutJobId);
  }

  async listJobs(query: ListCutJobsQuery): Promise<CutJobDto[]> {
    const conditions: string[] = ['status <> $1'];
    const params: unknown[] = ['archived'];
    if (query.filters?.status) {
      params.push(query.filters.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.filters?.createdBy) {
      params.push(query.filters.createdBy);
      conditions.push(`created_by = $${params.length}`);
    }
    const result = await this.database.query<{ cut_job_id: string | number }>(
      `SELECT cut_job_id FROM cut_job WHERE ${conditions.join(' AND ')} ORDER BY cut_job_id DESC LIMIT 200`,
      params,
    );
    const jobs: CutJobDto[] = [];
    for (const row of result.rows) {
      jobs.push(await loadJob(this.database, toNum(row.cut_job_id)));
    }
    return jobs;
  }

  async listEligibleDetails(query: EligibleDetailsQuery): Promise<EligibleDetailsResponseDto> {
    const readyStatusIds = await this.resolveReadyStatusIds();

    const conditions: string[] = ['od.delete_flag = false'];
    const params: unknown[] = [];
    const addArrayFilter = (column: string, values: number[] | undefined) => {
      if (values && values.length > 0) {
        params.push(values);
        conditions.push(`${column} = ANY($${params.length}::bigint[])`);
      }
    };
    addArrayFilter('od.order_id', query.criteria.orderIds);
    addArrayFilter('od.material_id', query.criteria.materialIds);
    addArrayFilter('od.film_id', query.criteria.filmIds);
    if (query.criteria.productionStatusIds && query.criteria.productionStatusIds.length > 0) {
      // Operator override: explicit status filter wins over the ready-set default.
      addArrayFilter('od.production_status_id', query.criteria.productionStatusIds);
    } else if (readyStatusIds.length > 0) {
      // Default: only ready-to-cut statuses, so the LIMIT can never be exhausted
      // by thousands of wrong-status rows and silently hide the eligible subset
      // (Critic MAJOR). Reserved-but-ready details still surface (already_reserved).
      params.push(readyStatusIds);
      conditions.push(`od.production_status_id = ANY($${params.length}::smallint[])`);
    } else {
      // The configured ready-set resolved to ZERO status ids (e.g. typoed/unknown
      // codes). Fail closed — nothing is ready-to-cut — rather than dropping the
      // filter and returning every status unfiltered (leakage regression).
      conditions.push('false');
    }

    const result = await this.database.query<EligibleRow>(
      `
      SELECT od.detail_id, od.order_id, od.quantity, od.material_id,
             m.sheet_material_type_id, od.film_id, od.production_status_id, od.delete_flag,
             EXISTS (
               SELECT 1 FROM cut_job_item cji
               WHERE cji.order_detail_id = od.detail_id AND cji.is_active = true
             ) AS already_reserved
      FROM order_details od
      JOIN materials m ON m.material_id = od.material_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY od.detail_id
      LIMIT 2000
      `,
      params,
    );

    let noSheetSpecCount = 0;
    const details: EligibleDetailDto[] = result.rows.map((row) => {
      const candidate: DetailEligibilityCandidate = {
        detailId: toNum(row.detail_id),
        deleteFlag: Boolean(row.delete_flag),
        productionStatusId: row.production_status_id === null ? null : toNum(row.production_status_id),
        sheetMaterialTypeId: row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id),
        alreadyReserved: Boolean(row.already_reserved),
      };
      const { eligible, reason } = classifyDetailEligibility(candidate, { readyStatusIds });
      if (reason === 'no_sheet_spec') {
        noSheetSpecCount += 1;
      }
      return {
        orderDetailId: candidate.detailId,
        orderId: toNum(row.order_id),
        quantity: toNum(row.quantity),
        materialId: toNum(row.material_id),
        sheetMaterialTypeId: candidate.sheetMaterialTypeId,
        filmId: row.film_id === null ? null : toNum(row.film_id),
        eligible,
        ineligibleReason: reason,
      };
    });

    return { details, noSheetSpecCount };
  }

  async renderSheetPng(query: RenderSheetPngQuery): Promise<Buffer> {
    const { sheets } = await this.loadGroupRenderContext(query.cutGroupId);
    const sheet = sheets.find((s) => s.sheetIndex === query.sheetIndex);
    if (!sheet) {
      throw new CutGroupSheetNotFoundError(query.cutGroupId, query.sheetIndex);
    }
    const targetPx = await this.config.getRenderPresetPx(query.preset);
    return renderSheetPng({
      svg: sheet.svg,
      targetPx,
      sheetWidthMm: sheet.placements.sheet_width_mm,
      sheetHeightMm: sheet.placements.sheet_height_mm,
    });
  }

  async renderSheetSvg(query: RenderSheetSvgQuery): Promise<string> {
    const { sheets } = await this.loadGroupRenderContext(query.cutGroupId);
    const sheet = sheets.find((s) => s.sheetIndex === query.sheetIndex);
    if (!sheet) {
      throw new CutGroupSheetNotFoundError(query.cutGroupId, query.sheetIndex);
    }
    return sheet.svg;
  }

  async renderGroupPdf(query: RenderGroupPdfQuery): Promise<Buffer> {
    const { sheets } = await this.loadGroupRenderContext(query.cutGroupId);
    if (sheets.length === 0) {
      throw new CutGroupSheetNotFoundError(query.cutGroupId, 0);
    }
    return buildSheetsPdf(
      sheets.map((s) => ({ svg: s.svg, sheetWidthMm: s.placements.sheet_width_mm, sheetHeightMm: s.placements.sheet_height_mm })),
    );
  }

  async renderJobPdf(query: RenderJobPdfQuery): Promise<Buffer> {
    const groups = await this.database.query<{ cut_group_id: string | number }>(
      `SELECT cut_group_id FROM cut_group WHERE cut_job_id = $1 ORDER BY cut_group_id`,
      [query.cutJobId],
    );
    const pdfSheets: Array<{ svg: string; sheetWidthMm: number; sheetHeightMm: number }> = [];
    for (const groupRow of groups.rows) {
      const { sheets } = await this.loadGroupRenderContext(toNum(groupRow.cut_group_id));
      for (const sheet of sheets) {
        pdfSheets.push({ svg: sheet.svg, sheetWidthMm: sheet.placements.sheet_width_mm, sheetHeightMm: sheet.placements.sheet_height_mm });
      }
    }
    if (pdfSheets.length === 0) {
      throw new CutJobNotFoundError(query.cutJobId);
    }
    return buildSheetsPdf(pdfSheets);
  }

  async setPdfPrewarmState(query: SetPdfPrewarmStateQuery): Promise<void> {
    // Scope the write to the version the render was kicked for: a slow render of
    // version N must not clobber the state of a newer recalculation (version N+1).
    await this.database.query(
      `UPDATE cut_job SET pdf_prewarm_state = $2, pdf_prewarm_failure_reason = $3, updated_at = now()
       WHERE cut_job_id = $1 AND version = $4`,
      [query.cutJobId, query.state, query.reason ?? null, query.version],
    );
  }

  /**
   * Load every sheet of a group as a ready-to-render SVG, with a per-group label
   * context (order/detail + "instance N/qty"). Shared by PNG/SVG/PDF render.
   */
  private async loadGroupRenderContext(
    cutGroupId: number,
  ): Promise<{ sheets: Array<{ sheetIndex: number; placements: SheetPlacementsJson; svg: string }> }> {
    const allSheets = await this.database.query<{ sheet_index: number; placements: SheetPlacementsJson }>(
      `SELECT cgs.sheet_index, cgs.placements FROM cut_group_sheet cgs WHERE cgs.cut_group_id = $1 ORDER BY cgs.sheet_index`,
      [cutGroupId],
    );
    const quantities = computeGroupItemQuantities(
      allSheets.rows.map((row) => ({ sheetIndex: 0, placements: row.placements })),
    );

    // Map freecut item_id -> detail/order label.
    const items = await this.database.query<{ order_detail_id: string | number; order_id: string | number }>(
      `SELECT cji.order_detail_id, cji.order_id FROM cut_job_item cji WHERE cji.cut_group_id = $1`,
      [cutGroupId],
    );
    const orderByDetail = new Map<number, number>();
    for (const row of items.rows) {
      orderByDetail.set(toNum(row.order_detail_id), toNum(row.order_id));
    }

    const labelFor = (piece: FreecutPlacement): string => {
      const detailId = parseFreecutItemId(piece.item_id);
      const orderId = detailId === null ? null : orderByDetail.get(detailId) ?? null;
      const base = orderId !== null ? `№${orderId}-${detailId}` : `${piece.item_id}`;
      return formatPieceLabel(base, piece.instance, quantities.get(piece.item_id) ?? 1);
    };

    return {
      sheets: allSheets.rows.map((row) => ({
        sheetIndex: toNum(row.sheet_index),
        placements: row.placements,
        svg: buildSheetSvg({ sheet: row.placements, labelFor }),
      })),
    };
  }

  private async reserveDetail(
    tx: TransactionClient,
    cutJobId: number,
    detailId: number,
    readyStatusIds: readonly number[],
  ): Promise<number> {
    // Resolve the detail WITH its eligibility inputs (status + sheet spec) so the
    // backend enforces eligibility itself — never trusting the frontend's list
    // (Critic BLOCKER). delete_flag / wrong_status / no_sheet_spec are rejected
    // here; already_reserved is enforced by the partial unique index below (409).
    const detail = await tx.query<{
      order_id: string | number;
      quantity: string | number;
      production_status_id: number | null;
      delete_flag: boolean;
      sheet_material_type_id: string | number | null;
    }>(
      `SELECT od.order_id, od.quantity, od.production_status_id, od.delete_flag, m.sheet_material_type_id
       FROM order_details od
       JOIN materials m ON m.material_id = od.material_id
       WHERE od.detail_id = $1`,
      [detailId],
    );
    if (detail.rowCount === 0) {
      throw new CutOrderDetailNotFoundError(detailId);
    }
    const row = detail.rows[0];
    const eligibility = classifyDetailEligibility(
      {
        detailId,
        deleteFlag: row.delete_flag,
        productionStatusId: row.production_status_id === null ? null : toNum(row.production_status_id),
        sheetMaterialTypeId: row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id),
        alreadyReserved: false,
      },
      { readyStatusIds },
    );
    if (!eligibility.eligible) {
      throw new CutDetailNotEligibleError(detailId, eligibility.reason ?? 'ineligible');
    }
    const orderId = toNum(row.order_id);
    const quantity = toNum(row.quantity);
    try {
      await tx.query(
        `
        INSERT INTO cut_job_item (cut_job_id, order_detail_id, order_id, qty, is_active, freecut_item_id)
        VALUES ($1, $2, $3, $4, true, $5)
        `,
        [cutJobId, detailId, orderId, quantity, freecutItemId(detailId)],
      );
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new CutDetailAlreadyReservedError(detailId);
      }
      throw error;
    }
    return orderId;
  }

  private async resolveReadyStatusIds(): Promise<number[]> {
    const readyStatusCodes = await this.config.getReadyStatusCodes();
    const result = await this.database.query<{ production_status_id: string | number }>(
      `SELECT production_status_id FROM production_statuses WHERE production_status_code = ANY($1::text[])`,
      [[...readyStatusCodes]],
    );
    return result.rows.map((row) => toNum(row.production_status_id));
  }

  private async audit(
    tx: TransactionClient,
    currentUser: CurrentUser,
    input: {
      event: (typeof CUT_AUDIT_EVENTS)[keyof typeof CUT_AUDIT_EVENTS];
      cutJobId: number;
      requestId?: string;
      related?: {
        orderIds?: number[];
        materialIds?: Array<number | null>;
        sheetMaterialTypeIds?: Array<number | null>;
        cutGroupIds?: number[];
      };
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const actor: CutAuditActor = {
      id: currentUser.id,
      username: currentUser.username,
      role: currentUser.role,
    };
    await auditService.record(
      tx,
      buildCutAuditEvent({
        event: input.event,
        cutJobId: input.cutJobId,
        actor,
        requestId: input.requestId ?? AUDIT_SOURCE,
        source: AUDIT_SOURCE,
        related: {
          orderIds: cleanIds(input.related?.orderIds),
          materialIds: cleanIds(input.related?.materialIds),
          sheetMaterialTypeIds: cleanIds(input.related?.sheetMaterialTypeIds),
          cutGroupIds: cleanIds(input.related?.cutGroupIds),
        },
        metadata: input.metadata ?? null,
      }),
    );
  }
}

interface EligibleRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  quantity: string | number;
  material_id: string | number;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  production_status_id: string | number | null;
  delete_flag: boolean;
  already_reserved: boolean;
}

interface CuttableGroup {
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  filmTexture: boolean | null;
  smtWidthMm: number | null;
  smtHeightMm: number | null;
  orderIds: number[];
  materialIds: number[];
  items: Array<{ orderDetailId: number; orderId: number; qty: number; widthMm: number; heightMm: number; filmTexture: boolean | null }>;
}

function groupByCuttableKey(rows: CalcItemRow[]): Map<string, CuttableGroup> {
  const groups = new Map<string, CuttableGroup>();
  for (const row of rows) {
    const sheetMaterialTypeId = row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id);
    const filmId = row.film_id === null ? null : toNum(row.film_id);
    const key = `${sheetMaterialTypeId ?? 'null'}:${filmId ?? 'null'}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sheetMaterialTypeId,
        filmId,
        filmTexture: row.film_texture,
        smtWidthMm: row.smt_width_mm === null ? null : toNum(row.smt_width_mm),
        smtHeightMm: row.smt_height_mm === null ? null : toNum(row.smt_height_mm),
        orderIds: [],
        materialIds: [],
        items: [],
      };
      groups.set(key, group);
    }
    const orderId = toNum(row.order_id);
    group.orderIds.push(orderId);
    if (row.material_id !== undefined && row.material_id !== null) {
      group.materialIds.push(toNum(row.material_id));
    }
    group.items.push({
      orderDetailId: toNum(row.order_detail_id),
      orderId,
      qty: toNum(row.qty),
      widthMm: toNum(row.width_mm),
      heightMm: toNum(row.height_mm),
      filmTexture: row.film_texture,
    });
  }
  return groups;
}

async function loadCalcItems(tx: TransactionClient, cutJobId: number): Promise<CalcItemRow[]> {
  const result = await tx.query<CalcItemRow>(
    `
    SELECT cji.cut_job_item_id, cji.order_detail_id, cji.order_id, cji.qty,
           od.width AS width_mm, od.height AS height_mm, od.material_id,
           m.sheet_material_type_id, od.film_id, f.film_texture,
           smt.width_mm AS smt_width_mm, smt.height_mm AS smt_height_mm
    FROM cut_job_item cji
    JOIN order_details od ON od.detail_id = cji.order_detail_id
    JOIN materials m ON m.material_id = od.material_id
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = m.sheet_material_type_id
    LEFT JOIN films f ON f.film_id = od.film_id
    WHERE cji.cut_job_id = $1 AND cji.is_active = true
    ORDER BY cji.cut_job_item_id
    `,
    [cutJobId],
  );
  return result.rows;
}

async function loadJobForUpdate(tx: TransactionClient, cutJobId: number): Promise<{
  cutJobId: number;
  name: string;
  status: string;
  source: string;
  version: number;
  params: Record<string, unknown> | null;
}> {
  const result = await tx.query<CutJobLockRow>(
    `SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, params FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
    [cutJobId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CutJobNotFoundError(cutJobId);
  }
  return {
    cutJobId: toNum(row.cut_job_id),
    name: row.name,
    status: row.status,
    source: row.source,
    version: toNum(row.version),
    params: row.params,
  };
}

async function bumpVersion(tx: TransactionClient, cutJobId: number): Promise<void> {
  await tx.query(
    `UPDATE cut_job SET version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
    [cutJobId],
  );
}

function assertVersion(job: { cutJobId: number; version: number }, expected: number): void {
  if (job.version !== expected) {
    throw new CutStaleVersionError(job.cutJobId, expected, job.version);
  }
}

function assertMutable(job: { cutJobId: number; status: string }): void {
  if (!MUTABLE_STATUSES.has(job.status)) {
    throw new CutJobNotMutableError(job.cutJobId, job.status);
  }
}

interface JobRow extends QueryResultRow {
  cut_job_id: string | number;
  name: string;
  status: string;
  source: string;
  version: string | number;
  pdf_prewarm_state: string;
}

interface ItemRow extends QueryResultRow {
  cut_job_item_id: string | number;
  order_detail_id: string | number;
  order_id: string | number;
  qty: string | number;
  cut_group_id: string | number | null;
}

interface GroupRow extends QueryResultRow {
  cut_group_id: string | number;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  status: string;
  summary: Record<string, unknown> | null;
}

interface SheetRow extends QueryResultRow {
  cut_group_sheet_id: string | number;
  cut_group_id: string | number;
  sheet_index: number;
  png_cache_key: string | null;
  placements: SheetPlacementsJson;
}

async function loadJob(client: DatabaseClient, cutJobId: number): Promise<CutJobDto> {
  const jobResult = await client.query<JobRow>(
    `SELECT cut_job_id, name, status, source, version, pdf_prewarm_state FROM cut_job WHERE cut_job_id = $1`,
    [cutJobId],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) {
    throw new CutJobNotFoundError(cutJobId);
  }

  const itemsResult = await client.query<ItemRow>(
    `SELECT cut_job_item_id, order_detail_id, order_id, qty, cut_group_id FROM cut_job_item WHERE cut_job_id = $1 AND is_active = true ORDER BY cut_job_item_id`,
    [cutJobId],
  );
  const groupsResult = await client.query<GroupRow>(
    `SELECT cut_group_id, sheet_material_type_id, film_id, status, summary FROM cut_group WHERE cut_job_id = $1 ORDER BY cut_group_id`,
    [cutJobId],
  );
  const groupIds = groupsResult.rows.map((row) => toNum(row.cut_group_id));
  const sheetsResult = groupIds.length
    ? await client.query<SheetRow>(
        `SELECT cut_group_sheet_id, cut_group_id, sheet_index, png_cache_key, placements FROM cut_group_sheet WHERE cut_group_id = ANY($1::bigint[]) ORDER BY cut_group_id, sheet_index`,
        [groupIds],
      )
    : { rows: [] as SheetRow[] };

  const groups: CutGroupDto[] = groupsResult.rows.map((row) => {
    const cutGroupId = toNum(row.cut_group_id);
    return {
      cutGroupId,
      sheetMaterialTypeId: row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id),
      filmId: row.film_id === null ? null : toNum(row.film_id),
      status: row.status,
      summary: row.summary,
      sheets: sheetsResult.rows
        .filter((sheet) => toNum(sheet.cut_group_id) === cutGroupId)
        .map((sheet) => ({
          cutGroupSheetId: toNum(sheet.cut_group_sheet_id),
          sheetIndex: sheet.sheet_index,
          pngCacheKey: sheet.png_cache_key,
          placements: sheet.placements,
        })),
    };
  });

  return {
    cutJobId: toNum(jobRow.cut_job_id),
    name: jobRow.name,
    status: jobRow.status,
    source: jobRow.source,
    version: toNum(jobRow.version),
    pdfPrewarmState: jobRow.pdf_prewarm_state,
    items: itemsResult.rows.map((row) => ({
      cutJobItemId: toNum(row.cut_job_item_id),
      orderDetailId: toNum(row.order_detail_id),
      orderId: toNum(row.order_id),
      qty: toNum(row.qty),
      cutGroupId: row.cut_group_id === null ? null : toNum(row.cut_group_id),
    })),
    groups,
  };
}

async function setSessionUser(tx: TransactionClient, userId: string | number): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [String(userId)]);
}

function cleanIds(values: Array<number | null> | undefined): number[] {
  if (!values) return [];
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function toNum(value: string | number): number {
  return Number(value);
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
