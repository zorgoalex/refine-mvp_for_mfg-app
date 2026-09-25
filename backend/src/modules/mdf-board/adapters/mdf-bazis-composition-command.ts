import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { buildOrderReadScopePredicate, normalizeActorUserId, orderAssignmentExistsSql } from '../../../permissions/policies/order-read-scope-sql';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { MdfNeedsAttention } from '../application/mdf-job-runner';
import { mdfBazisMembershipDigest, matchesMdfValidatedBazisAssignmentState } from '../application/mdf-bazis-assignment-state';
import { MdfReceiptError, recordMdfBazisCompositionReceipt, type MdfReceiptLine } from '../application/mdf-receipt';
import type { MdfPhysicalLineageAction, MdfPhysicalLineageManifest } from '../application/mdf-physical-lineage';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import { matchesMdfValidatedPhysicalLineage, mdfLineageRevisionKey } from '../domain/mdf-physical-lineage';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { planMdfBazisComposition, type MdfBazisCompositionMembership, type MdfBazisCompositionPlan,
  type MdfBazisCompositionSnapshot } from '../domain/mdf-bazis-composition';
import type { MdfCorrectionBlocker, MdfCorrectionSourceLine } from '../domain/mdf-correction-plan';
import { loadMdfBazisAssignmentStateSnapshot } from './mdf-bazis-assignment-state-snapshot';
import { deriveMdfBazisRowChanges, extractMdfBazisAssignmentRows, loadMdfBazisCompositionRawSnapshot,
  mdfBazisAllocationPinDigest, mdfBazisEligibleRowIdsFromRaw, normalizeMdfBazisDesiredRows,
  type MdfBazisAssignmentRow, type MdfBazisBathHeadPin, type MdfBazisRawSnapshot, type MdfBazisRowChange } from './mdf-bazis-composition-snapshot';
import { discoverMdfCorrectionClosure, loadMdfCorrectionSnapshot, MAX_MDF_CORRECTION_ORDERS,
  MAX_MDF_CORRECTION_ROWS,
  type MdfCorrectionSourceRef } from './mdf-correction-snapshot';
import { mdfSourceKey, type MdfExecutionMetadata } from './mdf-execution-snapshot';

/** Internal dormant BASIS composition preview/confirm adapter (command-only).
 *
 * One method = one fresh READ COMMITTED transaction owned here via
 * DatabaseService.transaction(handler,{mdf}); the DatabaseService enters the
 * command boundary before the handler and the cached boundary is re-checked
 * inside. No public route, worker, reader or acceptance runs here: confirm
 * only appends the deferred carry-only composition receipt (always pending,
 * rules[], accepted head preserved), the exact raw BASIS row changes, the
 * requested audit, one idempotent outbox event and the replay row atomically.
 *
 * Lock ladder: mdf-manual-command advisory [user.id,idempotencyKey] (confirm,
 * before everything) → sorted scoped owner rows → closure details (ordinary
 * then HDF) → closure source advisory/head (sorted) → this set's raw rows →
 * recheck closure and raw snapshot. No job row locks after owners.
 *
 * Authorization is the active BASIS creation/rename model only: cut.manage +
 * orders.view plus the current resolved per-owner orders.view scope. Editing
 * assignment membership never changes order/detail production status, so the
 * correction orders.update/productionTasks.update gate is deliberately absent.
 *
 * Idempotency reuses mdf_manual_command_results with the tagged
 * 'mdf.bazis_composition' request digest; replay is honored before any
 * freshness check and reauthorizes the persisted owners. The frozen receipt
 * validator requires a 64hex intent commandKey, so the intent stores
 * sha256(['mdf.bazis_composition',actor,idempotencyKey]) while the result
 * table and advisory lock keep the raw provided key. */

export interface MdfBazisCompositionDesiredRow { readonly rowId: string; readonly quantity: number }
export interface MdfBazisCompositionPreviewRequest {
  /** Canonical positive decimal bazis_cut_sets.version observed by the caller. */
  readonly expectedVersion: string;
  /** Exact mdfSourceCommandToken of the target head fence. */
  readonly sourceToken: string;
  /** Complete desired eligible-row list; an empty list is intentional-empty. */
  readonly desiredRows: readonly MdfBazisCompositionDesiredRow[];
}
export interface MdfBazisCompositionConfirmRequest extends MdfBazisCompositionPreviewRequest {
  readonly expectedDigest: string;
  readonly idempotencyKey: string;
}
export interface MdfBazisCompositionAssignmentChange {
  rowId: string; orderId: string; detailId: string; before: number; after: number;
}
export interface MdfBazisCompositionRetainedPhysical {
  orderId: number; detailId: number; quantity: number; stage: 'cut' | 'laminated'; rework: boolean;
}
export interface MdfBazisCompositionPreservedAllocation {
  allocationId: string; bathId: string; bathRevision: string;
  orderId: number; detailId: number; quantity: number; state: 'reserved' | 'consumed';
}
export type MdfBazisCompositionPreviewResponse =
  | { status: 'ready' | 'unchanged'; beforeVersion: string; previewDigest: string;
      assignmentChanges: MdfBazisCompositionAssignmentChange[];
      retainedPhysical: MdfBazisCompositionRetainedPhysical[];
      preservedAllocations: MdfBazisCompositionPreservedAllocation[]; blockers: [] }
  | { status: 'blocked'; beforeVersion: string; previewDigest: null;
      assignmentChanges: []; retainedPhysical: []; preservedAllocations: [];
      blockers: MdfCorrectionBlocker[] };
export type MdfBazisCompositionConfirmResponse =
  | { status: 'queued'; jobId: string; intentId: string; assignmentStateId: string;
      auditId: string; outboxId: string; version: string; replay: boolean }
  | { status: 'unchanged'; beforeVersion: string; replay: boolean };

interface CompositionHead {
  kind: string; id: string; received: string; accepted: string | null; epoch: string; version: string;
}
interface Prepared {
  response: MdfBazisCompositionPreviewResponse;
  previewDigest: string | null;
  noop: boolean;
  plan: Extract<MdfBazisCompositionPlan, { status: 'ready' }> | null;
  owners: number[];
  setVersion: number;
  head: CompositionHead;
  desired: MdfBazisAssignmentRow[];
  rowById: Map<string, { orderId: number; detailId: number }>;
  rawDigest: string;
  demand: readonly { orderId: number; detailId: number; quantity: number }[];
  /** Present exactly when prepare produced a non-blocked digestible plan;
   * apply re-validates these instead of relying on forced casts. */
  changes?: MdfBazisRowChange[];
  pinDigest?: string;
  metadata?: MdfExecutionMetadata;
}
class CompositionScopeChanged extends Error {}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const targetSource = (setId: number): MdfCorrectionSourceRef => ({ kind: 'bazisCutSet', id: String(setId) });
const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }

export class PgMdfBazisCompositionCommand {
  constructor(private readonly database: Pick<DatabaseService, 'transaction'>) {}

  preview(user: CurrentUser, setId: number, request: MdfBazisCompositionPreviewRequest,
    requestId: string): Promise<MdfBazisCompositionPreviewResponse> {
    validateRequestId(requestId);
    validatePreviewRequest(setId, request);
    return this.transaction(user, async tx => (await this.prepare(tx, user, setId, request)).response);
  }

  confirm(user: CurrentUser, setId: number, request: MdfBazisCompositionConfirmRequest,
    requestId: string): Promise<MdfBazisCompositionConfirmResponse> {
    validateRequestId(requestId);
    validatePreviewRequest(setId, request);
    if (!/^[a-f0-9]{64}$/.test(request.expectedDigest)) fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Обновите предпросмотр состава');
    if (typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.idempotencyKey)) {
      fail(400, 'MDF_IDEMPOTENCY_KEY_REQUIRED', 'Команда требует уникальный ключ повтора');
    }
    return this.transaction(user, async tx => this.confirmInTransaction(tx, user, setId, request, requestId));
  }

  private async transaction<T>(user: CurrentUser, run: (tx: TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.database.transaction(async tx => {
          await tx.query('SET LOCAL jit=off');
          const boundary = await requireMdfCommandBoundary(tx, { writer: 'mdf.bazis_composition', capability: 'queued' });
          if (boundary.mode !== 'active') fail(409, 'MDF_ENGINE_ACTIVE_REQUIRED', 'Изменение состава BASIS пока недоступно в этом режиме');
          await tx.query("SELECT set_config('erp.current_user_id',$1,true)", [user.id]);
          return await run(tx);
        }, { mdf: { writer: 'mdf.bazis_composition', capability: 'queued' } });
      } catch (error) {
        if (error instanceof CompositionScopeChanged) {
          if (attempt === 0) continue;
          fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Связанные производственные данные меняются. Повторите предпросмотр.');
        }
        if (error && typeof error === 'object' && 'code' in error
          && ['40001', '40P01', '55P03'].includes(String((error as { code?: string }).code))) {
          fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Производственные данные меняются. Повторите предпросмотр.');
        }
        throw mapCompositionError(error);
      }
    }
    return fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Повторите предпросмотр состава');
  }

  private async confirmInTransaction(tx: TransactionClient, user: CurrentUser, setId: number,
    request: MdfBazisCompositionConfirmRequest, requestId: string): Promise<MdfBazisCompositionConfirmResponse> {
    assertPermissions(user);
    const normalized = canonicalDesiredRows(request.desiredRows);
    const requestDigest = hash(['mdf.bazis_composition', setId,
      { expectedVersion: request.expectedVersion, sourceToken: request.sourceToken, desiredRows: normalized },
      request.expectedDigest]);
    // Same shared-key lock as the manual command: one actor+key serializes
    // across every manual board operation and can never race the PK insert.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `mdf-manual-command:${JSON.stringify([user.id, request.idempotencyKey])}`]);
    const replay = (await tx.query<{ request_digest: string; order_ids: string[]; response: MdfBazisCompositionConfirmResponse }>(
      `SELECT request_digest,order_ids,response FROM mdf_manual_command_results WHERE actor_user_id=$1 AND command_key=$2`,
      [user.id, request.idempotencyKey])).rows[0];
    if (replay && replay.request_digest !== requestDigest) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'Ключ повтора уже использован для другой команды');
    }
    if (replay) {
      // Replay-before-freshness: only persisted-owner reauthorization, even
      // while received!=accepted or raw rows changed afterwards.
      const owners = replay.order_ids.map(Number).sort((a, b) => a - b);
      if (!owners.length || owners.length > MAX_MDF_CORRECTION_ORDERS
        || owners.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        fail(409, 'MDF_BAZIS_COMPOSITION_INVALID', 'Сохранённый результат команды недоступен');
      }
      await lockScopedOwners(tx, user, owners);
      return { ...replay.response, replay: true };
    }
    const prepared = await this.prepare(tx, user, setId, request);
    if (prepared.response.status === 'blocked') {
      fail(422, 'MDF_BAZIS_COMPOSITION_BLOCKED', 'Состав нельзя безопасно подтвердить. Исправьте перечисленные несоответствия.');
    }
    if (!prepared.previewDigest || prepared.previewDigest !== request.expectedDigest) {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Последствия состава изменились. Обновите предпросмотр.');
    }
    if (prepared.noop) {
      const response: MdfBazisCompositionConfirmResponse = { status: 'unchanged',
        beforeVersion: String(prepared.setVersion), replay: false };
      await remember(tx, user, setId, request, response, requestDigest, prepared.owners);
      return response;
    }
    return this.apply(tx, user, setId, request, requestId, prepared, requestDigest);
  }

  /** Full discovery → locks → recheck → gates → plan under the complete ladder. */
  private async prepare(tx: TransactionClient, user: CurrentUser, setId: number,
    request: MdfBazisCompositionPreviewRequest): Promise<Prepared> {
    assertPermissions(user);
    const target = targetSource(setId);
    const targetKey = mdfSourceKey(target);
    const initial = await discoverMdfCorrectionClosure(tx, target);
    const rawInitial = await loadMdfBazisCompositionRawSnapshot(tx, { setId });
    const rawOrderIds = [...new Set(rawInitial.rows
      .map(row => row.orderId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
    const owners = [...new Set([...initial.orders, ...rawOrderIds])].sort((a, b) => a - b);
    if (!owners.length || owners.length > MAX_MDF_CORRECTION_ORDERS) {
      fail(422, 'MDF_BAZIS_COMPOSITION_BLOCKED', 'Состав карточки требует проверки: недоступный или слишком большой набор заказов');
    }
    await lockScopedOwners(tx, user, owners);
    await lockClosureDetails(tx, owners, rawInitial);
    for (const source of [...initial.sources].sort((a, b) => cmpText(mdfSourceKey(a), mdfSourceKey(b)))) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `mdf-source:${JSON.stringify([source.kind, source.id])}`]);
    }
    const snapshot = await loadMdfCorrectionSnapshot(tx, target, initial);
    const current = await discoverMdfCorrectionClosure(tx, target);
    if (JSON.stringify(current.orders) !== JSON.stringify(initial.orders)
      || JSON.stringify(current.sources) !== JSON.stringify(initial.sources)) throw new CompositionScopeChanged();
    const raw = await loadMdfBazisCompositionRawSnapshot(tx, { setId, lockRowsAfterOwnerLocks: true });
    if (raw.rawSnapshotDigest !== rawInitial.rawSnapshotDigest) throw new CompositionScopeChanged();

    const head = snapshot.heads.find(row => mdfSourceKey(row) === targetKey);
    if (!head) fail(409, 'MDF_BAZIS_COMPOSITION_INVALID', 'Карточка BASIS не найдена в производственном учёте');
    const setVersion = Number(raw.header.version);
    if (!Number.isSafeInteger(setVersion) || setVersion <= 0) throw new Error('MDF_BAZIS_SNAPSHOT_INVALID');
    if (request.expectedVersion !== String(setVersion)) {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Набор был изменён другим пользователем. Обновите предпросмотр.');
    }
    if (mdfSourceCommandToken(target, { received: head.received, version: head.version, epoch: head.epoch }) !== request.sourceToken) {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Карточка изменилась. Обновите предпросмотр состава.');
    }
    const accepted = head.accepted;
    if (!accepted || accepted !== head.received) {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Изменения состава ещё не подтверждены');
    }
    const blockers: MdfCorrectionBlocker[] = [];
    for (const code of snapshot.sourceIssues.get(targetKey) ?? ['MDF_CONTEXT_REQUIRED']) {
      blockers.push({ code, sourceId: target.id });
    }
    const acceptedLines = snapshot.lines.filter(line => line.kind === target.kind && line.id === target.id
      && line.revision === accepted) as MdfCorrectionSourceLine[];
    if (!acceptedLines.length) blockers.push({ code: 'CURRENT_SOURCE_MISSING', sourceId: target.id });
    const acceptedJob = (await tx.query<{ status: string }>(`SELECT status FROM mdf_recalculation_jobs
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`, [target.kind, target.id, accepted])).rows;
    if (acceptedJob.length !== 1 || acceptedJob[0].status !== 'done') {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Дождитесь завершения обработки карточки');
    }
    const card = snapshot.published.get(targetKey);
    if (!card || card.accepted !== accepted || card.received !== head.received || card.issues.length) {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Дождитесь публикации подтверждённого состава карточки');
    }
    const lineageKey = mdfLineageRevisionKey(target, accepted);
    const lineage = snapshot.lineage.get(lineageKey);
    const lineageIssue = snapshot.lineageIssues.get(lineageKey)?.[0];
    if (!lineage || lineageIssue) blockers.push({ code: lineageIssue ?? 'LINEAGE_V2_REQUIRED', sourceId: target.id });
    else if (!matchesMdfValidatedPhysicalLineage({ sourceKind: 'bazisCutSet', sourceId: target.id,
      revisionKey: accepted, lines: acceptedLines, lineage })) {
      blockers.push({ code: 'LINEAGE_MISMATCH', sourceId: target.id });
    }
    const metadata = snapshot.metadata.get(targetKey);
    const demand = snapshot.frozenDemand.get(targetKey) ?? [];
    if (!metadata || !demand.length) blockers.push({ code: 'MDF_CONTEXT_REQUIRED', sourceId: target.id });

    const rawIssues = unresolvedRawMembership(raw);
    for (const code of rawIssues) blockers.push({ code, sourceId: target.id });
    const eligibility = mdfBazisEligibleRowIdsFromRaw(raw);
    const rowById = new Map(raw.rows.map(row => [row.rowId,
      { orderId: row.orderId ?? 0, detailId: row.detailId ?? 0 }]));
    const currentRows = extractMdfBazisAssignmentRows(raw, eligibility);
    const membershipByLineKey = new Map(acceptedLines
      .filter(line => line.stage === 'membership' && line.evidence === 'derived').map(line => [line.lineKey, line]));
    if (!rawIssues.length && !sameRawAcceptedMembership(currentRows, membershipByLineKey, rowById)) {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Состав файла изменился после подтверждения. Обновите предпросмотр.');
    }
    if (!currentRows.length && !membershipByLineKey.size && !blockers.length) {
      // Empty assignment is only authority with the genuine sealed marker
      // validated against this exact accepted revision; never a
      // missing-membership bypass.
      const stateSnapshot = await loadMdfBazisAssignmentStateSnapshot(tx, [{ kind: 'bazisCutSet', id: target.id,
        received: head.received, accepted, epoch: head.epoch }]);
      const state = stateSnapshot.states.get(JSON.stringify([target.kind, target.id, accepted]));
      const marked = state !== undefined && matchesMdfValidatedBazisAssignmentState({
        sourceKind: 'bazisCutSet', sourceId: target.id, revisionKey: accepted,
        lines: acceptedLines.map(line => ({ lineKey: line.lineKey, orderId: line.orderId, detailId: line.detailId,
          quantity: line.quantity, rework: line.rework, stageCode: line.stage, evidenceKind: line.evidence })),
        state });
      if (!marked || !state?.intentionalEmpty) blockers.push({ code: 'ASSIGNMENT_MARKER_MISSING', sourceId: target.id });
    }
    const desired = normalizeMdfBazisDesiredRows({ eligibility, desired: canonicalDesiredRows(request.desiredRows) });

    // Declaration capacity: only the target's own accepted declarations are
    // aggregated per position/rework; another bath's declarations/lamination
    // are never compared against the (possibly emptied) target assignment.
    const memberPartitions = new Map<string, number>();
    for (const row of desired) {
      const position = rowById.get(row.rowId)!;
      const line = membershipByLineKey.get(row.rowId);
      if (!line) continue;
      const key = JSON.stringify([position.orderId, position.detailId, line.rework]);
      memberPartitions.set(key, (memberPartitions.get(key) ?? 0) + row.quantity);
    }
    for (const [key, declared] of [...declarationTotals(acceptedLines)]
      .sort((a, b) => cmpText(a[0], b[0]))) {
      if (declared > (memberPartitions.get(key) ?? 0)) {
        blockers.push({ code: 'DECLARATION_CAP_EXCEEDED', sourceId: target.id, position: key });
      }
    }
    const desiredMembership: MdfBazisCompositionMembership[] = desired.map(row => {
      const position = rowById.get(row.rowId)!;
      const line = membershipByLineKey.get(row.rowId);
      return { orderId: position.orderId, detailId: position.detailId, quantity: row.quantity,
        lineKey: row.rowId, rework: line?.rework ?? false };
    });
    const plannerCurrent: MdfBazisCompositionSnapshot = { kind: 'bazisCutSet', id: target.id,
      acceptedRevision: accepted, receivedRevision: head.received, lines: acceptedLines };
    const targetAllocations = snapshot.allocations.filter(row => row.evidenceSourceKind === 'bazisCutSet'
      && row.evidenceSourceId === target.id);
    const plan = planMdfBazisComposition({ target: { kind: 'bazisCutSet', id: target.id },
      previousRevision: accepted, current: plannerCurrent, desiredMembership, allocations: targetAllocations });
    const derived = deriveMdfBazisRowChanges(currentRows, desired);
    const activeAllocations = targetAllocations
      .filter((row): row is (typeof targetAllocations)[number] & { state: 'reserved' | 'consumed' } =>
        row.state === 'reserved' || row.state === 'consumed')
      .sort((a, b) => cmpText(a.allocationId, b.allocationId));
    const activeBaths = new Set(activeAllocations.map(row => row.bathId));
    const bathHeads: MdfBazisBathHeadPin[] = snapshot.heads
      .filter(row => row.kind === 'bath' && activeBaths.has(row.id))
      .map(row => ({ kind: 'bath' as const, id: row.id, received: row.received, accepted: row.accepted, epoch: row.epoch }))
      .sort((a, b) => cmpText(a.id, b.id));
    // Necessary pinned baths must meet their own gates: every active pin binds
    // the bath's own accepted revision and that bath exists exactly once in
    // the locked closure heads. The target's new capacity is never ascribed
    // to a bath; an unresolved pin fails closed here, before any write/digest.
    // v2 bath lineage is intentionally NOT required: a legacy bath proof may
    // legitimately stay v1 (the v2 descriptor is mandatory for the TARGET
    // BASIS only), and bath quantities/lamination are never compared against
    // this (possibly reduced) BASIS assignment.
    const pinIssues = new Set<string>();
    const pinnedJobs = new Set<string>();
    for (const row of activeAllocations) {
      pinnedJobs.add(`${row.bathId}\u0000${row.bathRevision}`);
      const pin = bathHeads.find(candidate => candidate.id === row.bathId);
      if (!pin) pinIssues.add('PIN_BATH_HEAD_MISSING');
      else if (pin.accepted !== row.bathRevision) pinIssues.add('PIN_BATH_REVISION_STALE');
    }
    // Each pinned bath's own stable context: accepted head present and equal
    // to received, its sourceIssues entry exists and is empty (that closure
    // already validated sealed completeness and the full live demand; never
    // reconstructed or capped against BASIS here), metadata/frozenDemand
    // present and the publication card matching the exact head. Unrelated
    // sources are never consulted.
    for (const bathId of [...activeBaths].sort(cmpText)) {
      const key = mdfSourceKey({ kind: 'bath', id: bathId });
      const pin = bathHeads.find(head => head.id === bathId);
      if (pin && (!pin.accepted || pin.received !== pin.accepted)) pinIssues.add('PIN_BATH_HEAD_UNSTABLE');
      const issues = snapshot.sourceIssues.get(key);
      if (!issues) pinIssues.add('PIN_BATH_CONTEXT_MISSING');
      else if (issues.length) pinIssues.add('PIN_BATH_SOURCE_ISSUE');
      if (!snapshot.metadata.get(key) || !snapshot.frozenDemand.get(key)?.length) pinIssues.add('PIN_BATH_CONTEXT_REQUIRED');
      const card = snapshot.published.get(key);
      if (!card || card.issues.length || card.accepted !== pin?.accepted || card.received !== pin?.received) {
        pinIssues.add('PIN_BATH_PUBLICATION_STALE');
      }
    }
    // One batched nonlocking read (after the owner locks, same pattern as the
    // target-job gate above): each exact pinned revision needs exactly one
    // mdf_recalculation_jobs row and it must be 'done'.
    if (pinnedJobs.size) {
      const pairs = [...pinnedJobs].sort(cmpText).map(entry => entry.split('\u0000'));
      const jobRows = (await tx.query<{ source_id: string; revision_key: string; total: string; done: string }>(
        `SELECT source_id,revision_key,count(*) total,count(*) FILTER (WHERE status='done') done
          FROM mdf_recalculation_jobs WHERE source_kind='bath'
            AND (source_id,revision_key) IN (SELECT * FROM unnest($1::text[],$2::text[]))
          GROUP BY source_id,revision_key`,
        [pairs.map(([bathId]) => bathId), pairs.map(([, revision]) => revision)])).rows;
      const doneByKey = new Map(jobRows.map(row => [`${row.source_id}\u0000${row.revision_key}`,
        Number(row.total) === 1 && Number(row.done) === 1]));
      for (const [bathId, revision] of pairs) {
        if (!doneByKey.get(`${bathId}\u0000${revision}`)) pinIssues.add('PIN_BATH_JOB_NOT_DONE');
      }
    }
    for (const code of [...pinIssues].sort(cmpText)) blockers.push({ code, sourceId: target.id });
    // Single fail-closed exit: no collected blocker may reach the digest path.
    if (blockers.length || plan.status === 'blocked' || !metadata) {
      if (plan.status === 'blocked') blockers.push(...plan.blockers);
      return { response: { status: 'blocked', beforeVersion: String(setVersion), previewDigest: null,
        assignmentChanges: [], retainedPhysical: [], preservedAllocations: [], blockers },
      previewDigest: null, noop: false, plan: null, owners, setVersion, head, desired, changes: [],
        rowById, rawDigest: raw.rawSnapshotDigest, demand };
    }
    const pinDigest = mdfBazisAllocationPinDigest({ allocations: targetAllocations, bathHeads });
    const assignmentChanges: MdfBazisCompositionAssignmentChange[] = derived.changes.map(change => {
      const position = rowById.get(change.rowId)!;
      return { rowId: change.rowId, orderId: String(position.orderId), detailId: String(position.detailId),
        before: change.before, after: change.after };
    });
    const retainedPhysical: MdfBazisCompositionRetainedPhysical[] = acceptedLines
      .filter(line => line.stage !== 'membership' && line.evidence === 'physical')
      .flatMap(line => line.stage === 'cut' || line.stage === 'laminated'
        ? [{ orderId: line.orderId, detailId: line.detailId, quantity: line.quantity,
            stage: line.stage, rework: line.rework }] : []);
    const preservedAllocations: MdfBazisCompositionPreservedAllocation[] = activeAllocations.map(row => (
      { allocationId: row.allocationId, bathId: row.bathId, bathRevision: row.bathRevision,
        orderId: row.orderId, detailId: row.detailId, quantity: row.quantity, state: row.state }));
    const previewDigest = hash({ protocol: 'mdf-bazis-composition-preview-v1',
      actor: { id: user.id, role: user.role, permissions: [...user.permissions].sort(), scope: rolePolicyForUser(user) },
      setId, request: { expectedVersion: request.expectedVersion, sourceToken: request.sourceToken, desiredRows: desired },
      beforeVersion: String(setVersion), rawSnapshotDigest: raw.rawSnapshotDigest,
      head: { received: head.received, accepted, version: head.version, epoch: head.epoch },
      demand: demand.map(row => [row.orderId, row.detailId, row.quantity]),
      allocations: activeAllocations.map(row => [row.allocationId, row.evidenceLineId, row.bathId, row.bathRevision,
        row.orderId, row.detailId, row.quantity, row.state]),
      bathHeadPins: bathHeads.map(pin => [pin.id, pin.accepted, pin.received, pin.epoch]),
      plan, memberPartitions: [...memberPartitions].sort((a, b) => cmpText(a[0], b[0])),
      consequences: { assignmentChanges, retainedPhysical, preservedAllocations } });
    const status = derived.noop ? 'unchanged' as const : 'ready' as const;
    return { response: { status, beforeVersion: String(setVersion), previewDigest,
      assignmentChanges, retainedPhysical, preservedAllocations, blockers: [] },
    previewDigest, noop: derived.noop, plan, owners, setVersion, head, desired,
      changes: derived.changes, rowById, pinDigest, rawDigest: raw.rawSnapshotDigest, metadata, demand };
  }

  private async apply(tx: TransactionClient, user: CurrentUser, setId: number,
    request: MdfBazisCompositionConfirmRequest, requestId: string, prepared: Prepared,
    requestDigest: string): Promise<MdfBazisCompositionConfirmResponse> {
    const plan = prepared.plan;
    const previewDigest = prepared.previewDigest;
    const metadata = prepared.metadata;
    const demand = prepared.demand;
    const changes = prepared.changes;
    const pinDigest = prepared.pinDigest;
    if (!plan || !previewDigest || !metadata || !demand || !changes || !pinDigest) {
      fail(422, 'MDF_BAZIS_COMPOSITION_BLOCKED', 'Состав нельзя безопасно подтвердить');
    }
    const actorId = actorUserId(user);
    const target = targetSource(setId);
    // Exact row-level writes only for eligible rows; HDF/unrelated rows stay untouched.
    for (const change of changes) {
      if (change.after === 0) {
        const removed = (await tx.query(`DELETE FROM bazis_cut_set_details WHERE bazis_cut_set_detail_id=$1
          RETURNING bazis_cut_set_detail_id::text`, [change.rowId])).rows;
        if (removed.length !== 1) throw new CompositionScopeChanged();
      } else {
        const updated = (await tx.query(`UPDATE bazis_cut_set_details SET quantity=$2 WHERE bazis_cut_set_detail_id=$1
          RETURNING quantity::float8`, [change.rowId, change.after])).rows;
        if (updated.length !== 1 || Number(updated[0].quantity) !== change.after) throw new CompositionScopeChanged();
      }
    }
    const bumped = (await tx.query(`UPDATE bazis_cut_sets SET version=version+1,updated_at=now()
      WHERE bazis_cut_set_id=$1 AND version=$2 RETURNING version::float8`, [setId, prepared.setVersion])).rows;
    if (bumped.length !== 1) throw new CompositionScopeChanged();
    // POST-mutation raw snapshot/version: the intent binds exactly what the
    // later worker must find; the PRE snapshot stays in the preview digest.
    const post = await loadMdfBazisCompositionRawSnapshot(tx, { setId, lockRowsAfterOwnerLocks: true });
    const postRows = extractMdfBazisAssignmentRows(post, mdfBazisEligibleRowIdsFromRaw(post));
    const setVersion = Number(post.header.version);
    if (setVersion !== prepared.setVersion + 1 || JSON.stringify(postRows) !== JSON.stringify(prepared.desired)) {
      throw new CompositionScopeChanged();
    }
    const revisionKey = `mdf-bazis-composition:${randomUUID()}`;
    const receiptLines: MdfReceiptLine[] = plan.sourceReplacement.lines.map(line => ({ lineKey: line.lineKey,
      orderId: line.orderId, detailId: line.detailId, quantity: line.quantity, stageCode: line.stage,
      evidenceKind: line.evidence, rework: line.rework }));
    const membershipDigest = mdfBazisMembershipDigest(receiptLines);
    const intentionalEmpty = !receiptLines.some(line => line.stageCode === 'membership' && line.evidenceKind === 'derived');
    // Directly built carry-only manifest: generic forward helpers re-derive
    // roots and their membership gate is incompatible with an intentional-
    // empty predecessor; here every accepted physical row carries unchanged.
    const actions: MdfPhysicalLineageAction[] = plan.lineage.map(row => ({ lineKey: row.replacementLineKey,
      action: 'carry' as const, predecessorEvidenceLineId: row.predecessorEvidenceLineId }));
    const lineage: MdfPhysicalLineageManifest = { operation: 'carry', actions, droppedPredecessorEvidenceLineIds: [] };
    const intentId = randomUUID();
    const assignmentStateId = randomUUID();
    const jobId = randomUUID();
    const saved = await recordMdfBazisCompositionReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: target.id,
      revisionKey, origin: 'manual', actorUserId: actorId, requestId, causeKey: revisionKey,
      expectedFence: { version: prepared.head.version, correctionEpoch: prepared.head.epoch },
      accept: true, rules: [], lines: receiptLines,
      executionContext: { sourceCreatedAt: metadata.sourceCreatedAt, displayName: metadata.displayName,
        priorColumn: metadata.priorColumn, manualPlacementColumn: metadata.manualPlacementColumn,
        compositionComplete: true, demand },
      lineage,
      composition: { intentId, assignmentStateId, jobId, setId, setVersion,
        rawSnapshotDigest: post.rawSnapshotDigest, membershipDigest, intentionalEmpty,
        ownerIds: prepared.owners, allocationSnapshotDigest: pinDigest,
        previewDigest,
        commandKey: hash(['mdf.bazis_composition', user.id, request.idempotencyKey]) } });
    const nextHeadVersion = (BigInt(prepared.head.version) + 1n).toString();
    if (saved.replay || saved.accepted || saved.version !== nextHeadVersion || saved.correctionEpoch !== prepared.head.epoch) {
      fail(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Подтверждённая версия карточки изменилась. Повторите предпросмотр.');
    }
    const detailIds = new Set<number>();
    for (const position of plan.currentActionPositions) detailIds.add(position.detailId);
    for (const position of plan.retainedEvidencePositions) detailIds.add(position.detailId);
    const auditId = await auditService.record(tx, { event: 'mdf_board.bazis_composition_requested',
      entityType: 'mdf_board_card', entityId: `bazisCutSet:${setId}`, actorUserId: actorId,
      actorUsername: user.username, actorRole: user.role, requestId, source: 'mdf-active-bazis-composition-command',
      statusField: 'composition_revision', statusCode: revisionKey,
      before: { revision: prepared.head.accepted, setVersion: String(prepared.setVersion),
        headFence: { version: prepared.head.version, correctionEpoch: prepared.head.epoch },
        assignmentChanges: prepared.response.status === 'blocked' ? [] : prepared.response.assignmentChanges },
      after: { revision: revisionKey, setVersion: String(setVersion), rawSnapshotDigest: post.rawSnapshotDigest,
        head: { version: saved.version, correctionEpoch: saved.correctionEpoch }, jobId: saved.jobId,
        intentId, assignmentStateId, intentionalEmpty, preservedAllocations: pinDigest },
      metadata: { engineMode: 'active', sourceKind: 'bazisCutSet', sourceId: target.id, setId,
        sourceToken: request.sourceToken, idempotencyKey: request.idempotencyKey,
        previewDigest, allocationSnapshotDigest: pinDigest,
        rawSnapshotDigestPre: prepared.rawDigest, demandDigest: mdfDemandDigest(demand),
        relatedOrderIds: prepared.owners, notificationEventEmitted: false,
        notificationEventDecision: 'queued_composition_acceptance_no_status_automation' },
      relatedEntities: [
        ...prepared.owners.map(entityId => ({ entityType: 'order' as const, entityId })),
        ...[...detailIds].sort((a, b) => a - b).map(entityId => ({ entityType: 'order_detail' as const, entityId })),
      ] });
    if (!auditId) throw new Error('MDF_BAZIS_COMPOSITION_AUDIT_FAILED');
    const outbox = (await tx.query<{ id: string }>(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
      VALUES('mdf.bazis_composition_requested','mdf_board_card',$1,$2::jsonb,$3)
      ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING outbox_event_id::text id`, [`bazisCutSet:${setId}`, JSON.stringify({ actorUserId: actorId, requestId,
      setId, sourceKind: 'bazisCutSet', sourceId: target.id, orderIds: prepared.owners, auditId, jobId: saved.jobId,
      intentId, assignmentStateId }), `mdf-composition:${hash([user.id, request.idempotencyKey])}`])).rows[0];
    if (!outbox?.id) throw new Error('MDF_BAZIS_COMPOSITION_OUTBOX_FAILED');
    const response: MdfBazisCompositionConfirmResponse = { status: 'queued', jobId: saved.jobId, intentId,
      assignmentStateId, auditId, outboxId: outbox.id, version: saved.version, replay: false };
    await remember(tx, user, setId, request, response, requestDigest, prepared.owners);
    return response;
  }
}

function validatePreviewRequest(setId: number, request: MdfBazisCompositionPreviewRequest) {
  if (!Number.isSafeInteger(setId) || setId <= 0) fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Некорректный идентификатор набора');
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Некорректные параметры состава');
  if (typeof request.expectedVersion !== 'string' || !/^[1-9][0-9]*$/.test(request.expectedVersion)) {
    fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Некорректная версия набора');
  }
  if (typeof request.sourceToken !== 'string' || !/^[a-f0-9]{64}$/.test(request.sourceToken)) {
    fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Обновите карточку перед предпросмотром состава');
  }
  canonicalDesiredRows(request.desiredRows);
}
function validateRequestId(requestId: string) {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 2000 || requestId.includes('\0')) {
    fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Некорректный идентификатор запроса');
  }
}
function canonicalDesiredRows(rows: readonly MdfBazisCompositionDesiredRow[]): MdfBazisCompositionDesiredRow[] {
  if (!Array.isArray(rows) || rows.length > 5000) fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Некорректный состав строк');
  const seen = new Set<string>();
  const normalized: MdfBazisCompositionDesiredRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.rowId !== 'string' || !/^[1-9][0-9]*$/.test(row.rowId)
      || !Number.isSafeInteger(row.quantity) || row.quantity <= 0 || seen.has(row.rowId)) {
      fail(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Некорректная строка состава');
    }
    seen.add(row.rowId);
    normalized.push({ rowId: row.rowId, quantity: row.quantity });
  }
  return normalized.sort((a, b) => Number(a.rowId) - Number(b.rowId));
}

function assertPermissions(user: CurrentUser) {
  for (const permission of ['cut.manage', 'orders.view'] as const) {
    if (!user.permissions.includes(permission)) fail(403, 'PERMISSION_DENIED', 'Недостаточно прав для изменения состава BASIS');
  }
}
function actorUserId(user: CurrentUser): number {
  const id = Number(user.id);
  if (!Number.isSafeInteger(id) || id <= 0) fail(403, 'PERMISSION_DENIED', 'Некорректный идентификатор пользователя');
  return id;
}

/** Exactly the active BASIS creation/rename current-policy gate. */
async function lockScopedOwners(tx: TransactionClient, user: CurrentUser, ids: readonly number[]): Promise<void> {
  const params: unknown[] = [[...ids]];
  const scope = rolePolicyForUser(user).orders.view;
  const actor = scope === 'own' || scope === 'assigned' ? params.push(normalizeActorUserId(user.id)) : null;
  const predicate = buildOrderReadScopePredicate(scope, actor,
    actor === null ? 'FALSE' : orderAssignmentExistsSql('o', actor), 'o');
  const rows = (await tx.query<QueryResultRow & { id: number }>(`SELECT o.order_id::float8 id FROM orders o
    WHERE o.order_id=ANY($1::bigint[]) AND NOT o.delete_flag AND o.order_kind='production_order' AND ${predicate}
    ORDER BY o.order_id FOR UPDATE OF o`, params)).rows;
  if (rows.length !== ids.length) fail(403, 'PERMISSION_DENIED', 'Нет доступа ко всем заказам набора');
}

async function lockClosureDetails(tx: TransactionClient, owners: readonly number[],
  raw: MdfBazisRawSnapshot): Promise<void> {
  // Every discovered owner's detail rows are locked, not only raw-referenced
  // orders: demand/retained owners hold the live detail rows that membership
  // and HDF preservation are resolved against. Those same already-locked rows
  // additionally certify each claimed raw ordinary/HDF link identity; no new
  // late locks are acquired here (full owner locks precede this helper).
  const ordinaryExpected = new Map<number, number>();
  const hdfExpected = new Map<number, number>();
  for (const row of raw.rows) {
    if (row.raw.source_type === 'order_detail' && validLink(row.orderId) && validLink(row.detailId)) {
      const claimed = ordinaryExpected.get(row.detailId);
      if (claimed === undefined) ordinaryExpected.set(row.detailId, row.orderId);
      else if (claimed !== row.orderId) rawLinkUnresolved();
    }
    const hdfId = Number(row.raw.source_order_hdf_detail_id);
    if (Number.isSafeInteger(hdfId) && hdfId > 0) {
      const claimed = hdfExpected.get(hdfId);
      if (claimed === undefined) hdfExpected.set(hdfId, row.orderId ?? 0);
      else if (claimed !== (row.orderId ?? 0)) rawLinkUnresolved();
    }
  }
  if (owners.length) {
    const rows = (await tx.query<QueryResultRow & { detailId: number; orderId: number; deleteFlag: boolean }>(
      `SELECT detail_id::float8 "detailId",order_id::float8 "orderId",delete_flag "deleteFlag"
        FROM order_details WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag
        ORDER BY order_id,detail_id LIMIT $2 FOR UPDATE`,
      [[...owners], MAX_MDF_CORRECTION_ROWS + 1])).rows;
    if (rows.length > MAX_MDF_CORRECTION_ROWS) {
      fail(422, 'MDF_BAZIS_COMPOSITION_BLOCKED', 'Состав карточки требует проверки: слишком большой объём деталей заказов');
    }
    const live = new Map(rows.filter(row => !row.deleteFlag).map(row => [row.detailId, row.orderId]));
    for (const [detailId, orderId] of [...ordinaryExpected].sort((a, b) => a[0] - b[0])) {
      if (live.get(detailId) !== orderId) rawLinkUnresolved();
    }
  }
  const hdfIds = [...hdfExpected.keys()].sort((a, b) => a - b);
  if (hdfIds.length) {
    const rows = (await tx.query<QueryResultRow & { id: number; orderId: number }>(
      `SELECT order_hdf_detail_id::float8 id,order_id::float8 "orderId"
      FROM order_hdf_details WHERE order_hdf_detail_id=ANY($1::bigint[])
        AND order_id=ANY($2::bigint[]) AND NOT delete_flag
      ORDER BY order_id,order_hdf_detail_id FOR UPDATE`, [hdfIds, [...owners]])).rows;
    if (rows.length !== hdfIds.length || rows.some(row => hdfExpected.get(row.id) !== row.orderId)) rawLinkUnresolved();
  }
}
function rawLinkUnresolved(): never {
  fail(422, 'MDF_BAZIS_COMPOSITION_BLOCKED', 'Состав карточки требует проверки: ссылки строк набора не подтверждены');
}

const mdfMarker = new RegExp(MDF, 'iu');
const otherMarker = new RegExp(OTHER, 'iu');
/** Mirrors the active BASIS rename classification exactly: every ordinary row
 * is link-resolved before any material test (missing/foreign link or stray
 * HDF link fails closed regardless of material); only then is an explicit
 * OTHER label excluded and a valid HDF row (HDF link, no ordinary detail
 * link) preserved. Empty/unknown material — neither MDF nor OTHER — is
 * membership-unknown, never a silent skip like the old !mdf branch was. */
function unresolvedRawMembership(snapshot: MdfBazisRawSnapshot): string[] {
  const issues = new Set<string>();
  for (const row of snapshot.rows) {
    const sourceType = row.raw.source_type;
    if (sourceType === 'order_hdf_detail') {
      if (!validLink(row.orderId) || !validLink(Number(row.raw.source_order_hdf_detail_id))
        || (row.detailId ?? null) !== null) issues.add('MDF_BAZIS_MEMBERSHIP_UNRESOLVED');
      continue;
    }
    if (sourceType !== 'order_detail' || (row.raw.source_order_hdf_detail_id ?? null) !== null
      || !validLink(row.orderId) || !validLink(row.detailId)) {
      issues.add('MDF_BAZIS_MEMBERSHIP_UNRESOLVED');
      continue;
    }
    const material = typeof row.raw.material_name === 'string' ? row.raw.material_name : '';
    const isMdf = mdfMarker.test(material);
    const isOther = otherMarker.test(material);
    if (!isMdf || isOther) {
      if (!isOther) issues.add('MDF_BAZIS_MEMBERSHIP_UNRESOLVED');
      continue;
    }
    if (row.raw.cut_enabled !== true) issues.add('MDF_BAZIS_MEMBERSHIP_UNRESOLVED');
  }
  return [...issues];
}
function validLink(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value ?? 0) && Number(value) > 0;
}

function sameRawAcceptedMembership(current: readonly MdfBazisAssignmentRow[],
  acceptedMembership: Map<string, MdfCorrectionSourceLine>,
  rowById: Map<string, { orderId: number; detailId: number }>): boolean {
  const acceptedRows = [...acceptedMembership.keys()].sort((a, b) => Number(a) - Number(b));
  if (acceptedRows.length !== current.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    const row = current[index];
    const line = acceptedMembership.get(row.rowId);
    const position = rowById.get(row.rowId);
    if (!line || !position || line.lineKey !== row.rowId || line.quantity !== row.quantity
      || position.orderId !== line.orderId || position.detailId !== line.detailId) return false;
  }
  return true;
}

const declarationTotals = (() => {
  const cache = new WeakMap<readonly MdfCorrectionSourceLine[], Map<string, Map<string, number>>>();
  return (lines: readonly MdfCorrectionSourceLine[]): Map<string, number> => {
    let bySource = cache.get(lines);
    if (!bySource) { bySource = new Map(); cache.set(lines, bySource); }
    const sourceKey = '__composition__';
    let totals = bySource.get(sourceKey);
    if (!totals) {
      totals = new Map<string, number>();
      for (const line of lines) {
        if (line.stage === 'membership' || line.evidence !== 'declaration') continue;
        const key = JSON.stringify([line.orderId, line.detailId, line.rework]);
        totals.set(key, (totals.get(key) ?? 0) + line.quantity);
      }
      bySource.set(sourceKey, totals);
    }
    return totals;
  };
})();

async function remember(tx: TransactionClient, user: CurrentUser, setId: number,
  request: MdfBazisCompositionConfirmRequest, response: MdfBazisCompositionConfirmResponse,
  requestDigest: string, owners: readonly number[]): Promise<void> {
  await tx.query(`INSERT INTO mdf_manual_command_results(actor_user_id,command_key,request_digest,source_kind,source_id,order_ids,response)
    VALUES($1,$2,$3,$4,$5,$6::bigint[],$7::jsonb)`, [user.id, request.idempotencyKey, requestDigest,
    'bazisCutSet', String(setId), [...owners], JSON.stringify(response)]);
}

function mapCompositionError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof MdfNeedsAttention) {
    return new ApiError(422, 'MDF_BAZIS_COMPOSITION_BLOCKED', 'Связанные производственные данные требуют сверки перед составом.');
  }
  if (error instanceof MdfReceiptError) {
    if (error.code === 'MDF_SOURCE_STALE') return new ApiError(409, 'MDF_BAZIS_COMPOSITION_STALE', 'Карточка изменилась. Обновите предпросмотр.');
    return new ApiError(422, 'MDF_BAZIS_COMPOSITION_INVALID', 'Состав карточки не прошёл проверку производственного учёта.');
  }
  if (error instanceof Error) {
    switch (error.message) {
      case 'MDF_BAZIS_SET_NOT_FOUND':
        return new ApiError(409, 'MDF_BAZIS_COMPOSITION_INVALID', 'Набор не найден в производственном учёте');
      case 'MDF_BAZIS_DESIRED_INVALID':
        return new ApiError(400, 'MDF_BAZIS_COMPOSITION_INVALID', 'Неизвестная или недоступная строка состава');
      case 'MDF_BAZIS_SNAPSHOT_INVALID':
      case 'MDF_BAZIS_SNAPSHOT_ROW_LIMIT':
      case 'MDF_BAZIS_ELIGIBILITY_INVALID':
      case 'MDF_BAZIS_ROW_CHANGE_INVALID':
      case 'MDF_BAZIS_ALLOCATION_PIN_INVALID':
        return new ApiError(422, 'MDF_BAZIS_COMPOSITION_BLOCKED', 'Состав карточки требует проверки перед изменением.');
    }
  }
  return error;
}
