import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { requireMdfCommandBoundary, type MdfOrderWriter } from '../application/mdf-command-boundary';
import { buildMdfForwardLineageManifest } from '../application/mdf-forward-lineage';
import { recordMdfLineageReceipt, recordMdfOrderCascadeReceipt, recordMdfReceipt,
  type MdfReceiptLine } from '../application/mdf-receipt';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import { mdfPositionKey } from '../domain/mdf-quantities';
import { mdfLineageRevisionKey } from '../domain/mdf-physical-lineage';
import { loadMdfExecutionDetails, loadMdfExecutionSnapshot, mdfSourceKey,
  type MdfExecutionHead } from './mdf-execution-snapshot';
import { mdfAllowedOrdersSql } from './mdf-published-snapshot';
import { MdfNeedsAttention } from '../application/mdf-job-runner';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';

/**
 * §5.4a order-demand cascade. Ordinary order commands (save/import/delete/restore/transfer) keep
 * ownership of their business writes; this port runs INSIDE the same transaction after the writes
 * and before commit. It never writes order/detail rows, statuses or automation. Decisions:
 * - demand-only change (MDF-present positions unchanged or grown) → carry receipt with new frozen
 *   demand, accepted only by the MDF worker (`recordMdfOrderCascadeReceipt`);
 * - a completed demand quarantine healed by this change → refresh receipt (identical lines + demand);
 * - status-only changes are never handled here: placement follows live ranks at read time (§5.4d);
 * - anything touching MDF-present positions, pending/attention sources or empty demand → 409 and
 *   the whole order command rolls back (confirmed correction is §5.4e).
 */
export const MDF_HEALABLE_ISSUES: ReadonlySet<string> = new Set(['MDF_DEMAND_CHANGED', 'MEMBER_OUTSIDE_LIVE_MDF_DEMAND']);
/** Allocation-planner consequences of a context quarantine (`mdf-allocation-quarantine.ts`: the executor
 * passes accepted=null for an invalid context, so a v2 source reads LINEAGE_INVALID, a v1 source
 * ACCEPTANCE_PENDING). Only these may accompany a healable issue. */
const MDF_QUARANTINE_CONSEQUENCES: ReadonlySet<string> = new Set(['LINEAGE_INVALID', 'ACCEPTANCE_PENDING']);
const MAX_OWNERS = 100, MAX_SOURCES = 250, MAX_LINES = 10000;

export type MdfOrderConflictClass = 'PENDING' | 'ATTENTION' | 'PHYSICAL' | 'ASSIGNMENT' | 'EMPTY';
const CONFLICT_CODES: Record<MdfOrderConflictClass, string> = {
  PENDING: 'MDF_ORDER_SOURCE_PENDING', ATTENTION: 'MDF_ORDER_SOURCE_ATTENTION',
  PHYSICAL: 'MDF_ORDER_PHYSICAL_CONFLICT', ASSIGNMENT: 'MDF_ORDER_ASSIGNMENT_CONFLICT', EMPTY: 'MDF_ORDER_DEMAND_EMPTY',
};
const CONFLICT_MESSAGES: Record<MdfOrderConflictClass, string> = {
  PENDING: 'Карточка МДФ-доски с этим заказом ещё обрабатывается — повторите сохранение позже',
  ATTENTION: 'Карточка МДФ-доски с этим заказом требует проверки — изменение позиций сейчас недоступно',
  PHYSICAL: 'Изменение затрагивает уже распиленные или зарезервированные позиции МДФ-доски — сначала оформите возврат',
  ASSIGNMENT: 'Изменение затрагивает позиции, назначенные в карточки МДФ-доски — сначала измените состав карточки',
  EMPTY: 'После изменения у карточки МДФ-доски не останется позиций — сначала измените её состав',
};
const CONFLICT_ORDER: readonly MdfOrderConflictClass[] = ['PENDING', 'ATTENTION', 'PHYSICAL', 'ASSIGNMENT', 'EMPTY'];

interface SourceRef { kind: 'packet' | 'bazisCutSet' | 'bath'; id: string }
interface HeadRow extends SourceRef { received: string; accepted: string | null; epoch: string; version: string }
interface EvidenceRow extends MdfReceiptLine { evidenceLineId: string; revision: string }
interface DemandRow { orderId: number; detailId: number; quantity: number }
interface Conflict {
  cls: MdfOrderConflictClass; source: SourceRef; displayName: string | null; owners: number[];
  positions: { orderId: number; detailId: number; before: number | null; after: number | null }[];
}

export interface MdfOrderCommandHandle {
  /** Call after the command's order row locks, BEFORE its writes. */
  captureBefore(orderIds: readonly number[]): Promise<void>;
  /** Call after the writes, before commit. Throws 409 (whole command rolls back) on conflicts. */
  finish(input: { user: CurrentUser; requestId: string; commandKey: string; orderIds: readonly number[] }): Promise<void>;
}

/** Nested port: the owning transaction must have entered the boundary with this writer. */
export async function openMdfOrderCommand(tx: TransactionClient, writer: MdfOrderWriter): Promise<MdfOrderCommandHandle> {
  const boundary = await requireMdfCommandBoundary(tx, { writer, capability: 'order-demand' });
  const enabled = boundary.mode === 'active' || boundary.mode === 'read_only';
  let before: CommandBefore = { demand: [] };
  return {
    async captureBefore(orderIds) {
      if (!enabled || !orderIds.length) return;
      before = { demand: await loadOrderMdfDemand(tx, orderIds) };
    },
    async finish(input) {
      if (!enabled || !input.orderIds.length) return;
      await runCascade(tx, { ...input, readOnly: boundary.mode === 'read_only', before });
    },
  };
}

/** Pre-write MDF inputs of the command's own orders: an order not captured (a new target order) has none. */
interface CommandBefore { demand: readonly DemandRow[] }
const demandOf = (rows: readonly DemandRow[], orderIds: ReadonlySet<number>) => rows
  .filter(d => orderIds.has(d.orderId)).map(d => ({ orderId: d.orderId, detailId: d.detailId, quantity: d.quantity }));

/** Complete (unbounded) MDF demand of the command's own orders, same predicates as
 * `loadMdfExecutionDetails`, used ONLY to detect whether the command changed MDF demand. Execution
 * limits apply later, once an affected source exists. */
async function loadOrderMdfDemand(tx: TransactionClient, orderIds: readonly number[]): Promise<DemandRow[]> {
  return (await tx.query<DemandRow>(`SELECT d.order_id::float8 "orderId",d.detail_id::float8 "detailId",d.quantity::float8 quantity
    FROM order_details d JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag AND o.order_kind='production_order'
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE d.order_id=ANY($1::bigint[]) AND NOT d.delete_flag
      AND COALESCE(mt.name,m.material_name,'') ~* $2 AND COALESCE(mt.name,m.material_name,'') !~* $3
    ORDER BY d.order_id,d.detail_id`, [[...orderIds], MDF, OTHER])).rows;
}

async function discoverSources(tx: TransactionClient, orderIds: readonly number[]): Promise<SourceRef[]> {
  // Received revision decides: its frozen demand/evidence is what the next job validates.
  const rows = (await tx.query<SourceRef>(`SELECT DISTINCT h.source_kind kind,h.source_id id FROM mdf_source_heads h
    WHERE h.source_kind IN ('packet','bazisCutSet','bath') AND (
      EXISTS(SELECT 1 FROM mdf_revision_demand d WHERE d.source_kind=h.source_kind AND d.source_id=h.source_id
        AND d.revision_key=h.received_revision_key AND d.order_id=ANY($1::bigint[]))
      OR EXISTS(SELECT 1 FROM mdf_evidence_lines e WHERE e.source_kind=h.source_kind AND e.source_id=h.source_id
        AND e.revision_key=h.received_revision_key AND e.order_id=ANY($1::bigint[])))
    ORDER BY 1,2 LIMIT $2`, [[...orderIds], MAX_SOURCES + 1])).rows;
  if (rows.length > MAX_SOURCES) throw new ApiError(409, 'MDF_ORDER_SCOPE_LIMIT', 'Слишком много карточек МДФ-доски затронуто изменением');
  return rows;
}

async function frozenOwners(tx: TransactionClient, sources: readonly SourceRef[]): Promise<number[]> {
  if (!sources.length) return [];
  const rows = (await tx.query<{ id: string }>(`SELECT DISTINCT d.order_id::text id FROM mdf_source_heads h
    JOIN unnest($1::text[],$2::text[]) s(kind,id) ON h.source_kind=s.kind AND h.source_id=s.id
    JOIN mdf_revision_demand d ON d.source_kind=h.source_kind AND d.source_id=h.source_id AND d.revision_key=h.received_revision_key
    ORDER BY 1 LIMIT $3`, [sources.map(s => s.kind), sources.map(s => s.id), MAX_OWNERS + 1])).rows;
  if (rows.length > MAX_OWNERS) throw new ApiError(409, 'MDF_ORDER_SCOPE_LIMIT', 'Слишком много заказов затронуто изменением');
  return rows.map(r => Number(r.id)).sort((a, b) => a - b);
}

function contention(): never {
  throw new ApiError(409, 'MDF_ORDER_LOCK_CONTENTION', 'Связанные заказы сейчас изменяются — повторите сохранение');
}

async function runCascade(tx: TransactionClient, input: { user: CurrentUser; requestId: string; commandKey: string;
  orderIds: readonly number[]; readOnly: boolean; before: CommandBefore }) {
  const touched = [...new Set(input.orderIds)].sort((a, b) => a - b);
  // Impact first: a command that did not change the MDF demand of its own orders has no MDF
  // consequence — before any discovery, scope limit or lock, whatever state the cards are in.
  // Status/rank changes never matter here: card placement follows live ranks at read time (§5.4d).
  const touchedSet = new Set(touched);
  const afterDemand = await loadOrderMdfDemand(tx, touched);
  if (mdfDemandDigest(demandOf(input.before.demand, touchedSet))
    === mdfDemandDigest(demandOf(afterDemand, touchedSet))) return;
  const discovered = await discoverSources(tx, touched);
  if (!discovered.length) return;
  // Lock protocol (cutover fence → name/project → orders ascending → sources): the command already
  // holds its own order rows. Missing owners above them are awaited in order; owners below them
  // would invert the order, so they are only tried (NOWAIT) and contention answers a retryable 409.
  const owners = await frozenOwners(tx, discovered);
  const maxTouched = touched[touched.length - 1];
  const missing = owners.filter(id => !touched.includes(id));
  try {
    const lower = missing.filter(id => id < maxTouched), higher = missing.filter(id => id > maxTouched);
    if (lower.length) await tx.query(`SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[])
      ORDER BY order_id FOR UPDATE NOWAIT`, [lower]);
    if (higher.length) await tx.query(`SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[])
      ORDER BY order_id FOR UPDATE`, [higher]);
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') contention();
    throw error;
  }
  for (const s of discovered) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${JSON.stringify([s.kind, s.id])}`]);
  }
  const heads = (await tx.query<HeadRow>(`SELECT h.source_kind kind,h.source_id id,h.received_revision_key received,
    h.accepted_revision_key accepted,h.correction_epoch::text epoch,h.version::text version FROM mdf_source_heads h
    JOIN unnest($1::text[],$2::text[]) s(kind,id) ON h.source_kind=s.kind AND h.source_id=s.id
    ORDER BY h.source_kind,h.source_id FOR UPDATE OF h`, [discovered.map(s => s.kind), discovered.map(s => s.id)])).rows;
  const again = await discoverSources(tx, touched);
  const againOwners = await frozenOwners(tx, again);
  if (JSON.stringify(again) !== JSON.stringify(discovered) || JSON.stringify(againOwners) !== JSON.stringify(owners)
    || heads.length !== discovered.length) contention();

  // Bounded execution loaders run only for an affected source; their limits answer 409, never 500.
  const bounded = async <T>(load: () => Promise<T>): Promise<T> => {
    try { return await load(); } catch (error) {
      if (error instanceof MdfNeedsAttention) {
        throw new ApiError(409, error.message.endsWith('_LIMIT') ? 'MDF_ORDER_SCOPE_LIMIT' : 'MDF_ORDER_SOURCE_ATTENTION',
          error.message.endsWith('_LIMIT') ? 'Слишком много позиций МДФ-доски затронуто изменением' : CONFLICT_MESSAGES.ATTENTION);
      }
      throw error;
    }
  };
  const snapshot = await bounded(() => loadMdfExecutionSnapshot(tx, heads.map((h): MdfExecutionHead =>
    ({ kind: h.kind, id: h.id, received: h.received, accepted: h.accepted, epoch: h.epoch })), owners));
  const live = await bounded(() => loadMdfExecutionDetails(tx, owners));
  const liveByPosition = new Map(live.map(d => [mdfPositionKey(d), d]));
  const lines = (await tx.query<EvidenceRow & { kind: string; id: string }>(`SELECT l.source_kind kind,l.source_id id,
    l.evidence_line_id::text "evidenceLineId",l.revision_key revision,l.line_key "lineKey",l.order_id::float8 "orderId",
    l.detail_id::float8 "detailId",l.quantity::float8 quantity,l.stage_code "stageCode",l.evidence_kind "evidenceKind",l.rework
    FROM unnest($1::text[],$2::text[],$3::text[]) h(kind,id,revision) JOIN mdf_evidence_lines l
      ON l.source_kind=h.kind AND l.source_id=h.id AND l.revision_key=h.revision ORDER BY l.line_key LIMIT $4`,
  [heads.map(h => h.kind), heads.map(h => h.id), heads.map(h => h.received), MAX_LINES + 1])).rows;
  if (lines.length > MAX_LINES) throw new ApiError(409, 'MDF_ORDER_SCOPE_LIMIT', 'Слишком много позиций затронуто изменением');
  const allocated = new Set((await tx.query<{ kind: string; id: string; orderId: string; detailId: string }>(`
    SELECT e.source_kind kind,e.source_id id,a.order_id::text "orderId",a.detail_id::text "detailId"
      FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.state<>'released' AND a.order_id=ANY($1::bigint[])
    UNION SELECT 'bath',a.bath_id,a.order_id::text,a.detail_id::text FROM mdf_bath_allocations a
      WHERE a.state<>'released' AND a.order_id=ANY($1::bigint[])`, [owners])).rows
    .map(r => `${mdfSourceKey(r)}|${r.orderId}:${r.detailId}`));
  const jobs = new Map((await tx.query<{ kind: string; id: string; status: string }>(`SELECT DISTINCT ON (j.source_kind,j.source_id,j.revision_key)
      j.source_kind kind,j.source_id id,j.status FROM mdf_recalculation_jobs j
      JOIN unnest($1::text[],$2::text[],$3::text[]) h(kind,id,revision)
        ON j.source_kind=h.kind AND j.source_id=h.id AND j.revision_key=h.revision
      ORDER BY j.source_kind,j.source_id,j.revision_key,j.created_at DESC`,
  [heads.map(h => h.kind), heads.map(h => h.id), heads.map(h => h.received)])).rows.map(r => [mdfSourceKey(r), r.status]));
  const published = new Map((await tx.query<{ kind: string; id: string; received: string; accepted: string | null; issues: string[] }>(`
    SELECT p.source_kind kind,p.source_id id,p.received_revision_key received,p.accepted_revision_key accepted,p.issues
      FROM mdf_published_sources p JOIN unnest($1::text[],$2::text[]) h(kind,id) ON p.source_kind=h.kind AND p.source_id=h.id`,
  [heads.map(h => h.kind), heads.map(h => h.id)])).rows.map(r => [mdfSourceKey(r), r]));

  const conflicts: Conflict[] = [];
  const cascades: { head: HeadRow; frozen: DemandRow[]; next: DemandRow[]; own: EvidenceRow[] }[] = [];
  const refreshes: { head: HeadRow; frozen: DemandRow[]; own: EvidenceRow[]; reason: string }[] = [];
  for (const h of heads) {
    const key = mdfSourceKey(h);
    const frozen = (snapshot.frozenDemand.get(key) ?? []).map(d => ({ orderId: d.orderId, detailId: d.detailId, quantity: d.quantity }));
    const sourceOwners = [...new Set(frozen.map(d => d.orderId))].sort((a, b) => a - b);
    const displayName = snapshot.metadata.get(key)?.displayName ?? null;
    const conflict = (cls: MdfOrderConflictClass, positions: Conflict['positions'] = []) =>
      conflicts.push({ cls, source: { kind: h.kind, id: h.id }, displayName, owners: sourceOwners, positions });
    // Per-source impact of THIS command: its own orders' demand rows of this source's owners.
    // Existing problems of unaffected cards never block it.
    const own = lines.filter(l => l.kind === h.kind && l.id === h.id);
    const ownTouched = new Set(sourceOwners.filter(id => touchedSet.has(id)));
    const demandImpact = mdfDemandDigest(demandOf(input.before.demand, ownTouched))
      !== mdfDemandDigest(demandOf(afterDemand, ownTouched));
    if (!demandImpact) continue;
    // 1. PENDING: unfinished acceptance of the received revision.
    const job = jobs.get(key);
    if (!h.accepted || h.accepted !== h.received || job === 'pending') { conflict('PENDING'); continue; }
    // 2. ATTENTION: failed job, missing publication, or own issues an order edit cannot heal.
    const pub = published.get(key);
    const ownIssues = (snapshot.issues.get(key) ?? ['MDF_CONTEXT_REQUIRED']).filter(i => !MDF_HEALABLE_ISSUES.has(i));
    // A completed demand quarantine also publishes its allocation-planner consequences (e.g. a v2
    // source's LINEAGE_INVALID while its context is invalid). Those are tolerated only together with
    // a healable issue AND when the fresh locked snapshot shows no own issue outside H; the refresh
    // or cascade job recomputes every issue from the carried lines.
    const quarantined = pub?.issues.some(i => MDF_HEALABLE_ISSUES.has(i)) ?? false;
    if (job !== 'done' || !pub || pub.received !== h.received || pub.accepted !== h.accepted
      || (!quarantined && pub.issues.length)
      || pub.issues.some(i => !MDF_HEALABLE_ISSUES.has(i) && !MDF_QUARANTINE_CONSEQUENCES.has(i))
      || ownIssues.length || !frozen.length) {
      conflict('ATTENTION'); continue;
    }
    // 3–4. MDF-present positions may only stay or grow; everything else is demand-only.
    const frozenByPosition = new Map(frozen.map(d => [mdfPositionKey(d), d]));
    const touchedPositions: Conflict['positions'] = [];
    let physical = false;
    for (const position of [...new Set(own.map(mdfPositionKey))].sort()) {
      const liveRow = liveByPosition.get(position), frozenRow = frozenByPosition.get(position);
      if (liveRow && frozenRow && liveRow.quantity >= frozenRow.quantity) continue;
      const line = own.find(l => mdfPositionKey(l) === position)!;
      touchedPositions.push({ orderId: line.orderId, detailId: line.detailId,
        before: frozenRow?.quantity ?? null, after: liveRow?.quantity ?? null });
      if (own.some(l => mdfPositionKey(l) === position && (l.stageCode === 'cut' || l.stageCode === 'laminated'))
        || allocated.has(`${key}|${position}`)) physical = true;
    }
    if (touchedPositions.length) { conflict(physical ? 'PHYSICAL' : 'ASSIGNMENT', touchedPositions); continue; }
    const next = live.filter(d => sourceOwners.includes(d.orderId))
      .map(d => ({ orderId: d.orderId, detailId: d.detailId, quantity: d.quantity }));
    if (!next.length) { conflict('EMPTY'); continue; }
    if (mdfDemandDigest(next) !== mdfDemandDigest(frozen)) { cascades.push({ head: h, frozen, next, own }); continue; }
    // 5. Same demand: refresh only when placement inputs changed or a completed quarantine healed.
    const healed = pub.issues.some(i => MDF_HEALABLE_ISSUES.has(i));
    if (healed) refreshes.push({ head: h, frozen, own, reason: 'quarantine_healed' });
  }

  if (conflicts.length) await rejectWithConflicts(tx, input.user, conflicts);
  if (input.readOnly && (cascades.length || refreshes.length)) {
    throw new ApiError(409, 'MDF_ENGINE_READ_ONLY', 'Производственный учёт временно доступен только для чтения');
  }
  for (const c of cascades) {
    await appendReceipt(tx, snapshot, input, c.head, c.own, { frozen: c.frozen, next: c.next });
  }
  for (const r of refreshes) {
    await appendReceipt(tx, snapshot, input, r.head, r.own, { frozen: r.frozen, next: r.frozen, reason: r.reason });
  }
}

async function appendReceipt(tx: TransactionClient, snapshot: Awaited<ReturnType<typeof loadMdfExecutionSnapshot>>,
  input: { user: CurrentUser; requestId: string; commandKey: string },
  head: HeadRow, own: EvidenceRow[], demand: { frozen: DemandRow[]; next: DemandRow[]; reason?: string }) {
  const key = mdfSourceKey(head);
  const metadata = snapshot.metadata.get(key);
  if (!metadata || !head.accepted) throw new ApiError(409, 'MDF_ORDER_SOURCE_ATTENTION', CONFLICT_MESSAGES.ATTENTION);
  const cascade = demand.reason === undefined;
  const digest = createHash('sha256').update(JSON.stringify([cascade ? 'cascade' : 'refresh', input.commandKey,
    input.requestId, head.kind, head.id, head.accepted])).digest('hex');
  const revisionKey = `${cascade ? 'order-cascade' : 'order-refresh'}:${digest.slice(0, 40)}`;
  const lines: MdfReceiptLine[] = own.map(({ lineKey, orderId, detailId, quantity, stageCode, evidenceKind, rework }) =>
    ({ lineKey, orderId, detailId, quantity, stageCode, evidenceKind, rework }));
  const orderIds = [...new Set(demand.frozen.concat(demand.next).map(d => d.orderId))].sort((a, b) => a - b);
  const base = {
    sourceKind: head.kind, sourceId: head.id, revisionKey, origin: 'manual' as const,
    actorUserId: Number(input.user.id), requestId: input.requestId, causeKey: revisionKey,
    expectedFence: { version: head.version, correctionEpoch: head.epoch },
    accept: true, rules: [], lines,
    executionContext: {
      sourceCreatedAt: metadata.sourceCreatedAt, displayName: metadata.displayName,
      priorColumn: metadata.priorColumn, manualPlacementColumn: metadata.manualPlacementColumn,
      compositionComplete: true, demand: demand.next,
    },
  };
  const lineage = snapshot.lineage.get(mdfLineageRevisionKey(head, head.accepted));
  const manifest = lineage ? buildMdfForwardLineageManifest({ sourceKind: head.kind, sourceId: head.id,
    predecessorRevisionKey: head.accepted, previousPhysicalRows: own.filter(l => l.evidenceKind === 'physical'),
    previousLineage: lineage, nextLines: lines, rootLineKeys: [] }) : undefined;
  const intentId = randomUUID();
  const saved = cascade
    ? await recordMdfOrderCascadeReceipt(tx, { ...base, ...(manifest ? { lineage: manifest } : {}), cascade: {
      intentId, jobId: randomUUID(), predecessorRevisionKey: head.accepted,
      previousDemandDigest: mdfDemandDigest(demand.frozen), nextDemandDigest: mdfDemandDigest(demand.next),
      orderIds, commandKey: digest } })
    : manifest ? await recordMdfLineageReceipt(tx, { ...base, lineage: manifest }) : await recordMdfReceipt(tx, base);
  const auditId = await auditService.record(tx, {
    event: cascade ? 'mdf.order_cascade.requested' : 'mdf.publication_refresh.requested',
    entityType: 'mdf_source', entityId: `${head.kind}:${head.id}`, actorUserId: input.user.id,
    requestId: input.requestId, source: 'backend-orders',
    before: { receivedRevision: head.received, demandDigest: mdfDemandDigest(demand.frozen) },
    after: { receivedRevision: revisionKey, demandDigest: mdfDemandDigest(demand.next), jobId: saved.jobId },
    metadata: { commandKey: input.commandKey, classification: cascade ? 'demand_only' : demand.reason,
      ...(cascade ? { intentId } : {}), notificationEventDecision: 'accounting_continuity_only_no_notification' },
    relatedEntities: [...orderIds.map(entityId => ({ entityType: 'order', entityId })),
      ...[...new Set(lines.map(l => l.detailId))].map(entityId => ({ entityType: 'order_detail', entityId }))],
  });
  if (!auditId) throw new Error('MDF_ORDER_CASCADE_AUDIT_FAILED');
}

/** 409 body is filtered by the actor's orders.view scope (same predicate as the §5.1 reader):
 * owners outside it collapse into `hiddenOwners` with no ids, names, positions or quantities. */
async function rejectWithConflicts(tx: TransactionClient, user: CurrentUser, conflicts: Conflict[]): Promise<never> {
  const ids = [...new Set(conflicts.flatMap(c => c.owners.concat(c.positions.map(p => p.orderId))))];
  // Literal permission AND scope, as OrderAccessPolicy.canView: without orders.view nothing is visible.
  const visible = !user.permissions.includes('orders.view') ? new Set<number>() : new Set((await tx.query<{ id: string }>(`SELECT a.order_id::text id FROM (${mdfAllowedOrdersSql(user)}) a
    WHERE a.order_id=ANY($2::bigint[])`, [user.id, ids])).rows.map(r => Number(r.id)));
  const primary = CONFLICT_ORDER.find(cls => conflicts.some(c => c.cls === cls))!;
  const cards = conflicts.map(c => {
    const allVisible = c.owners.every(id => visible.has(id)) && c.positions.every(p => visible.has(p.orderId));
    return {
      reason: CONFLICT_CODES[c.cls], sourceKind: c.source.kind,
      sourceId: allVisible ? c.source.id : null, displayName: allVisible ? c.displayName : null,
      orderIds: c.owners.filter(id => visible.has(id)),
      positions: c.positions.filter(p => visible.has(p.orderId)),
      hiddenOwners: !allVisible,
    };
  });
  throw new ApiError(409, CONFLICT_CODES[primary], CONFLICT_MESSAGES[primary], { cards });
}
