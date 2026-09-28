/**
 * §5.8 demand-drift reconciler (GPT-6 plan R5 APPROVED). In `active` mode finds accepted sources whose FROZEN demand
 * differs from the live MDF demand of their owners (catalog edits and any other change made outside order commands),
 * partitions them into connected owner/source closures and reconciles each closure atomically through the ordinary
 * order cascade (`reconcileMdfOrderDemand`): demand-only drift ⇒ rules-free cascade receipts accepted by the worker
 * (allocation continuity), stale order-level coverage ⇒ refresh, confirmation/hard conflicts ⇒ nothing written for that
 * closure and durable `mdf_demand_drift_conflicts` rows (+ audit). Independent closures proceed.
 */
import { createHash } from 'node:crypto';
import type { TransactionClient } from '../../../database/database.types';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import type { MdfPositionQuantity } from '../domain/mdf-quantities';
import { reconcileMdfOrderDemand } from './mdf-order-cascade';

export interface MdfDriftSource {
  kind: string; id: string; predecessor: string; version: string; epoch: string; owners: number[];
  frozenDigest: string; liveDigest: string;
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key = (s: { kind: string; id: string }) => `${s.kind}:${s.id}`;
const transitionKey = (kind: string, id: string, predecessor: string, liveDigest: string) =>
  JSON.stringify([kind, id, predecessor, liveDigest]);
/** Global lock order of conflict rows (reconciler writes, stale resolution, confirm): byte order of (kind, id). */
export const MDF_CONFLICT_LOCK_ORDER = 'source_kind COLLATE "C",source_id COLLATE "C",conflict_id';
const byConflictOrder = (a: { kind: string; id: string }, b: { kind: string; id: string }) =>
  a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

async function openConflictKeys(tx: TransactionClient): Promise<Set<string>> {
  return new Set((await tx.query<{ k: string; i: string; p: string; d: string }>(`SELECT source_kind k,source_id i,
    predecessor_revision_key p,live_demand_digest d FROM mdf_demand_drift_conflicts WHERE status='open'`)).rows
    .map(r => transitionKey(r.k, r.i, r.p, r.d)));
}

/** Read-only detection on the caller's transaction. */
export async function findMdfDemandDrift(tx: TransactionClient): Promise<MdfDriftSource[]> {
  const heads = (await tx.query<{ kind: string; id: string; predecessor: string; version: string; epoch: string;
    digest: string; owners: string[] | null }>(`SELECT h.source_kind kind,h.source_id id,h.accepted_revision_key predecessor,
      h.version::text version,h.correction_epoch::text epoch,c.demand_digest digest,
      (SELECT array_agg(DISTINCT d.order_id::text) FROM mdf_revision_demand d WHERE d.source_kind=h.source_kind
        AND d.source_id=h.source_id AND d.revision_key=h.accepted_revision_key) owners
    FROM mdf_source_heads h JOIN mdf_revision_context c ON c.source_kind=h.source_kind AND c.source_id=h.source_id
      AND c.revision_key=h.accepted_revision_key
    WHERE h.accepted_revision_key=h.received_revision_key AND h.source_kind IN ('packet','bazisCutSet','bath','order')`)).rows;
  const ownersOf = (h: typeof heads[number]) => [...new Set([...(h.owners ?? []).map(Number),
    ...(h.kind === 'order' ? [Number(h.id)] : [])])].filter(n => Number.isSafeInteger(n) && n > 0).sort((a, b) => a - b);
  const allOwners = [...new Set(heads.flatMap(ownersOf))];
  // Same live-demand predicate as `loadMdfExecutionDetails`, without its per-call limit (grouped per owner here).
  const live = allOwners.length ? (await tx.query<MdfPositionQuantity>(`SELECT d.order_id::float8 "orderId",
      d.detail_id::float8 "detailId",d.quantity::float8 quantity
    FROM order_details d JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag AND o.order_kind='production_order'
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE d.order_id=ANY($3::bigint[]) AND NOT d.delete_flag
      AND COALESCE(mt.name,m.material_name,'') ~* $1 AND COALESCE(mt.name,m.material_name,'') !~* $2`,
  [MDF, OTHER, allOwners])).rows : [];
  const liveByOrder = new Map<number, MdfPositionQuantity[]>();
  for (const d of live) liveByOrder.set(d.orderId, [...(liveByOrder.get(d.orderId) ?? []), d]);
  return heads.flatMap(h => {
    const owners = ownersOf(h);
    if (!owners.length) return [];
    const liveDigest = mdfDemandDigest(owners.flatMap(o => liveByOrder.get(o) ?? []));
    return liveDigest === h.digest ? [] : [{ kind: h.kind, id: h.id, predecessor: h.predecessor, version: h.version,
      epoch: h.epoch, owners, frozenDigest: h.digest, liveDigest }];
  });
}

export interface MdfSourceOwnerEdge { kind: string; id: string; owners: number[] }

/** Owner edges of EVERY engine source (accepted and received revisions, pending ones included): a source that is not
 * drifted itself (or not yet accepted) still connects the drifted sources of its owners into one atomic closure. */
export async function loadMdfSourceOwnerGraph(tx: TransactionClient): Promise<MdfSourceOwnerEdge[]> {
  return (await tx.query<{ kind: string; id: string; owners: string[] }>(`SELECT h.source_kind kind,h.source_id id,
      ARRAY(SELECT DISTINCT d.order_id::text FROM mdf_revision_demand d WHERE d.source_kind=h.source_kind
        AND d.source_id=h.source_id AND d.revision_key IN (h.accepted_revision_key,h.received_revision_key)) owners
    FROM mdf_source_heads h WHERE h.source_kind IN ('packet','bazisCutSet','bath','order')`)).rows
    .map(r => ({ kind: r.kind, id: r.id, owners: [...new Set([...r.owners.map(Number),
      ...(r.kind === 'order' ? [Number(r.id)] : [])])].filter(n => Number.isSafeInteger(n) && n > 0) }));
}

/** Connected closures of the drifted sources: union-find over source↔owner edges of the drifted sources AND of every
 * other engine source in `graph` (connectors); each closure lists only its drifted sources. */
export function partitionMdfDrift(sources: readonly MdfDriftSource[], graph: readonly MdfSourceOwnerEdge[] = []): MdfDriftSource[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) { parent.set(x, x); return x; }
    const r = find(p); parent.set(x, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const s of [...sources, ...graph]) for (const o of s.owners) union(`s:${key(s)}`, `o:${o}`);
  const groups = new Map<string, MdfDriftSource[]>();
  for (const s of sources) { const r = find(`s:${key(s)}`); groups.set(r, [...(groups.get(r) ?? []), s]); }
  return [...groups.values()].map(g => g.sort((a, b) => key(a) < key(b) ? -1 : 1))
    .sort((a, b) => key(a[0]) < key(b[0]) ? -1 : 1);
}

/** Transition identity: predecessor revision + fence of every source and the target live digest (R3). */
export function mdfReconcileCommandKey(group: readonly MdfDriftSource[]): string {
  return `mdf-reconcile:${sha(group.map(s => [s.kind, s.id, s.predecessor, s.version, s.epoch, s.liveDigest]))}`;
}

export interface MdfReconcileTickResult { closures: number; reconciled: number; conflicts: number; resolved: number;
  /** Closures refused for an operational (retryable) reason: nothing recorded, retried on a later tick. */
  retried: number;
  /** Round-robin cursor: key of the last attempted closure; pass it to the next tick. */
  cursor: string | null }

/** Cascade outcomes that are durable domain conflicts of the closure's transition (recorded, then skipped until the
 * transition changes or is confirmed). Anything else — pending/attention sources, lock contention, stale preview, mode
 * or freeze refusals — is operational: it records nothing and the closure is simply retried on a later tick. */
const DURABLE_CONFLICT_CODES = new Set(['MDF_ORDER_PHYSICAL_CONFLICT', 'MDF_ORDER_ASSIGNMENT_CONFLICT',
  'MDF_ORDER_DEMAND_EMPTY', 'MDF_ORDER_SCOPE_LIMIT']);

/** One tick. `transaction` runs a handler in a fresh READ COMMITTED transaction that entered the MDF boundary with the
 * writer `mdf.demand_reconcile` (capability order-demand). `user` is the configured system actor. */
export async function runMdfDemandReconcileTick(input: {
  transaction: <T>(handler: (tx: TransactionClient) => Promise<T>) => Promise<T>;
  user: CurrentUser; requestId: string; maxClosures?: number;
  /** Round-robin cursor from the previous tick: attempts start after it and wrap, so closures that keep failing for a
   * retryable reason never starve the others. */
  cursor?: string | null;
}): Promise<MdfReconcileTickResult> {
  const { drift, graph, open } = await input.transaction(async tx => ({ drift: await findMdfDemandDrift(tx),
    graph: await loadMdfSourceOwnerGraph(tx), open: await openConflictKeys(tx) }));
  // A closure whose every drifted source already has an OPEN conflict for this exact transition waits for a confirm
  // (or a revert): it is skipped, so persistent conflicts never starve later closures of the bounded tick.
  const eligible = partitionMdfDrift(drift, graph)
    .filter(g => !g.every(s => open.has(transitionKey(s.kind, s.id, s.predecessor, s.liveDigest))));
  // Closures are ordered by their first source key (partition order); start after the cursor and wrap around.
  const at = input.cursor ? eligible.findIndex(g => key(g[0]) > input.cursor!) : 0;
  const rotated = at > 0 ? [...eligible.slice(at), ...eligible.slice(0, at)] : eligible;
  const closures = rotated.slice(0, input.maxClosures ?? 50);
  const result: MdfReconcileTickResult = { closures: closures.length, reconciled: 0, conflicts: 0, resolved: 0, retried: 0,
    cursor: closures.length ? key(closures[closures.length - 1][0]) : input.cursor ?? null };
  for (const group of closures) {
    const orderIds = [...new Set(group.flatMap(s => s.owners))].sort((a, b) => a - b);
    try {
      await input.transaction(tx => reconcileMdfOrderDemand(tx, { user: input.user, requestId: input.requestId,
        commandKey: mdfReconcileCommandKey(group), orderIds }));
      result.reconciled += 1;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (!DURABLE_CONFLICT_CODES.has(error.code)) { result.retried += 1; continue; }
      // Conflict cards of `rejectWithConflicts` carry flat `sourceKind`/`sourceId`.
      const details = (error.details ?? {}) as { cards?: { sourceKind?: string; sourceId?: string }[]; mdfConfirmation?: unknown };
      const flagged = new Set((details.cards ?? []).flatMap(c => c.sourceKind && c.sourceId
        ? [key({ kind: c.sourceKind, id: c.sourceId })] : []));
      const code = error.code === 'MDF_ORDER_SCOPE_LIMIT' ? 'MDF_RECONCILE_SCOPE_LIMIT'
        : details.mdfConfirmation ? 'CONFIRMATION_REQUIRED' : 'HARD_CONFLICT';
      await input.transaction(async tx => {
        // Rows are written in the global conflict lock order (kind, id) shared with the confirm command.
        for (const s of [...group].sort(byConflictOrder)) {
          const rowCode = code === 'MDF_RECONCILE_SCOPE_LIMIT' || flagged.has(key(s)) ? code : 'BLOCKED_BY_CLOSURE';
          // New transition ⇒ insert; the same transition recurring after it was resolved (A→B, revert, A→B again) ⇒
          // reopen with fresh classification; an unchanged open row is left as is (no duplicate, no audit).
          const written = (await tx.query<{ conflict_id: string; reopened: boolean }>(`INSERT INTO mdf_demand_drift_conflicts
            (source_kind,source_id,predecessor_revision_key,frozen_demand_digest,live_demand_digest,owner_ids,code,detected_request_id)
            VALUES($1,$2,$3,$4,$5,$6::bigint[],$7,$8)
            ON CONFLICT (source_kind,source_id,predecessor_revision_key,live_demand_digest) DO UPDATE SET status='open',
              code=EXCLUDED.code,owner_ids=EXCLUDED.owner_ids,frozen_demand_digest=EXCLUDED.frozen_demand_digest,
              detected_request_id=EXCLUDED.detected_request_id,detected_at=now(),resolved_at=NULL,resolved_request_id=NULL,
              resolved_by_user_id=NULL
            WHERE mdf_demand_drift_conflicts.status='resolved' OR mdf_demand_drift_conflicts.code<>EXCLUDED.code
            RETURNING conflict_id::text,(xmax<>0) reopened`, [s.kind, s.id, s.predecessor, s.frozenDigest, s.liveDigest,
            s.owners, rowCode, input.requestId])).rows[0];
          if (!written) continue;
          result.conflicts += 1;
          const auditId = await auditService.record(tx, { event: 'mdf.demand_drift.conflict', entityType: 'mdf_source',
            entityId: key(s), actorUserId: input.user.id, requestId: input.requestId, source: 'backend-mdf-reconciler',
            relatedOrderId: s.owners.length === 1 ? s.owners[0] : null, statusCode: rowCode,
            after: { conflictId: written.conflict_id, code: rowCode, frozenDigest: s.frozenDigest, liveDigest: s.liveDigest,
              reopened: written.reopened },
            metadata: { causeCode: error.code, predecessor: s.predecessor },
            relatedEntities: s.owners.map(entityId => ({ entityType: 'order' as const, entityId })) });
          if (!auditId) throw new Error('MDF_RECONCILE_AUDIT_FAILED');
        }
      });
    }
  }
  // Close conflicts whose transition no longer applies (drift gone or the source moved to a new revision). Stale rows are
  // selected directly (current transitions excluded in SQL), so a large set of persistent open conflicts never hides a
  // later stale one; each transition is audited with the system actor and normalized order links.
  result.resolved = await input.transaction(async tx => {
    const current = await findMdfDemandDrift(tx);
    const stale = (await tx.query<{ conflict_id: string; source_kind: string; source_id: string; owner_ids: string[];
      code: string; predecessor_revision_key: string; live_demand_digest: string }>(`UPDATE mdf_demand_drift_conflicts c
      SET status='resolved',resolved_at=now(),resolved_request_id=$5,resolved_by_user_id=$6::bigint
      WHERE c.conflict_id IN (SELECT o.conflict_id FROM mdf_demand_drift_conflicts o WHERE o.status='open'
        AND (o.source_kind,o.source_id,o.predecessor_revision_key,o.live_demand_digest) NOT IN
          (SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]))
        ORDER BY ${MDF_CONFLICT_LOCK_ORDER.split(',').map(c => `o.${c}`).join(',')} LIMIT 1000 FOR UPDATE)
        AND c.status='open'
      RETURNING c.conflict_id::text,c.source_kind,c.source_id,c.owner_ids::text[] owner_ids,c.code,
        c.predecessor_revision_key,c.live_demand_digest`,
    [current.map(d => d.kind), current.map(d => d.id), current.map(d => d.predecessor), current.map(d => d.liveDigest),
      input.requestId, Number(input.user.id)])).rows;
    for (const c of stale) {
      const owners = c.owner_ids.map(Number);
      const auditId = await auditService.record(tx, { event: 'mdf.demand_drift.resolved', entityType: 'mdf_demand_drift_conflict',
        entityId: c.conflict_id, actorUserId: input.user.id, requestId: input.requestId, source: 'backend-mdf-reconciler',
        relatedOrderId: owners.length === 1 ? owners[0] : null, statusCode: c.code,
        before: { status: 'open', code: c.code }, after: { status: 'resolved', reason: 'transition_gone' },
        metadata: { source: key({ kind: c.source_kind, id: c.source_id }), predecessor: c.predecessor_revision_key,
          liveDigest: c.live_demand_digest },
        relatedEntities: owners.map(entityId => ({ entityType: 'order' as const, entityId })) });
      if (!auditId) throw new Error('MDF_RECONCILE_AUDIT_FAILED');
    }
    return stale.length;
  });
  return result;
}
