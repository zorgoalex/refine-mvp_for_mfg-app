import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import { recordMdfCarriedClosureReceipt, recordMdfReceipt } from '../application/mdf-receipt';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import { loadMdfExecutionDetails } from './mdf-execution-snapshot';

const CHUNK = 50;

/** §5.7b closed-order boundary. Order X is CLOSED iff the accepted head of source `order:X` is a baseline closure
 * revision (`closure='by_status'`, accepted == received) AND its frozen demand digest equals X's current live MDF
 * demand digest. Any demand change on X therefore reopens it for every later discovery automatically; an explicit
 * reopen (return) records a successor `order:X` revision without the closure. Positions of a closed order need no bath
 * allocation (covered by the closure declaration), so discovery never expands through a closed order. */
export async function loadMdfClosedOrders(tx: DatabaseClient, orderIds: readonly number[]): Promise<Set<number>> {
  const closed = new Set<number>();
  if (!orderIds.length) return closed;
  const candidates = (await tx.query<{ id: string; digest: string }>(`SELECT h.source_id id,c.demand_digest digest
    FROM mdf_source_heads h JOIN mdf_revision_context c ON c.source_kind=h.source_kind AND c.source_id=h.source_id
      AND c.revision_key=h.accepted_revision_key
    WHERE h.source_kind='order' AND h.source_id=ANY($1::text[]) AND h.accepted_revision_key=h.received_revision_key
      AND c.closure='by_status'`, [orderIds.map(String)])).rows
    .map(r => ({ id: Number(r.id), digest: r.digest }))
    .filter(r => Number.isSafeInteger(r.id) && r.id > 0)
    .sort((a, b) => a.id - b.id);
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const details = await loadMdfExecutionDetails(tx, chunk.map(c => c.id));
    for (const c of chunk) {
      const own = details.filter(d => d.orderId === c.id)
        .map(d => ({ orderId: d.orderId, detailId: d.detailId, quantity: d.quantity }));
      if (mdfDemandDigest(own) === c.digest) closed.add(c.id);
    }
  }
  return closed;
}

/** Orders whose ACCEPTED order-level head carries historical coverage: the baseline closure (`by_status`) or its
 * successor after a demand change (`carried`). */
async function loadHistoricalHeads(tx: DatabaseClient, orderIds: readonly number[]) {
  if (!orderIds.length) return [];
  return (await tx.query<{ id: string; closure: string; digest: string }>(`SELECT h.source_id id,c.closure,c.demand_digest digest
    FROM mdf_source_heads h JOIN mdf_revision_context c ON c.source_kind=h.source_kind AND c.source_id=h.source_id
      AND c.revision_key=h.accepted_revision_key
    WHERE h.source_kind='order' AND h.source_id=ANY($1::text[]) AND h.accepted_revision_key=h.received_revision_key
      AND c.closure IN ('by_status','carried')`, [orderIds.map(String)])).rows
    .map(r => ({ id: Number(r.id), closure: r.closure, digest: r.digest }));
}

/** Accepted order-level sources (with or without historical coverage) whose frozen demand no longer equals live
 * demand: every demand change after the baseline, repeated ones, complete position replacement, removal of all MDF
 * demand, restoration. The owning command refreshes each (`reopenMdfClosure` carry=true). */
export async function loadMdfStaleClosures(tx: DatabaseClient, orderIds: readonly number[]): Promise<number[]> {
  if (!orderIds.length) return [];
  const heads = (await tx.query<{ id: string; digest: string }>(`SELECT h.source_id id,c.demand_digest digest
    FROM mdf_source_heads h JOIN mdf_revision_context c ON c.source_kind=h.source_kind AND c.source_id=h.source_id
      AND c.revision_key=h.accepted_revision_key
    WHERE h.source_kind='order' AND h.source_id=ANY($1::text[]) AND h.accepted_revision_key=h.received_revision_key`,
  [orderIds.map(String)])).rows.map(r => ({ id: Number(r.id), digest: r.digest }));
  if (!heads.length) return [];
  const details = await loadMdfExecutionDetails(tx, heads.map(h => h.id));
  return heads.filter(h => mdfDemandDigest(details.filter(d => d.orderId === h.id)
    .map(d => ({ orderId: d.orderId, detailId: d.detailId, quantity: d.quantity }))) !== h.digest)
    .map(h => h.id).sort((a, b) => a - b);
}

/** Orders with any accepted historical coverage (by_status or carried): a production return on their cards removes it. */
export async function loadMdfHistoricalCoverageOrders(tx: DatabaseClient, orderIds: readonly number[]): Promise<number[]> {
  return (await loadHistoricalHeads(tx, orderIds)).map(h => h.id).sort((a, b) => a - b);
}

/** Successor of order X's historical coverage (manual origin, correction ⇒ publish_only, accepted at once, own job):
 * - demand change (`carry`): marker `carried`, the previous declarations at min(previous, live) for positions still in
 *   live demand — refreshed again on every later demand change;
 * - production return (`carry=false`) or no live MDF demand at all: no marker, no declarations (terminal when the
 *   demand is empty: its job removes X's stale published positions).
 * Caller holds the order row lock and the `mdf-source:["order",X]` advisory lock in the global source order. */
export async function reopenMdfClosure(tx: DatabaseClient, input: { orderId: number; carry: boolean; actorUserId: number;
  requestId: string; causeKey: string; reason: 'demand_changed' | 'production_return';
  /** Production return: only these details (the returned card's positions in this order) lose their historical coverage;
   * every other detail keeps its declarations (capped by live demand) under a `carried` successor. */
  revokeDetailIds?: readonly number[] }): Promise<{ revisionKey: string; jobId: string }> {
  const head = (await tx.query<{ received: string; accepted: string | null; version: string; epoch: string }>(`SELECT
    received_revision_key received,accepted_revision_key accepted,version::text version,correction_epoch::text epoch
    FROM mdf_source_heads WHERE source_kind='order' AND source_id=$1 FOR UPDATE`, [String(input.orderId)])).rows[0];
  const previousClosure = head && head.accepted === head.received ? (await tx.query<{ closure: string | null }>(`SELECT closure
    FROM mdf_revision_context WHERE source_kind='order' AND source_id=$1 AND revision_key=$2`,
  [String(input.orderId), head.accepted])).rows[0]?.closure : null;
  const covered = previousClosure === 'by_status' || previousClosure === 'carried';
  // A return removes existing coverage; a demand refresh applies to any accepted order-level source.
  if (!head || head.accepted !== head.received || (input.reason === 'production_return' && !covered)) {
    throw new Error('MDF_CLOSURE_NOT_ACCEPTED');
  }
  const live = (await loadMdfExecutionDetails(tx, [input.orderId]))
    .map(d => ({ orderId: d.orderId, detailId: d.detailId, quantity: d.quantity }));
  const liveBy = new Map(live.map(d => [d.detailId, d.quantity]));
  const revoke = new Set(input.revokeDetailIds ?? []);
  const partialReturn = input.reason === 'production_return' && input.revokeDetailIds !== undefined;
  const carry = (input.carry || partialReturn) && covered && live.length > 0;
  const previous = carry ? (await tx.query<{ lineKey: string; detailId: number; quantity: number; stageCode: string }>(`SELECT
    line_key "lineKey",detail_id::float8 "detailId",quantity::float8 quantity,stage_code "stageCode" FROM mdf_evidence_lines
    WHERE source_kind='order' AND source_id=$1 AND revision_key=$2 AND evidence_kind='declaration' ORDER BY line_key`,
  [String(input.orderId), head.accepted])).rows : [];
  // Line keys stay stable across refreshes (one per detail and stage), never growing a prefix chain.
  const lines = previous.filter(l => !revoke.has(l.detailId)).flatMap(l => {
    const quantity = Math.min(l.quantity, liveBy.get(l.detailId) ?? 0);
    return quantity > 0 ? [{ lineKey: `historical:${l.detailId}:${l.stageCode}`, orderId: input.orderId, detailId: l.detailId,
      quantity, stageCode: l.stageCode, evidenceKind: 'declaration' as const, rework: false }] : [];
  });
  const revisionKey = `${input.causeKey}:order:${input.orderId}`;
  const receipt = { sourceKind: 'order' as const, sourceId: String(input.orderId), revisionKey,
    origin: 'manual' as const, actorUserId: input.actorUserId, requestId: input.requestId, causeKey: revisionKey,
    expectedFence: { version: head.version, correctionEpoch: head.epoch },
    executionContext: { sourceCreatedAt: new Date().toISOString(), displayName: `Заказ ${input.orderId}`, priorColumn: null,
      manualPlacementColumn: null, compositionComplete: true, demand: live },
    accept: true, lines, rules: [] };
  const saved = carry && lines.length ? await recordMdfCarriedClosureReceipt(tx, receipt)
    : await recordMdfReceipt(tx, { ...receipt, correction: true });
  if (!saved.accepted || saved.replay) throw new Error('MDF_CLOSURE_REOPEN_REJECTED');
  const auditId = await auditService.record(tx, { event: 'mdf.order_closure.reopened', entityType: 'order',
    entityId: input.orderId, actorUserId: input.actorUserId, requestId: input.requestId, source: 'backend-mdf-closure',
    relatedOrderId: input.orderId, before: { revisionKey: head.accepted, closure: previousClosure },
    after: { revisionKey, closure: carry && lines.length ? 'carried' : null, carriedDeclarations: lines.length,
      terminal: live.length === 0, revokedDetailIds: [...revoke].sort((a, b) => a - b) },
    metadata: { reason: input.reason, jobId: saved.jobId, notificationEventDecision: 'publish_only_no_effects' },
    relatedEntities: [{ entityType: 'order' as const, entityId: input.orderId }] });
  if (!auditId) throw new Error('MDF_CLOSURE_REOPEN_AUDIT_FAILED');
  return { revisionKey, jobId: saved.jobId };
}
