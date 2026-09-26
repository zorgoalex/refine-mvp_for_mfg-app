import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { buildOrderReadScopePredicate, normalizeActorUserId, orderAssignmentExistsSql } from '../../../permissions/policies/order-read-scope-sql';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { requireMdfCommandBoundary, type MdfCommandWriter } from '../application/mdf-command-boundary';
import { recordMdfBathTransition, recordMdfReceipt } from '../application/mdf-receipt';
import { loadMdfExecutionDetails } from './mdf-execution-snapshot';

/**
 * §5.4b bath lifecycle. A cut job has at most one ACTIVE bath: the captured source of its current,
 * non-archived result of a non-archived job. Cut commands that change which result that is call
 * `beginMdfBathLifecycle` BEFORE their cut-job lock (it authorizes and locks every affected owner in
 * ascending order) and `finish` after their writes (under the job lock). A change retires the previous
 * bath B and captures the successor N under one authenticated transition, accepted only by B's job.
 */
export interface MdfBathLifecycle {
  /** Recalculation pre-write gate: production on the active bath or an unresolved transition ⇒ 409. */
  assertRetargetAllowed(): Promise<void>;
  /** Call right after the command's cut-job lock: the pre-read active bath must still be current. */
  revalidate(): Promise<void>;
  /** After the command's writes; any conflict throws and rolls back the whole command transaction. */
  finish(input: { requestId: string; commandKey: string; fenced: boolean }): Promise<'none' | 'done'>;
  /** Result id of the active bath before the command. */
  readonly previousResultId: number | null;
  /** The job had a captured, non-retired bath before the command. */
  readonly hasActiveBath: boolean;
}

interface ActiveBath { resultId: number | null; sourceId: string | null; status: 'none' | 'active' | 'retired' | 'uncaptured' }

const sourceOf = (resultId: number) => `cut-result:${resultId}`;
const isMdf = (name: string | null) => new RegExp(MDF, 'i').test(name ?? '') && !new RegExp(OTHER, 'i').test(name ?? '');

async function activeResult(tx: TransactionClient, cutJobId: number): Promise<number | null> {
  const row = (await tx.query<{ status: string; current: string | null; archived: boolean }>(`SELECT j.status,
      j.current_cut_result_id::text current,(archive.archived_at IS NOT NULL) archived
    FROM cut_job j LEFT JOIN cut_result r ON r.cut_result_id=j.current_cut_result_id
    LEFT JOIN cut_result_archive_state archive ON archive.cut_job_id=j.cut_job_id AND archive.result_no=r.result_no
    WHERE j.cut_job_id=$1`, [cutJobId])).rows[0];
  if (!row || row.status === 'archived' || row.current === null || row.archived) return null;
  return Number(row.current);
}

async function bathOf(tx: TransactionClient, resultId: number | null): Promise<ActiveBath> {
  if (resultId === null) return { resultId: null, sourceId: null, status: 'none' };
  const sourceId = sourceOf(resultId);
  const head = (await tx.query<{ received: string; retired: boolean }>(`SELECT h.received_revision_key received,
      EXISTS(SELECT 1 FROM mdf_bath_transitions t WHERE t.retired_source_id=h.source_id
        AND t.retired_revision_key=h.received_revision_key) retired
    FROM mdf_source_heads h WHERE h.source_kind='bath' AND h.source_id=$1`, [sourceId])).rows[0];
  if (!head) return { resultId, sourceId, status: 'uncaptured' };
  return { resultId, sourceId, status: head.retired ? 'retired' : 'active' };
}

async function bathOwners(tx: TransactionClient, sourceId: string): Promise<number[]> {
  return (await tx.query<{ id: string }>(`SELECT DISTINCT order_id::text id FROM (
      SELECT d.order_id FROM mdf_source_heads h JOIN mdf_revision_demand d ON d.source_kind=h.source_kind
        AND d.source_id=h.source_id AND d.revision_key IN (h.accepted_revision_key,h.received_revision_key)
        WHERE h.source_kind='bath' AND h.source_id=$1
      UNION SELECT a.order_id FROM mdf_bath_allocations a WHERE a.bath_id=$1 AND a.state<>'released') o ORDER BY 1`,
  [sourceId])).rows.map(r => Number(r.id));
}

async function resultOwners(tx: TransactionClient, resultId: number): Promise<number[]> {
  return (await tx.query<{ id: string }>(`SELECT DISTINCT p.order_id::text id FROM cut_result_placement p
    JOIN cut_result_sheet_map s ON s.cut_result_sheet_map_id=p.cut_result_sheet_map_id AND s.cut_result_id=p.cut_result_id
    WHERE p.cut_result_id=$1 AND s.is_effective AND p.order_id IS NOT NULL ORDER BY 1`, [resultId])).rows.map(r => Number(r.id));
}

async function hasProduction(tx: TransactionClient, sourceId: string): Promise<boolean> {
  return (await tx.query<{ found: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM mdf_source_heads h JOIN mdf_evidence_lines e ON e.source_kind=h.source_kind AND e.source_id=h.source_id
        AND e.revision_key IN (h.accepted_revision_key,h.received_revision_key) AND e.stage_code='laminated'
      WHERE h.source_kind='bath' AND h.source_id=$1)
    OR EXISTS(SELECT 1 FROM mdf_bath_allocations WHERE bath_id=$1 AND state='consumed') found`, [sourceId])).rows[0].found;
}

async function hasPendingTransition(tx: TransactionClient, cutJobId: number): Promise<boolean> {
  return (await tx.query<{ found: boolean }>(`SELECT EXISTS(SELECT 1 FROM mdf_bath_transitions t
    JOIN mdf_recalculation_jobs j ON j.job_id=t.job_id WHERE t.cut_job_id=$1 AND j.status IN ('pending','needs_attention')) found`,
  [cutJobId])).rows[0].found;
}

/** Same authority as a cut calculation (literal `cut.manage` + `orders.view`) with the backend view scope
 * over EVERY affected owner (the retired bath's and the successor's); locks them ascending. */
async function authorizeAndLockOwners(tx: TransactionClient, user: CurrentUser, owners: readonly number[]): Promise<void> {
  if (!owners.length) return;
  if (!(['cut.manage', 'orders.view'] as const).every(p => user.permissions.includes(p))) denied();
  // Lock first (ascending), THEN evaluate the scope on the locked rows: a concurrent reassignment that
  // committed while we waited is seen, and none can commit afterwards until this command ends.
  await tx.query('SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[]) ORDER BY order_id FOR UPDATE', [[...owners]]);
  const scope = rolePolicyForUser(user).orders.view;
  const params: unknown[] = [[...owners]];
  const actor = scope === 'own' || scope === 'assigned' ? params.push(normalizeActorUserId(user.id)) : null;
  const predicate = buildOrderReadScopePredicate(scope, actor, actor === null ? 'FALSE' : orderAssignmentExistsSql('o', actor), 'o');
  const allowed = (await tx.query(`SELECT o.order_id FROM orders o WHERE o.order_id=ANY($1::bigint[]) AND ${predicate}`, params)).rows;
  if (allowed.length !== owners.length) denied();
}

/** Membership of a (possibly historical) result from its immutable placements; live details must still hold it. */
async function successorMembers(tx: TransactionClient, resultId: number) {
  // Only a vacuum-table result is a bath (same eligibility as `captureNewMdfBathResult`).
  const vacuum = (await tx.query<{ isVacuum: boolean }>(`SELECT b.is_vacuum "isVacuum" FROM cut_result r
    JOIN cut_result_board_projection b ON b.cut_result_id=r.cut_result_id AND b.snapshot_digest=r.snapshot_digest
    WHERE r.cut_result_id=$1`, [resultId])).rows[0];
  if (!vacuum?.isVacuum) return [];
  const rows = (await tx.query<{ itemId: string; orderId: number | null; detailId: number | null; quantity: number;
    material: string | null; liveOrderId: number | null; liveQuantity: number | null }>(`SELECT p.item_id "itemId",
      p.order_id::float8 "orderId",p.order_detail_id::float8 "detailId",count(*)::float8 quantity,
      COALESCE(mt.name,m.material_name) material,d.order_id::float8 "liveOrderId",d.quantity::float8 "liveQuantity"
    FROM cut_result_placement p JOIN cut_result_sheet_map s ON s.cut_result_sheet_map_id=p.cut_result_sheet_map_id
      AND s.cut_result_id=p.cut_result_id AND s.is_effective
    LEFT JOIN order_details d ON d.detail_id=p.order_detail_id AND NOT d.delete_flag
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE p.cut_result_id=$1 AND p.order_detail_id IS NOT NULL
    GROUP BY p.item_id,p.order_id,p.order_detail_id,mt.name,m.material_name,d.order_id,d.quantity
    ORDER BY p.item_id LIMIT 5001`, [resultId])).rows;
  if (rows.length > 5000) invalidSuccessor();
  const members: { lineKey: string; orderId: number; detailId: number; quantity: number }[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    // A historical placement whose detail no longer exists (or moved) cannot be classified — reject it
    // instead of silently dropping it as «non-MDF».
    if (r.orderId === null || r.detailId === null || r.liveOrderId !== r.orderId || r.liveQuantity === null) invalidSuccessor();
    if (!isMdf(r.material)) continue;
    if (r.quantity > r.liveQuantity! || seen.has(r.detailId!)) invalidSuccessor();
    seen.add(r.detailId as number);
    members.push({ lineKey: r.itemId, orderId: r.orderId!, detailId: r.detailId!, quantity: r.quantity });
  }
  return members;
}

export async function beginMdfBathLifecycle(tx: TransactionClient, input: {
  writer: MdfCommandWriter['writer']; capability?: MdfCommandWriter['capability']; cutJobId: number; user: CurrentUser;
  /** Known target result (current after the command), or undefined when it is produced by the command. */
  nextResultId?: number | null;
  /** Owners of a result the command will create (manual layout: same items as the current result). */
  ownerHintResultId?: number | null;
  /** Owners the command already authorized and locked (calculation basket scope). */
  ownerIds?: readonly number[];
}): Promise<MdfBathLifecycle | null> {
  const boundary = await requireMdfCommandBoundary(tx, { writer: input.writer, capability: input.capability ?? 'bath-lifecycle' });
  if (boundary.mode !== 'active' && boundary.mode !== 'read_only') return null;
  const previous = await bathOf(tx, await activeResult(tx, input.cutJobId));
  const known = input.nextResultId !== undefined;
  const noImpact = known && input.nextResultId === previous.resultId;
  const owners = noImpact ? [] : [...new Set([
    ...(previous.status === 'active' ? await bathOwners(tx, previous.sourceId!) : []),
    ...(typeof input.nextResultId === 'number' ? await resultOwners(tx, input.nextResultId) : []),
    ...(typeof input.ownerHintResultId === 'number' ? await resultOwners(tx, input.ownerHintResultId) : []),
    ...(noImpact ? [] : input.ownerIds ?? []),
  ])].sort((a, b) => a - b);
  if (owners.length > 100) throw new ApiError(409, 'MDF_BATH_SCOPE_LIMIT', 'Слишком много заказов затронуто изменением раскроя');
  await authorizeAndLockOwners(tx, input.user, owners);
  const locked = new Set(owners);
  const readOnly = boundary.mode === 'read_only';
  return {
    previousResultId: previous.resultId,
    hasActiveBath: previous.status === 'active',
    async revalidate() {
      const current = await bathOf(tx, await activeResult(tx, input.cutJobId));
      if (current.resultId !== previous.resultId || current.status !== previous.status) stale();
    },
    async assertRetargetAllowed() {
      // Job-wide first: an unresolved transition (e.g. a pending retirement without successor) blocks any fresh
      // calculation before its preparation writes, whether or not an active bath remains.
      if (await hasPendingTransition(tx, input.cutJobId)) { if (readOnly) readOnlyConflict(); pendingConflict(); }
      if (previous.status !== 'active') return;
      if (readOnly) readOnlyConflict();
      if (await hasProduction(tx, previous.sourceId!)) productionConflict();
    },
    async finish(command) {
      const nextResultId = await activeResult(tx, input.cutJobId);
      if (nextResultId === previous.resultId) return 'none';
      const next = await bathOf(tx, nextResultId);
      // Nothing to retire and nothing MDF to capture ⇒ no MDF consequence.
      const nextMembers = next.status === 'uncaptured' ? await successorMembers(tx, nextResultId!) : [];
      if (previous.status !== 'active' && !nextMembers.length && next.status !== 'retired') return 'none';
      if (readOnly) readOnlyConflict();
      if (!command.fenced) throw new ApiError(428, 'MDF_BATH_FENCE_REQUIRED', 'Нужны версия задания и ключ идемпотентности');
      // Job-wide: no new transition or recreation while any transition of this job is unresolved.
      if (await hasPendingTransition(tx, input.cutJobId)) pendingConflict();
      if (next.status === 'retired') throw new ApiError(409, 'MDF_BATH_RESULT_RETIRED',
        'Этот вариант раскроя уже выведен из МДФ-учёта — пересчитайте раскрой');
      if (next.status === 'active') stale();
      const nextOwners = nextMembers.length ? await resultOwners(tx, nextResultId!) : [];
      if (nextOwners.some(id => !locked.has(id))) stale();
      if (previous.status === 'active') {
        if (await hasPendingTransition(tx, input.cutJobId)) pendingConflict();
        if (await hasProduction(tx, previous.sourceId!)) productionConflict();
      }
      const demandOwners = [...new Set(nextMembers.map(m => m.orderId))].sort((a, b) => a - b);
      const demand = demandOwners.length ? await loadMdfExecutionDetails(tx, demandOwners) : [];
      for (const m of nextMembers) if (!demand.some(d => d.orderId === m.orderId && d.detailId === m.detailId && d.quantity >= m.quantity)) invalidSuccessor();
      const header = nextMembers.length ? (await tx.query<{ name: string; createdAt: string }>(`SELECT j.name,
          r.created_at::text "createdAt" FROM cut_result r JOIN cut_job j ON j.cut_job_id=r.cut_job_id WHERE r.cut_result_id=$1`,
      [nextResultId])).rows[0] : undefined;
      const rules = (await tx.query<{ ruleId: number; version: number }>(`SELECT id::float8 "ruleId",version
        FROM status_automation_rules WHERE is_enabled ORDER BY id`)).rows;
      const successor = nextMembers.length ? {
        sourceId: sourceOf(nextResultId!), revisionKey: `bath-successor:${nextResultId}`,
        lines: nextMembers.map(m => ({ ...m, stageCode: 'membership', evidenceKind: 'derived' as const, rework: false })),
        executionContext: { sourceCreatedAt: header!.createdAt, displayName: header!.name, priorColumn: 'baths',
          manualPlacementColumn: null, compositionComplete: true,
          demand: demand.map(({ orderId, detailId, quantity }) => ({ orderId, detailId, quantity })) },
      } : undefined;
      for (const s of [previous.sourceId, successor?.sourceId].filter((id): id is string => Boolean(id)).sort()) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${JSON.stringify(['bath', s])}`]);
      }
      const transitionOwners = [...new Set([...owners, ...nextOwners])].filter(id => locked.has(id)).sort((a, b) => a - b);
      let jobId: string;
      if (previous.status === 'active') {
        const head = (await tx.query<{ accepted: string | null; received: string; version: string; epoch: string }>(`SELECT
            accepted_revision_key accepted,received_revision_key received,version::text,correction_epoch::text epoch
          FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1 FOR UPDATE`, [previous.sourceId])).rows[0];
        if (!head || !head.accepted || head.accepted !== head.received) pendingConflict();
        const meta = (await tx.query<{ createdAt: string; name: string }>(`SELECT source_created_at::text "createdAt",
          display_name name FROM mdf_revision_context WHERE source_kind='bath' AND source_id=$1 AND revision_key=$2`,
        [previous.sourceId, head.accepted])).rows[0];
        const transitionId = randomUUID();
        jobId = randomUUID();
        await recordMdfBathTransition(tx, { transitionId, jobId, cutJobId: input.cutJobId,
          retired: { sourceId: previous.sourceId!, predecessorRevisionKey: head.accepted!, revisionKey: `bath-retired:${transitionId}`,
            fence: { version: head.version, correctionEpoch: head.epoch },
            sourceCreatedAt: meta?.createdAt ?? header?.createdAt ?? new Date().toISOString(), displayName: meta?.name ?? previous.sourceId! },
          ...(successor ? { successor } : {}),
          ownerIds: transitionOwners.length ? transitionOwners : await bathOwners(tx, previous.sourceId!),
          actorUserId: Number(input.user.id), requestId: command.requestId, commandKey: command.commandKey, rules });
      } else {
        // No active bath yet: the successor is simply the job's first bath.
        const saved = await recordMdfReceipt(tx, { sourceKind: 'bath', sourceId: successor!.sourceId,
          revisionKey: `bath-created:${nextResultId}`, origin: 'derived', actorUserId: Number(input.user.id),
          requestId: command.requestId, causeKey: `bath-created:${nextResultId}`, expectedFence: null, accept: true, rules,
          lines: successor!.lines, executionContext: successor!.executionContext });
        jobId = saved.jobId;
      }
      const related = [...new Set([...transitionOwners, ...nextOwners])];
      // Normalized detail dimensions of both baths (old evidence/demand, new membership).
      const relatedDetails = [...new Set([...nextMembers.map(m => m.detailId),
        ...(previous.status === 'active' ? (await tx.query<{ id: string }>(`SELECT DISTINCT detail_id::text id FROM (
            SELECT e.detail_id FROM mdf_source_heads h JOIN mdf_evidence_lines e ON e.source_kind=h.source_kind
              AND e.source_id=h.source_id AND e.revision_key=h.accepted_revision_key WHERE h.source_kind='bath' AND h.source_id=$1
            UNION SELECT d.detail_id FROM mdf_source_heads h JOIN mdf_revision_demand d ON d.source_kind=h.source_kind
              AND d.source_id=h.source_id AND d.revision_key=h.accepted_revision_key WHERE h.source_kind='bath' AND h.source_id=$1) x`,
          [previous.sourceId])).rows.map(r => Number(r.id)) : [])])];
      const auditId = await auditService.record(tx, { event: 'mdf.bath_transition.requested', entityType: 'cut_job',
        entityId: input.cutJobId, actorUserId: input.user.id, requestId: command.requestId, source: 'backend-cut',
        before: { activeBath: previous.sourceId, resultId: previous.resultId },
        after: { activeBath: successor?.sourceId ?? null, resultId: nextResultId, jobId },
        metadata: { commandKey: command.commandKey, writer: input.writer, notificationEventDecision: 'domain_outbox_only_no_user_notification' },
        relatedEntities: [...related.map(entityId => ({ entityType: 'order', entityId })),
          ...relatedDetails.map(entityId => ({ entityType: 'order_detail', entityId }))] });
      if (!auditId) throw new Error('MDF_BATH_TRANSITION_AUDIT_FAILED');
      await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
        VALUES ('mdf_board.bath_transition','cut_job',$1,$2::jsonb,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
      [String(input.cutJobId), JSON.stringify({ actorUserId: Number(input.user.id), requestId: command.requestId, auditId,
        retiredBath: previous.status === 'active' ? previous.sourceId : null, successorBath: successor?.sourceId ?? null,
        jobId, orderIds: related }),
      `mdf-bath-transition:${createHash('sha256').update(`${input.cutJobId}:${command.commandKey}`).digest('hex')}`]);
      return 'done';
    },
  };
}

function denied(): never { throw new ApiError(403, 'PERMISSION_DENIED', 'Нет доступа ко всем заказам раскроя'); }
function stale(): never { throw new ApiError(409, 'MDF_BATH_LIFECYCLE_STALE', 'Раскрой изменился — обновите страницу и повторите'); }
function readOnlyConflict(): never { throw new ApiError(409, 'MDF_ENGINE_READ_ONLY', 'Производственный учёт временно доступен только для чтения'); }
function pendingConflict(): never { throw new ApiError(409, 'MDF_BATH_TRANSITION_PENDING', 'Предыдущее изменение ванны ещё обрабатывается — повторите позже'); }
function productionConflict(): never { throw new ApiError(409, 'MDF_BATH_HAS_PRODUCTION', 'Ванна уже закатана — сначала оформите возврат закатки'); }
function invalidSuccessor(): never { throw new ApiError(409, 'MDF_BATH_SUCCESSOR_INVALID', 'Состав выбранного раскроя больше не совпадает с заказами — пересчитайте раскрой'); }
