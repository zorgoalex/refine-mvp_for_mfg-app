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
import {
  describeCutFailure,
  extractCutFailureStatus,
  shouldMarkCutFailed,
} from '../application/cut-failure-reason';
import { ApiError } from '../../../common/errors/api-error';
import { type CutConfigPort } from '../application/cut-config';
import { PgCutConfigRepository } from './pg-cut-config-repository';
import { resolveCalcParams } from './resolve-calc-params';
import type {
  AddCutItemsCommand,
  ArchiveCutJobCommand,
  CalculateCutJobCommand,
  CreateCutJobCommand,
  CutRepositoryPort,
  DetailLastReadyQuery,
  DetailPlacementsQuery,
  EligibleDetailsQuery,
  GetCutJobQuery,
  ListCutJobsQuery,
  RemoveCutItemCommand,
  RenderGroupPdfQuery,
  RenderJobPdfQuery,
  RenderSheetPngQuery,
  RenderSheetSvgQuery,
  SetCutJobProfileCommand,
  SetPdfPrewarmStateQuery,
} from '../application/cut-command.types';
import type {
  CutDetailInfoDto,
  CutDetailLastReadyResponseDto,
  CutDetailPlacementsResponseDto,
  CutGroupDto,
  CutJobDto,
  CutJobRefDto,
  CutJobTotals,
  EligibleDetailDto,
  EligibleDetailsResponseDto,
} from '../dto/cut.dto';
import { mapTotalsRow, TOTALS_BY_JOB_SQL, SHEETS_BY_JOB_SQL, type TotalsRow } from './cut-totals';
import { buildSheetSvg, composePieceLabelLines, computeGroupItemQuantities } from '../render/sheet-svg';
import { renderSheetPng } from '../render/sheet-png';
import { buildSheetsPdf } from '../render/sheet-pdf';
import {
  CutGroupSheetNotFoundError,
  CutJobItemNotFoundError,
  CutJobNotFoundError,
  CutDetailNotEligibleError,
  CutJobNotMutableError,
  CutNoItemsError,
  CutNoSheetSpecError,
  CutOrderDetailNotFoundError,
  CutParamProfileNotFoundError,
  CutStaleVersionError,
} from '../errors/cut.errors';

const AUDIT_SOURCE = 'backend-cut-command';

/**
 * Ready-to-cut statuses and the default freecut params are sourced from the
 * editable `cut_config` tables (migration 023) via {@link CutConfigPort}, with a
 * documented in-code fallback when the config is empty (see cut-config.ts).
 */

/**
 * Reservation is active (and the job mutable) only in these states. `failed` is
 * mutable so an operator can fix the basket and RE-RUN the calculation on the
 * same job instead of being forced to create a new one (a failed calc persists
 * no groups but keeps its reserved items). `archived` stays terminal.
 */
const MUTABLE_STATUSES = new Set(['draft', 'calculating', 'ready', 'failed']);

/** Profile selection is editable while the basket can still be (re)calculated,
 *  but NOT mid-calculation (the running solve already locked its params) and not
 *  on an archived job. */
const PROFILE_EDITABLE_STATUSES = new Set(['draft', 'ready', 'failed']);

/** Related audit dimensions when a Phase 1 failure has not yet resolved groups. */
interface CalcRelatedDimensions {
  orderIds: number[];
  sheetMaterialTypeIds: number[];
}
const EMPTY_RELATED: CalcRelatedDimensions = { orderIds: [], sheetMaterialTypeIds: [] };

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
  param_profile_id: string | number | null;
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

/** Idempotency key for the profile-changed outbox event. Stable for a given
 *  (job, request) so a transport-level duplicate of the SAME request can't emit
 *  two events; falls back to the version when no requestId is supplied. */
export function profileChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.profileChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
}

/** Idempotency key for the sheet-material-changed outbox event. Same stability
 *  rule as profileChangedOutboxKey: stable per (job, request), version fallback. */
export function sheetMaterialChangedOutboxKey(cutJobId: number, requestId: string | undefined, version: number): string {
  return `${CUT_AUDIT_EVENTS.sheetMaterialChanged}:${cutJobId}:${requestId ?? `v${version}`}`;
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
      const reservedSheetTypeIds: number[] = [];
      let insertedCount = 0;
      for (const detailId of command.dto.detailIds ?? []) {
        const { orderId, sheetMaterialTypeId, inserted } = await this.reserveDetail(tx, cutJobId, detailId, readyStatusIds);
        if (inserted) {
          reservedOrderIds.push(orderId);
          if (sheetMaterialTypeId !== null) reservedSheetTypeIds.push(sheetMaterialTypeId);
          insertedCount += 1;
        }
      }

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.created,
        cutJobId,
        requestId: command.requestId,
        related: { orderIds: reservedOrderIds, sheetMaterialTypeIds: reservedSheetTypeIds },
        metadata: { detailCount: insertedCount },
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
      const reservedSheetTypeIds: number[] = [];
      const insertedDetailIds: number[] = [];
      for (const detailId of command.dto.detailIds) {
        const { orderId, sheetMaterialTypeId, inserted } = await this.reserveDetail(tx, command.cutJobId, detailId, readyStatusIds);
        if (inserted) {
          reservedOrderIds.push(orderId);
          if (sheetMaterialTypeId !== null) reservedSheetTypeIds.push(sheetMaterialTypeId);
          insertedDetailIds.push(detailId);
        }
      }

      // No NEW rows (every requested detail was already in this job): no-op — skip the
      // version bump and the itemAdded audit so a same-job re-add neither churns the
      // optimistic version nor writes a misleading audit row (Critic AUDIT-DEBT).
      if (insertedDetailIds.length === 0) {
        return loadJob(tx, command.cutJobId);
      }

      await bumpVersion(tx, command.cutJobId);
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.itemAdded,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: { orderIds: reservedOrderIds, sheetMaterialTypeIds: reservedSheetTypeIds },
        metadata: { detailIds: insertedDetailIds },
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

      const released = await tx.query<{ order_id: string | number; order_detail_id: string | number; sheet_material_type_id: string | number | null }>(
        `
        UPDATE cut_job_item cji
        SET is_active = false, updated_at = now()
        FROM order_details od
        WHERE cji.cut_job_item_id = $1 AND cji.cut_job_id = $2 AND cji.is_active = true
          AND od.detail_id = cji.order_detail_id
        RETURNING cji.order_id, cji.order_detail_id, od.sheet_material_type_id
        `,
        [command.cutJobItemId, command.cutJobId],
      );
      if (released.rowCount === 0) {
        throw new CutJobItemNotFoundError(command.cutJobItemId);
      }
      const removedRow = released.rows[0];
      const removedSheetTypeId = removedRow.sheet_material_type_id === null ? null : toNum(removedRow.sheet_material_type_id);

      await bumpVersion(tx, command.cutJobId);
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.itemRemoved,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          orderIds: [toNum(removedRow.order_id)],
          sheetMaterialTypeIds: removedSheetTypeId !== null ? [removedSheetTypeId] : [],
        },
        metadata: { cutJobItemId: command.cutJobItemId },
      });

      return loadJob(tx, command.cutJobId);
    });
  }

  async calculate(command: CalculateCutJobCommand): Promise<CutJobDto> {
    // Phase 1 — read + validate + build request under a short lock (NOT held
    // across the external freecut call). A validation failure here (no items, no
    // sheet spec, instance/body limit) is a calculation outcome too: persist a
    // matching reason so the durable "Ошибка" never lingers stale from a prior
    // attempt (and never mismatches the live toast).
    // Captured as soon as Phase 1 has loaded+grouped the items, so a Phase 1
    // validation failure (no sheet spec / instance|body limit / grain) still
    // audits the affected order/material/sheet dimensions (query/report-ready),
    // not an empty related set. A throw before grouping (empty basket) leaves it
    // empty, which is correct — there are no affected entities to record.
    let phase1Related: CalcRelatedDimensions = EMPTY_RELATED;
    const prep = await this.database
      .transaction(async (tx) => {
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
      phase1Related = {
        orderIds: groups.flatMap((g) => g.orderIds),
        sheetMaterialTypeIds: groups
          .map((g) => g.sheetMaterialTypeId)
          .filter((id): id is number => id !== null),
      };
      // Resolve params from the job's chosen profile, or fall back to the
      // create-time snapshot (or runtime defaults for legacy jobs with no snapshot).
      // A non-null chosen profile that is inactive/missing is REJECTED with 422 —
      // never silently substituted — because the UI shows the chosen profile and
      // substituting surprise params would violate stale-safety. The operator must
      // clear or re-pick an active profile.
      let profileParams: FreecutParams | null = null;
      if (job.paramProfileId !== null) {
        profileParams = await this.config.getParamsByProfileId(job.paramProfileId);
        if (profileParams === null) {
          throw new CutParamProfileNotFoundError(job.paramProfileId);
        }
      }
      const params = resolveCalcParams({
        profileId: job.paramProfileId,
        jobParams: (job.params ?? null) as FreecutParams | null,
        profileParams,
        defaultParams: await this.config.getDefaultParams(),
      });
      const grainRules = await this.config.getGrainRules();

      const groupPreps = groups.map((group) => {
        if (group.sheetMaterialTypeId === null || group.smtWidthMm === null || group.smtHeightMm === null) {
          // A group whose material has no sheet spec cannot be cut; eligibility
          // surfaces this as no_sheet_spec before add, but fail closed here too.
          // Distinct error so the durable reason names the real cause (not "no items").
          throw new CutNoSheetSpecError(command.cutJobId);
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
             pdf_prewarm_state = 'pending', pdf_prewarm_failure_reason = NULL,
             failure_code = NULL, failure_reason = NULL, updated_at = now()
         WHERE cut_job_id = $1`,
        [command.cutJobId],
      );

      return { groupPreps, params, expectedVersion: job.version + 1 };
      })
      // A Phase 1 validation failure (no items / no sheet spec / instance|body
      // limit) is a calculation outcome: persist a matching reason. Guard on the
      // version the calc STARTED with (prep rolled back, so it is unchanged) — if a
      // concurrent archive/add/remove committed in the gap, the version no longer
      // matches and the failure write is skipped (supersede-safe, no clobber).
      // Concurrency / precondition errors pass through unchanged (markCalcFailed).
      .catch((error) => this.markCalcFailed(error, command, phase1Related, command.version));

    // Related dimensions aggregated across ALL groups (audit query/report-ready).
    const allOrderIds = prep.groupPreps.flatMap((p) => p.group.orderIds);
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
      // A freecut failure fails the WHOLE job. Guard the status write on THIS
      // calculation's version so a newer calculate/mutation in flight is not
      // clobbered (supersede-safe).
      await this.markCalcFailed(
        error,
        command,
        { orderIds: allOrderIds, sheetMaterialTypeIds: allSheetMaterialTypeIds },
        prep.expectedVersion,
      );
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
        SET status = 'ready', request_hash = $2, version = version + 1, updated_at = now()
        WHERE cut_job_id = $1
        `,
        [command.cutJobId, requestHash],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.calculated,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          orderIds: allOrderIds,
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
          // Scope the outbox idempotency key to the JOB: after migration 031 two
          // DIFFERENT jobs can legitimately share an identical detail set / params
          // (and thus requestHash). Without cutJobId the global dedupe would swallow
          // the second job's calculated event. Same-job re-calc still dedupes.
          `${CUT_AUDIT_EVENTS.calculated}:${command.cutJobId}:${requestHash}`,
        ],
      );

      return loadJob(tx, command.cutJobId);
    });
  }

  /**
   * Persist a calculation failure (Phase 1 validation or Phase 2 freecut) as a
   * durable code + operator reason, audit it, and re-throw a friendly ApiError
   * whose message matches the persisted reason. Precondition/concurrency errors
   * (stale version, not-mutable, not-found) pass through unchanged. Always throws.
   *
   * @param guardVersion the version this calc owns — Phase 2 passes the bumped
   *   `calculating` version (prep.expectedVersion); Phase 1 passes the original
   *   `command.version` (its prep tx rolled back, leaving the version unchanged).
   *   Either way the status write is guarded `WHERE version = guardVersion`, so a
   *   concurrent mutation that advanced the version is NOT clobbered (rowCount 0
   *   → the failure write is skipped). Both phases are supersede-safe.
   */
  private async markCalcFailed(
    error: unknown,
    command: CalculateCutJobCommand,
    related: CalcRelatedDimensions,
    guardVersion: number,
  ): Promise<never> {
    if (!shouldMarkCutFailed(error)) {
      // Not a calculation outcome — leave status/reason untouched.
      throw error;
    }
    const failure = describeCutFailure(error);
    const originalCode = (error as { code?: unknown })?.code;
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const failed = await tx.query(
        `UPDATE cut_job
         SET status = 'failed', failure_code = $3, failure_reason = $4,
             pdf_prewarm_state = 'pending', pdf_prewarm_failure_reason = NULL,
             version = version + 1, updated_at = now()
         WHERE cut_job_id = $1 AND version = $2`,
        [command.cutJobId, guardVersion, failure.code, failure.reason],
      );
      if (failed.rowCount === 0) {
        return; // superseded by a newer version — skip status + audit.
      }
      // A failed job must carry NO layout (invariant: never a stale group/PDF on
      // an "Ошибка" job). Phase 2's prep already dropped the prior result set, but
      // a Phase 1 failure rolled its prep back — so clear here for BOTH paths
      // uniformly (no-op when there is nothing to drop). cut_group_sheet cascades;
      // items stay active/reserved (FK ON DELETE SET NULL), unlinked for clarity.
      await tx.query(
        `UPDATE cut_job_item SET cut_group_id = NULL WHERE cut_job_id = $1 AND cut_group_id IS NOT NULL`,
        [command.cutJobId],
      );
      await tx.query(`DELETE FROM cut_group WHERE cut_job_id = $1`, [command.cutJobId]);
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.calculateFailed,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related,
        metadata: {
          // Raw technical message + original code for diagnostics, plus the
          // mapped code/reason the operator actually saw.
          error: error instanceof Error ? error.message : 'cut calculation error',
          code: typeof originalCode === 'string' ? originalCode : null,
          failureCode: failure.code,
          failureReason: failure.reason,
        },
      });
    });
    // Surface the friendly reason; preserve the original HTTP status (422/413/504/
    // ...) when the error carried one (duck-typed), else 500.
    throw new ApiError(extractCutFailureStatus(error), failure.code, failure.reason, {
      cutJobId: command.cutJobId,
      ...(typeof originalCode === 'string' ? { originalCode } : {}),
    });
  }

  archive(command: ArchiveCutJobCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const job = await loadJobForUpdate(tx, command.cutJobId);
      assertVersion(job, command.version);

      const released = await tx.query<{ order_id: string | number; sheet_material_type_id: string | number | null }>(
        `
        UPDATE cut_job_item cji
        SET is_active = false, updated_at = now()
        FROM order_details od
        WHERE cji.cut_job_id = $1 AND cji.is_active = true
          AND od.detail_id = cji.order_detail_id
        RETURNING cji.order_id, od.sheet_material_type_id
        `,
        [command.cutJobId],
      );
      await tx.query(
        `UPDATE cut_job SET status = 'archived', version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId],
      );

      const archivedSheetTypeIds = [
        ...new Set(
          released.rows
            .map((row) => (row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id)))
            .filter((id): id is number => id !== null),
        ),
      ];
      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.archived,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        related: {
          orderIds: released.rows.map((row) => toNum(row.order_id)),
          sheetMaterialTypeIds: archivedSheetTypeIds,
        },
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
    const ids = result.rows.map((row) => toNum(row.cut_job_id));
    const totalsById = await computeTotals(this.database, ids);
    const jobs: CutJobDto[] = [];
    for (const id of ids) {
      // List only renders item/group counts -> skip the per-item detail joins.
      jobs.push(await loadJob(this.database, id, false, totalsById.get(id)));
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
    addArrayFilter('od.sheet_material_type_id', query.criteria.sheetMaterialTypeIds);
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
             od.sheet_material_type_id,
             od.film_id, od.production_status_id, od.delete_flag,
             s.is_cuttable
      FROM order_details od
      LEFT JOIN sheet_material_types s ON s.sheet_material_type_id = od.sheet_material_type_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY od.detail_id
      LIMIT 2000
      `,
      params,
    );

    // Placement is informational, not exclusive (migration 031): a detail may be
    // in any number of jobs. Resolve where each candidate is already placed so the
    // UI can SHOW it without ever blocking the add.
    const placements = await this.loadDetailPlacements(
      this.database,
      result.rows.map((row) => toNum(row.detail_id)),
    );

    let noSheetSpecCount = 0;
    const details: EligibleDetailDto[] = result.rows.map((row) => {
      const candidate: DetailEligibilityCandidate = {
        detailId: toNum(row.detail_id),
        deleteFlag: Boolean(row.delete_flag),
        productionStatusId: row.production_status_id === null ? null : toNum(row.production_status_id),
        sheetMaterialTypeId: row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id),
        // When sheet_material_type_id is null (no_sheet_spec path), is_cuttable comes
        // back null from the LEFT JOIN. Default to true so the not_cuttable guard never
        // fires before no_sheet_spec handles the missing-spec case.
        // Also treat undefined (absent column in test stubs) as true for the same reason.
        isCuttable: row.is_cuttable == null ? true : Boolean(row.is_cuttable),
      };
      const { eligible, reason } = classifyDetailEligibility(candidate, { readyStatusIds });
      if (reason === 'no_sheet_spec') {
        noSheetSpecCount += 1;
      }
      const placement = placements.get(candidate.detailId);
      return {
        orderDetailId: candidate.detailId,
        orderId: toNum(row.order_id),
        quantity: toNum(row.quantity),
        materialId: row.material_id === null || row.material_id === undefined ? null : toNum(row.material_id),
        sheetMaterialTypeId: candidate.sheetMaterialTypeId,
        filmId: row.film_id === null ? null : toNum(row.film_id),
        eligible,
        ineligibleReason: reason,
        activeJobs: placement?.activeJobs ?? [],
        inArchivedJob: placement?.inArchivedJob ?? false,
      };
    });

    return { details, noSheetSpecCount };
  }

  /**
   * Per-detail cut-job placement (informational; migration 031 dropped exclusivity).
   * Returns, for each requested detail id, the distinct ACTIVE (non-archived) jobs
   * it sits in plus whether it also exists in any archived job.
   */
  private async loadDetailPlacements(
    client: DatabaseClient,
    detailIds: readonly number[],
  ): Promise<Map<number, { activeJobs: CutJobRefDto[]; inArchivedJob: boolean }>> {
    const map = new Map<number, { activeJobs: CutJobRefDto[]; inArchivedJob: boolean }>();
    if (detailIds.length === 0) return map;
    const rows = await client.query<{
      order_detail_id: string | number;
      cut_job_id: string | number;
      name: string;
      status: string;
      is_active: boolean;
    }>(
      `
      SELECT cji.order_detail_id, cj.cut_job_id, cj.name, cj.status, cji.is_active
      FROM cut_job_item cji
      JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
      WHERE cji.order_detail_id = ANY($1::bigint[])
      ORDER BY cj.cut_job_id
      `,
      [[...detailIds]],
    );
    for (const row of rows.rows) {
      const detailId = toNum(row.order_detail_id);
      const entry = map.get(detailId) ?? { activeJobs: [], inArchivedJob: false };
      const isArchived = row.status === 'archived';
      if (isArchived) {
        entry.inArchivedJob = true;
      } else if (row.is_active) {
        // a detail can appear once per active job; ORDER BY keeps these stable
        if (!entry.activeJobs.some((j) => j.cutJobId === toNum(row.cut_job_id))) {
          entry.activeJobs.push({ cutJobId: toNum(row.cut_job_id), name: row.name });
        }
      }
      map.set(detailId, entry);
    }
    return map;
  }

  /**
   * Subset of the given detail ids that are eligible to be added (same rule as the
   * add path: not deleted, ready production status, resolvable sheet type). Used to
   * keep placements precise — only details that WOULD be added are reported.
   */
  private async filterEligibleDetailIds(detailIds: readonly number[]): Promise<number[]> {
    if (detailIds.length === 0) return [];
    const readyStatusIds = await this.resolveReadyStatusIds();
    if (readyStatusIds.length === 0) return [];
    const result = await this.database.query<{ detail_id: string | number }>(
      `
      SELECT od.detail_id
      FROM order_details od
      WHERE od.detail_id = ANY($1::bigint[])
        AND od.delete_flag = false
        AND od.production_status_id = ANY($2::smallint[])
        AND od.sheet_material_type_id IS NOT NULL
      `,
      [[...detailIds], readyStatusIds],
    );
    return result.rows.map((row) => toNum(row.detail_id));
  }

  async listDetailPlacements(query: DetailPlacementsQuery): Promise<CutDetailPlacementsResponseDto> {
    // Resolve the target detail set: explicit detailIds win; else all non-deleted
    // details of the given orders.
    let detailIds = query.detailIds ?? [];
    if (detailIds.length === 0 && (query.orderIds?.length ?? 0) > 0) {
      const resolved = await this.database.query<{ detail_id: string | number }>(
        `SELECT detail_id FROM order_details WHERE order_id = ANY($1::bigint[]) AND delete_flag = false`,
        [[...(query.orderIds ?? [])]],
      );
      detailIds = resolved.rows.map((row) => toNum(row.detail_id));
    }
    // Show placements only for details that would actually be ADDED — i.e. the
    // eligible subset (ready status + sheet spec). Otherwise an order with a few
    // wrong-status / no-sheet-spec details would warn about placements for details
    // that the add path silently drops (Critic false-positive).
    const eligibleIds = await this.filterEligibleDetailIds(detailIds);
    const placements = await this.loadDetailPlacements(this.database, eligibleIds);
    const jobsById = new Map<number, CutJobRefDto>();
    let hasArchived = false;
    for (const entry of placements.values()) {
      for (const job of entry.activeJobs) {
        if (!jobsById.has(job.cutJobId)) jobsById.set(job.cutJobId, job);
      }
      if (entry.inArchivedJob) hasArchived = true;
    }
    const jobs = [...jobsById.values()].sort((a, b) => a.cutJobId - b.cutJobId);
    return { jobs, hasArchived };
  }

  async listDetailLastReady(query: DetailLastReadyQuery): Promise<CutDetailLastReadyResponseDto> {
    const detailIds = query.detailIds ?? [];
    if (detailIds.length === 0) return { details: [] };
    // One row per detail: the latest READY (calculated) job (by creation order,
    // cut_job_id DESC) that still actively contains it. Archiving overwrites
    // status off 'ready', so archived jobs are naturally excluded. We order by
    // cut_job_id (monotonic, immutable) NOT updated_at, which is bumped by
    // prewarm/profile/ready events and would yield "last touched" not the
    // latest-created ready job. Uses idx_cut_job_item_order_detail (migr 031).
    const rows = await this.database.query<{
      order_detail_id: string | number;
      cut_job_id: string | number;
      name: string;
    }>(
      `
      SELECT DISTINCT ON (cji.order_detail_id)
             cji.order_detail_id, cj.cut_job_id, cj.name
      FROM cut_job_item cji
      JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
      WHERE cji.order_detail_id = ANY($1::bigint[])
        AND cji.is_active = true
        AND cj.status = 'ready'
      ORDER BY cji.order_detail_id, cj.cut_job_id DESC
      `,
      [[...detailIds]],
    );
    return {
      details: rows.rows.map((row) => ({
        orderDetailId: toNum(row.order_detail_id),
        cutJobId: toNum(row.cut_job_id),
        name: row.name,
      })),
    };
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
   * Cut-gated sheet-type lookup (Variant B Task 11). Returns the minimal set of
   * fields needed for the /cut filter: id, name, dims, is_cuttable.
   * Active types only — inactive types are not selectable as cut criteria.
   * No cut.manage or sheet_materials.view required — cut.view is sufficient.
   */
  async listSheetTypesForCut(
    _query: import('../application/cut-command.types').ListSheetTypesForCutQuery,
  ): Promise<import('../application/cut-command.types').CutSheetTypeOption[]> {
    const result = await this.database.query<{
      sheet_material_type_id: string | number;
      name: string;
      material_type_id: string | number;
      thickness_mm: string | number;
      width_mm: string | number;
      height_mm: string | number;
      is_cuttable: boolean | null;
    }>(
      `SELECT sheet_material_type_id, name, material_type_id, thickness_mm, width_mm, height_mm, is_cuttable
       FROM sheet_material_types
       WHERE is_active = true AND is_cuttable = true
       ORDER BY name`,
    );
    return result.rows.map((row) => ({
      sheetMaterialTypeId: toNum(row.sheet_material_type_id),
      name: row.name,
      materialTypeId: toNum(row.material_type_id),
      thicknessMm: toNum(row.thickness_mm),
      widthMm: toNum(row.width_mm),
      heightMm: toNum(row.height_mm),
      isCuttable: row.is_cuttable == null ? true : Boolean(row.is_cuttable),
    }));
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

    const labelFor = (piece: FreecutPlacement): string[] => {
      const detailId = parseFreecutItemId(piece.item_id);
      const orderId = detailId === null ? null : orderByDetail.get(detailId) ?? null;
      // Order on line 1, detail (+ instance N/qty) on line 2 — rendered as
      // separate <tspan> lines by buildSheetSvg.
      return composePieceLabelLines({
        orderId,
        detailId,
        itemId: piece.item_id,
        instance: piece.instance,
        qty: quantities.get(piece.item_id) ?? 1,
      });
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
  ): Promise<{ orderId: number; sheetMaterialTypeId: number | null; inserted: boolean }> {
    // Resolve the detail WITH its eligibility inputs (status + sheet spec + is_cuttable)
    // so the backend enforces eligibility itself — never trusting the frontend's list
    // (Critic BLOCKER). delete_flag / wrong_status / not_cuttable / no_sheet_spec are
    // rejected here.
    const detail = await tx.query<{
      order_id: string | number;
      quantity: string | number;
      production_status_id: number | null;
      delete_flag: boolean;
      sheet_material_type_id: string | number | null;
      is_cuttable: boolean | null;
    }>(
      `SELECT od.order_id, od.quantity, od.production_status_id, od.delete_flag,
              od.sheet_material_type_id, s.is_cuttable
       FROM order_details od
       LEFT JOIN sheet_material_types s ON s.sheet_material_type_id = od.sheet_material_type_id
       WHERE od.detail_id = $1`,
      [detailId],
    );
    if (detail.rowCount === 0) {
      throw new CutOrderDetailNotFoundError(detailId);
    }
    const row = detail.rows[0];
    const sheetMaterialTypeId = row.sheet_material_type_id === null ? null : toNum(row.sheet_material_type_id);
    const eligibility = classifyDetailEligibility(
      {
        detailId,
        deleteFlag: row.delete_flag,
        productionStatusId: row.production_status_id === null ? null : toNum(row.production_status_id),
        sheetMaterialTypeId,
        isCuttable: row.is_cuttable == null ? true : Boolean(row.is_cuttable),
      },
      { readyStatusIds },
    );
    if (!eligibility.eligible) {
      throw new CutDetailNotEligibleError(detailId, eligibility.reason ?? 'ineligible');
    }
    const orderId = toNum(row.order_id);
    const quantity = toNum(row.quantity);
    // Placement is non-exclusive across jobs (migration 031): the same detail may be
    // in many jobs. WITHIN one job it is unique-and-idempotent — re-adding the same
    // detail is a no-op (ON CONFLICT on the per-job partial unique index), so the
    // requested cut quantity is never silently doubled. `inserted` reports whether a
    // NEW row was actually written, so callers can avoid version/audit churn on no-ops.
    const insert = await tx.query(
      `
      INSERT INTO cut_job_item (cut_job_id, order_detail_id, order_id, qty, is_active, freecut_item_id)
      VALUES ($1, $2, $3, $4, true, $5)
      ON CONFLICT (cut_job_id, order_detail_id) WHERE is_active = true DO NOTHING
      RETURNING cut_job_item_id
      `,
      [cutJobId, detailId, orderId, quantity, freecutItemId(detailId)],
    );
    return { orderId, sheetMaterialTypeId, inserted: (insert.rowCount ?? 0) > 0 };
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
        sheetMaterialTypeIds?: Array<number | null>;
        cutGroupIds?: number[];
      };
      metadata?: Record<string, unknown> | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      diff?: Record<string, unknown> | null;
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
          sheetMaterialTypeIds: cleanIds(input.related?.sheetMaterialTypeIds),
          cutGroupIds: cleanIds(input.related?.cutGroupIds),
        },
        metadata: input.metadata ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        diff: input.diff ?? null,
      }),
    );
  }

  setProfile(command: SetCutJobProfileCommand): Promise<CutJobDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const jobRes = await tx.query<{ cut_job_id: string | number; status: string; version: string | number; param_profile_id: string | number | null }>(
        `SELECT cut_job_id, status, version, param_profile_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
        [command.cutJobId],
      );
      const row = jobRes.rows[0];
      if (!row) throw new CutJobNotFoundError(command.cutJobId);
      assertVersion({ cutJobId: command.cutJobId, version: toNum(row.version) }, command.version);
      if (!PROFILE_EDITABLE_STATUSES.has(row.status)) {
        throw new CutJobNotMutableError(command.cutJobId, row.status);
      }
      if (command.paramProfileId !== null) {
        const exists = await tx.query(
          `SELECT 1 FROM cut_param_profiles WHERE cut_param_profile_id = $1 AND is_active = true LIMIT 1`,
          [command.paramProfileId],
        );
        if (exists.rows.length === 0) throw new CutParamProfileNotFoundError(command.paramProfileId);
      }
      const beforeProfileId = row.param_profile_id === null ? null : toNum(row.param_profile_id);

      // No-op short-circuit (fixes [AUDIT-DEBT]/[NOTIFICATION-DEBT]): an unchanged
      // selection must NOT bump version, write audit, or emit an outbox event —
      // mirrors the repo's existing no-op handling and prevents fake
      // profile_changed rows + needless stale-version conflicts on replays.
      if (beforeProfileId === command.paramProfileId) {
        return loadJob(tx, command.cutJobId);
      }

      await tx.query(
        `UPDATE cut_job SET param_profile_id = $2, version = version + 1, updated_at = now() WHERE cut_job_id = $1`,
        [command.cutJobId, command.paramProfileId],
      );

      await this.audit(tx, command.currentUser, {
        event: CUT_AUDIT_EVENTS.profileChanged,
        cutJobId: command.cutJobId,
        requestId: command.requestId,
        before: { paramProfileId: beforeProfileId },
        after: { paramProfileId: command.paramProfileId },
        metadata: { beforeProfileId, afterProfileId: command.paramProfileId },
      });

      await tx.query(
        `
        INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          CUT_AUDIT_EVENTS.profileChanged,
          'cut_job',
          String(command.cutJobId),
          JSON.stringify({
            cutJobId: command.cutJobId,
            beforeProfileId,
            afterProfileId: command.paramProfileId,
            actorUserId: command.currentUser.id,
            requestId: command.requestId ?? null,
          }),
          profileChangedOutboxKey(command.cutJobId, command.requestId, command.version),
        ],
      );

      return loadJob(tx, command.cutJobId);
    });
  }
}

interface EligibleRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  quantity: string | number;
  material_id: string | number | null;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  production_status_id: string | number | null;
  delete_flag: boolean;
  /** NULL when sheet_material_type_id is NULL (LEFT JOIN produces no row). */
  is_cuttable: boolean | null;
}

interface CuttableGroup {
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  filmTexture: boolean | null;
  smtWidthMm: number | null;
  smtHeightMm: number | null;
  orderIds: number[];
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
        items: [],
      };
      groups.set(key, group);
    }
    const orderId = toNum(row.order_id);
    group.orderIds.push(orderId);
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
           od.sheet_material_type_id, od.film_id, f.film_texture,
           smt.width_mm AS smt_width_mm, smt.height_mm AS smt_height_mm
    FROM cut_job_item cji
    JOIN order_details od ON od.detail_id = cji.order_detail_id
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
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
  paramProfileId: number | null;
}> {
  const result = await tx.query<CutJobLockRow>(
    `SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, params, param_profile_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE`,
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
    paramProfileId: row.param_profile_id === null || row.param_profile_id === undefined ? null : toNum(row.param_profile_id),
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
  failure_code: string | null;
  failure_reason: string | null;
  param_profile_id: string | number | null;
}

interface ItemRow extends QueryResultRow {
  cut_job_item_id: string | number;
  order_detail_id: string | number;
  order_id: string | number;
  qty: string | number;
  cut_group_id: string | number | null;
  // Enriched order-detail fields (present only when includeItemDetails); null when
  // the source order_detail no longer exists. Price/sum are intentionally omitted.
  // joined_detail_id is the existence sentinel: NULL iff the LEFT JOIN found no
  // live (non-deleted) detail. Never key existence off user data (detail_number).
  joined_detail_id?: string | number | null;
  detail_number?: string | number | null;
  detail_name?: string | null;
  height?: string | number | null;
  width?: string | number | null;
  detail_quantity?: string | number | null;
  area?: string | number | null;
  material_id?: string | number | null;
  sheet_material_type_id?: string | number | null;
  material_name?: string | null;
  milling_type_id?: string | number | null;
  milling_type_name?: string | null;
  edge_type_id?: string | number | null;
  edge_type_name?: string | null;
  film_id?: string | number | null;
  film_name?: string | null;
  priority?: string | number | null;
  production_status_id?: string | number | null;
  production_status_name?: string | null;
  joint_order_id?: string | number | null;
  note?: string | null;
  link_cutting_file?: string | null;
  link_cutting_image_file?: string | null;
  link_cad_file?: string | null;
  link_pdf_file?: string | null;
}

// Enriched item query: joins order_details + dictionaries to resolve the order
// form's detail fields (names, not bare ids) for the /cut "Детали задания" table.
// LEFT JOINs so a reserved-then-hard-deleted detail still returns its item row
// (detail fields null). Price columns (milling_cost_per_sqm, detail_cost) are
// deliberately not selected — the cut surface is production-facing, not financial.
const ENRICHED_ITEMS_QUERY = `
  SELECT i.cut_job_item_id, i.order_detail_id, i.order_id, i.qty, i.cut_group_id,
         od.detail_id AS joined_detail_id,
         od.detail_number, od.detail_name, od.height, od.width,
         od.quantity AS detail_quantity, od.area,
         od.material_id, od.sheet_material_type_id,
         COALESCE(smt.name, m.material_name) AS material_name,
         od.milling_type_id, mt.milling_type_name,
         od.edge_type_id, et.edge_type_name,
         od.film_id, f.film_name,
         od.priority, od.production_status_id, ps.production_status_name,
         od.joint_order_id, od.note,
         od.link_cutting_file, od.link_cutting_image_file, od.link_cad_file, od.link_pdf_file
  FROM cut_job_item i
  -- delete_flag in the JOIN (not WHERE): a reserved detail that was later soft-
  -- deleted must still return its item row, but with detail: null (canonical
  -- read-side semantics exclude deleted details — see order_details_view).
  LEFT JOIN order_details od ON od.detail_id = i.order_detail_id AND od.delete_flag = false
  LEFT JOIN materials m ON m.material_id = od.material_id
  LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
  LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
  LEFT JOIN edge_types et ON et.edge_type_id = od.edge_type_id
  LEFT JOIN films f ON f.film_id = od.film_id
  LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
  WHERE i.cut_job_id = $1 AND i.is_active = true
  ORDER BY i.cut_job_item_id
`;

const LIGHT_ITEMS_QUERY = `SELECT cut_job_item_id, order_detail_id, order_id, qty, cut_group_id FROM cut_job_item WHERE cut_job_id = $1 AND is_active = true ORDER BY cut_job_item_id`;

function mapItemDetail(row: ItemRow): CutDetailInfoDto | null {
  // Existence keyed off the joined PK, not user data: NULL means the LEFT JOIN
  // matched no live detail (hard-deleted or soft-deleted via delete_flag).
  if (row.joined_detail_id === undefined || row.joined_detail_id === null) {
    return null;
  }
  return {
    detailNumber: numOrNull(row.detail_number),
    detailName: row.detail_name ?? null,
    height: numOrNull(row.height),
    width: numOrNull(row.width),
    quantity: numOrNull(row.detail_quantity),
    area: numOrNull(row.area),
    materialId: numOrNull(row.material_id),
    sheetMaterialTypeId: numOrNull(row.sheet_material_type_id),
    materialName: row.material_name ?? null,
    millingTypeId: numOrNull(row.milling_type_id),
    millingTypeName: row.milling_type_name ?? null,
    edgeTypeId: numOrNull(row.edge_type_id),
    edgeTypeName: row.edge_type_name ?? null,
    filmId: numOrNull(row.film_id),
    filmName: row.film_name ?? null,
    priority: numOrNull(row.priority),
    productionStatusId: numOrNull(row.production_status_id),
    productionStatusName: row.production_status_name ?? null,
    jointOrderId: numOrNull(row.joint_order_id),
    note: row.note ?? null,
    linkCuttingFile: row.link_cutting_file ?? null,
    linkCuttingImageFile: row.link_cutting_image_file ?? null,
    linkCadFile: row.link_cad_file ?? null,
    linkPdfFile: row.link_pdf_file ?? null,
  };
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

async function computeTotals(client: DatabaseClient, cutJobIds: number[]): Promise<Map<number, CutJobTotals>> {
  const out = new Map<number, CutJobTotals>();
  for (const id of cutJobIds) out.set(id, { positions: 0, details: 0, area: 0, sheets: 0 });
  if (cutJobIds.length === 0) return out;
  // SEQUENTIAL, not Promise.all: loadJob/computeTotals run inside command
  // transactions on a single pg client/connection. Two concurrent queries on one
  // connection corrupt the wire protocol — await them one at a time.
  const agg = await client.query<TotalsRow & { cut_job_id: string | number }>(TOTALS_BY_JOB_SQL, [cutJobIds]);
  const sheets = await client.query<{ cut_job_id: string | number; sheets: string | number }>(SHEETS_BY_JOB_SQL, [cutJobIds]);
  for (const row of agg.rows) {
    const id = toNum(row.cut_job_id);
    out.set(id, mapTotalsRow({ ...row, sheets: out.get(id)?.sheets ?? 0 }));
  }
  for (const row of sheets.rows) {
    const id = toNum(row.cut_job_id);
    const cur = out.get(id) ?? { positions: 0, details: 0, area: 0, sheets: 0 };
    out.set(id, { ...cur, sheets: toNum(row.sheets) });
  }
  return out;
}

async function loadJob(
  client: DatabaseClient,
  cutJobId: number,
  includeItemDetails = true,
  totals?: CutJobTotals,
): Promise<CutJobDto> {
  const jobResult = await client.query<JobRow>(
    `SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, failure_code, failure_reason, param_profile_id FROM cut_job WHERE cut_job_id = $1`,
    [cutJobId],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) {
    throw new CutJobNotFoundError(cutJobId);
  }
  const resolvedTotals = totals ?? (await computeTotals(client, [cutJobId])).get(cutJobId)!;

  // The list view only needs item counts, so it opts out of the dictionary joins
  // (it loads up to 200 jobs); single-job reads enrich each item with full detail.
  const itemsResult = await client.query<ItemRow>(
    includeItemDetails ? ENRICHED_ITEMS_QUERY : LIGHT_ITEMS_QUERY,
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
    failureCode: jobRow.failure_code,
    failureReason: jobRow.failure_reason,
    paramProfileId: jobRow.param_profile_id === null || jobRow.param_profile_id === undefined ? null : toNum(jobRow.param_profile_id),
    totals: resolvedTotals,
    items: itemsResult.rows.map((row) => ({
      cutJobItemId: toNum(row.cut_job_item_id),
      orderDetailId: toNum(row.order_detail_id),
      orderId: toNum(row.order_id),
      qty: toNum(row.qty),
      cutGroupId: row.cut_group_id === null ? null : toNum(row.cut_group_id),
      detail: includeItemDetails ? mapItemDetail(row) : null,
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
