import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import { MdfNeedsAttention, type MdfJob, type MdfSourceKind } from '../application/mdf-job-runner';
import type { MdfEvidenceAllocation, MdfEvidenceReservation } from '../domain/mdf-evidence-allocation';
import { planMdfQuarantinedAllocations } from '../domain/mdf-allocation-quarantine';
import type { MdfPositionQuantity } from '../domain/mdf-quantities';

type Source = { kind: MdfSourceKind; id: string };
type Head = Source & { received: string; accepted: string | null; epoch: string };
type Line = MdfPositionQuantity & { evidenceLineId: string; kind: MdfSourceKind; id: string;
  revision: string; stage: string; evidence: string; rework: boolean };
const MAX_ORDERS = 100, MAX_SOURCES = 250, MAX_ROWS = 5000;
const key = (s: Source) => JSON.stringify([s.kind, s.id]);
function attention(code: string): never { throw new MdfNeedsAttention(`MDF_ALLOCATION_${code}`); }
const result = (status: 'disabled' | 'superseded' | 'allocated') => ({ status, reservedCount: 0, consumedCount: 0,
  readyBathIds: [] as string[], blockers: [] as ReturnType<typeof planMdfQuarantinedAllocations>['blockers'],
  quarantine: [] as ReturnType<typeof planMdfQuarantinedAllocations>['quarantine'], blockedPositionKeys: [] as string[] });

// Pending membership and historic allocations are graph edges too: neither may
// silently disappear from scope when a source changes, is hidden or is removed.
const edges = `edges AS (
  SELECT l.source_kind kind,l.source_id id,l.order_id FROM mdf_source_heads h JOIN mdf_evidence_lines l
    ON l.source_kind=h.source_kind AND l.source_id=h.source_id
    AND (l.revision_key=h.accepted_revision_key OR l.revision_key=h.received_revision_key)
  UNION SELECT e.source_kind,e.source_id,a.order_id FROM mdf_bath_allocations a
    JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.state<>'released'
  UNION SELECT 'bath',bath_id,order_id FROM mdf_bath_allocations WHERE state<>'released'
)`;

async function discover(tx: DatabaseClient, source: Source) {
  const sources = new Map<string, Source>([[key(source), source]]), orders = new Set<number>();
  for (let round = 0; round <= MAX_ORDERS; round++) {
    const previous = `${sources.size}:${orders.size}`, values = [...sources.values()];
    const owners = (await tx.query<{ id: string }>(`WITH ${edges}
      SELECT DISTINCT order_id::text id FROM edges JOIN unnest($1::text[],$2::text[]) s(kind,id) USING(kind,id)
      LIMIT $3`, [values.map(s => s.kind), values.map(s => s.id), MAX_ORDERS + 1])).rows;
    for (const row of owners) {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= 0) attention('INVALID_IDENTITY');
      orders.add(id);
    }
    if (orders.size > MAX_ORDERS) attention('SCOPE_LIMIT');
    const linked = (await tx.query<Source>(`WITH ${edges}
      SELECT DISTINCT kind,id FROM edges WHERE order_id=ANY($1::bigint[]) LIMIT $2`, [[...orders], MAX_SOURCES + 1])).rows;
    for (const s of linked) sources.set(key(s), s);
    if (sources.size > MAX_SOURCES) attention('SCOPE_LIMIT');
    if (previous === `${sources.size}:${orders.size}`) {
      if (!orders.size) attention('EMPTY_SCOPE');
      return { orders: [...orders].sort((a,b) => a-b), sources: [...sources.values()].sort((a,b) => key(a) < key(b) ? -1 : 1) };
    }
  }
  return attention('SCOPE_LIMIT');
}

/** Internal accounting port, NOT a complete job handler and deliberately NOT
 * registered as a scheduler. Caller owns the transaction and later rule actions,
 * publication/outbox/job completion. ALL future receipt acceptors must acquire
 * owning orders before source heads. No direct-SQL acceptance is supported.
 * Only accepted frozen evidence participates; never raw JSON/visual columns.
 */
export async function executeMdfAllocation(tx: DatabaseClient, jobId: string) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId)) attention('INVALID_JOB');
  if ((await tx.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0]?.transaction_isolation !== 'read committed') {
    throw new Error('MDF_ALLOCATION_ISOLATION');
  }
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
  const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
  if (mode !== 'active') return result('disabled');
  const job = (await tx.query<MdfJob & { status: string }>(`SELECT * FROM mdf_recalculation_jobs WHERE job_id=$1 FOR UPDATE`, [jobId])).rows[0];
  if (!job || job.status !== 'pending') attention('JOB_NOT_PENDING');
  const source = { kind: job.source_kind, id: job.source_id };
  const scope = await discover(tx, source);
  const owners = (await tx.query<{ order_id: string }>(`SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[])
    ORDER BY order_id FOR UPDATE`, [scope.orders])).rows;
  if (owners.length !== scope.orders.length) attention('OWNER_MISSING');
  for (const s of scope.sources) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${key(s)}`]);
  }
  const heads = (await tx.query<Head>(`SELECT h.source_kind kind,h.source_id id,h.received_revision_key received,
    h.accepted_revision_key accepted,h.correction_epoch::text epoch FROM mdf_source_heads h
    JOIN unnest($1::text[],$2::text[]) s(kind,id) ON h.source_kind=s.kind AND h.source_id=s.id
    ORDER BY h.source_kind,h.source_id FOR UPDATE OF h`, [scope.sources.map(s => s.kind), scope.sources.map(s => s.id)])).rows;
  // A waiter must not use a component discovered before somebody changed it.
  if (JSON.stringify(await discover(tx, source)) !== JSON.stringify(scope)) throw new Error('MDF_ALLOCATION_SCOPE_CHANGED');
  const trigger = heads.find(h => key(h) === key(source));
  if (!trigger?.accepted) attention('ACCEPTANCE_PENDING');
  if (trigger.accepted !== job.revision_key || trigger.epoch !== job.correction_epoch) return result('superseded');
  if (heads.length !== scope.sources.length) attention('HEAD_MISSING');
  const lines = (await tx.query<Line>(`SELECT l.evidence_line_id "evidenceLineId",l.source_kind kind,l.source_id id,
    l.revision_key revision,l.order_id::float8 "orderId",l.detail_id::float8 "detailId",l.quantity::float8 quantity,
    l.stage_code stage,l.evidence_kind evidence,l.rework
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) s(kind,id,accepted,received) JOIN mdf_evidence_lines l
      ON l.source_kind=s.kind AND l.source_id=s.id
      AND (l.revision_key=s.accepted OR l.revision_key=s.received) LIMIT $5`,
  [heads.map(h => h.kind), heads.map(h => h.id), heads.map(h => h.accepted), heads.map(h => h.received), MAX_ROWS + 1])).rows;
  if (lines.length > MAX_ROWS) attention('ROW_LIMIT');
  for (const l of lines) if (![l.orderId,l.detailId,l.quantity].every(n => Number.isSafeInteger(n) && n > 0)) attention('INVALID_EVIDENCE');
  const allocations = (await tx.query<MdfEvidenceAllocation>(`SELECT a.allocation_id "allocationId",a.evidence_line_id "evidenceLineId",
    a.bath_id "bathId",a.bath_revision "bathRevision",a.order_id::float8 "orderId",a.detail_id::float8 "detailId",
    a.quantity::float8 quantity,a.state FROM mdf_bath_allocations a
    WHERE a.order_id=ANY($1::bigint[]) AND a.state<>'released' ORDER BY a.allocation_id LIMIT $2 FOR UPDATE`,
  [scope.orders, MAX_ROWS + 1])).rows;
  if (allocations.length > MAX_ROWS) attention('ROW_LIMIT');
  const bathHeads = heads.filter(h => h.kind === 'bath');
  const dates = (await tx.query<{ id: string; createdAt: string }>(`SELECT 'cut-result:'||cut_result_id::text id,created_at::text "createdAt"
    FROM cut_result WHERE ('cut-result:'||cut_result_id::text)=ANY($1::text[])`, [bathHeads.map(h => h.id)])).rows;
  const bySource = new Map<string, Line[]>();
  for (const line of lines) { const own = bySource.get(key(line)) ?? []; own.push(line); bySource.set(key(line), own); }
  let plan: ReturnType<typeof planMdfQuarantinedAllocations>;
  try { plan = planMdfQuarantinedAllocations({ sources: heads.map(h => ({ ...h,
    lines: bySource.get(key(h)) ?? [], createdAt: dates.find(d => d.id === h.id)?.createdAt })),
  allocations, orderIds: scope.orders }); }
  catch { return attention('INVALID_BALANCE'); }
  let inserted: (MdfEvidenceReservation & { allocationId: string })[] = [];
  if (plan.reservations.length) {
    inserted = (await tx.query<MdfEvidenceReservation & { allocationId: string }>(`INSERT INTO mdf_bath_allocations
      (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
      SELECT x."evidenceLineId"::uuid,x."bathId",x."bathRevision",x."orderId",x."detailId",x.quantity,'reserved',$2
      FROM jsonb_to_recordset($1::jsonb) x("evidenceLineId" text,"bathId" text,"bathRevision" text,"orderId" bigint,"detailId" bigint,quantity bigint)
      RETURNING allocation_id "allocationId",evidence_line_id "evidenceLineId",bath_id "bathId",bath_revision "bathRevision",
        order_id::float8 "orderId",detail_id::float8 "detailId",quantity::float8 quantity`,
    [JSON.stringify(plan.reservations), job.event_key])).rows;
  }
  const toConsume = [...allocations.filter(a => a.state === 'reserved'), ...inserted]
    .filter(a => plan.consumableBathIds.includes(a.bathId));
  if (toConsume.length) await tx.query(`UPDATE mdf_bath_allocations SET state='consumed',updated_at=now()
    WHERE allocation_id=ANY($1::uuid[]) AND state='reserved'`, [toConsume.map(a => a.allocationId)]);
  await auditChanges(tx, job, 'reserved', inserted);
  await auditChanges(tx, job, 'consumed', toConsume);
  return { ...result('allocated'), readyBathIds: plan.readyBathIds, blockers: plan.blockers,
    quarantine: plan.quarantine, blockedPositionKeys: plan.blockedPositionKeys,
    reservedCount: inserted.length, consumedCount: toConsume.length };
}

async function auditChanges(tx: DatabaseClient, job: MdfJob, state: 'reserved' | 'consumed',
  lines: readonly (MdfEvidenceReservation & { allocationId: string })[]) {
  const grouped = new Map<string, typeof lines[number][]>();
  for (const l of lines) { const own = grouped.get(l.bathId) ?? []; own.push(l); grouped.set(l.bathId, own); }
  for (const [bathId, changes] of grouped) {
    const orderIds = [...new Set(changes.map(c => c.orderId))].sort((a,b) => a-b);
    const detailIds = [...new Set(changes.map(c => c.detailId))].sort((a,b) => a-b);
    const auditId = await auditService.record(tx, { event: `mdf_board.bath_supply_${state}`, entityType: 'mdf_bath',
      entityId: bathId, actorUserId: job.actor_user_id, requestId: job.request_id, source: 'backend-mdf-allocation',
      relatedOrderId: orderIds.length === 1 ? orderIds[0] : null, statusField: 'allocation_state', statusCode: state,
      before: { allocationState: state === 'reserved' ? 'unallocated' : 'reserved' },
      after: { allocationState: state, allocations: changes },
      metadata: { jobId: job.job_id, causeKey: job.event_key, notificationEventDecision: 'owning_job_transition_outbox' } });
    if (!auditId) throw new Error('MDF_ALLOCATION_AUDIT_FAILED');
    await tx.query(`INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id)
      SELECT $1::uuid,'order',unnest($2::bigint[]) UNION ALL SELECT $1::uuid,'order_detail',unnest($3::bigint[])
      ON CONFLICT DO NOTHING`, [auditId, orderIds, detailIds]);
  }
}
