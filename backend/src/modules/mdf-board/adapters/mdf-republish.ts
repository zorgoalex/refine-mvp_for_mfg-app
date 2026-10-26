import { createHash } from 'node:crypto';
import type { TransactionClient } from '../../../database/database.types';

/** Internal re-publication (plan «MDF bath readiness from credited cut», r3/r4). Each queued job republishes the CURRENT
 * accepted revision of one source with the revision's sealed effect policy (trigger 178 is not weakened) and carries the
 * immutable `mdf_republish_jobs` marker, so the handler only projects and publishes — no rule or CNC effects. The job's
 * allocation closure republishes the related sources of the same orders. No writes beyond the queue and the marker. */
export type MdfRepublishScope =
  | { kind: 'declared-candidates' }
  | { kind: 'rollback-declared'; sources?: readonly MdfRepublishSource[] }
  | { kind: 'sources'; sources: readonly MdfRepublishSource[] };
export interface MdfRepublishSource { kind: 'packet' | 'bazisCutSet' | 'bath'; id: string }
export interface MdfRepublishResult {
  runId: string;
  queued: (MdfRepublishSource & { jobId: string; revisionKey: string; effectPolicy: string })[];
  skipped: (MdfRepublishSource & { reason: string })[];
}

const SOURCE_KINDS = new Set(['packet', 'bazisCutSet', 'bath']);

/** Scope «declared-candidates»: every published bath that is not ready (its readiness may now come from credited cut).
 * Scope «rollback-declared»: the given sources plus every published bath that carries credited-cut coverage. */
export async function loadMdfRepublishScope(tx: TransactionClient, scope: MdfRepublishScope): Promise<MdfRepublishSource[]> {
  const explicit = scope.kind === 'declared-candidates' ? [] : [...(scope.sources ?? [])];
  for (const source of explicit) {
    if (!SOURCE_KINDS.has(source.kind) || !source.id) throw new Error('MDF_REPUBLISH_SOURCE_INVALID');
  }
  const found = scope.kind === 'declared-candidates'
    ? (await tx.query<MdfRepublishSource>(`SELECT 'bath' kind,p.source_id id FROM mdf_published_sources p
        WHERE p.source_kind='bath' AND COALESCE(p.placement_inputs->>'bathReadiness','not_ready')<>'ready'
        ORDER BY p.source_id`)).rows
    : scope.kind === 'rollback-declared'
      ? (await tx.query<MdfRepublishSource>(`SELECT 'bath' kind,m.source_id id FROM mdf_published_source_members m
          WHERE m.source_kind='bath' GROUP BY m.source_id HAVING sum(m.declared_covered_quantity)>0
          ORDER BY m.source_id`)).rows
      : [];
  const unique = new Map<string, MdfRepublishSource>();
  for (const source of [...explicit, ...found]) unique.set(`${source.kind}:${source.id}`, { kind: source.kind, id: source.id });
  return [...unique.values()];
}

export async function enqueueMdfRepublish(tx: TransactionClient, input: {
  runId: string; actorUserId: number; sources: readonly MdfRepublishSource[];
}): Promise<MdfRepublishResult> {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(input.runId)) throw new Error('MDF_REPUBLISH_RUN_INVALID');
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) throw new Error('MDF_REPUBLISH_ACTOR_INVALID');
  const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
  if (mode !== 'active') throw new Error('MDF_REPUBLISH_ENGINE_NOT_ACTIVE');
  const requestId = `mdf-republish:${input.runId}`;
  const result: MdfRepublishResult = { runId: input.runId, queued: [], skipped: [] };
  for (const source of input.sources) {
    // The head row lock serializes with receipts/corrections of the same source (they update it in their transaction).
    const head = (await tx.query<{ received: string; accepted: string | null; epoch: string }>(`SELECT
      received_revision_key received,accepted_revision_key accepted,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2 FOR UPDATE`, [source.kind, source.id])).rows[0];
    if (!head) { result.skipped.push({ ...source, reason: 'NO_HEAD' }); continue; }
    if (!head.accepted || head.accepted !== head.received) {
      result.skipped.push({ ...source, reason: 'ACCEPTANCE_PENDING' }); continue;
    }
    const open = (await tx.query<{ status: string }>(`SELECT status FROM mdf_recalculation_jobs
      WHERE source_kind=$1 AND source_id=$2 AND status IN ('pending','needs_attention') LIMIT 1`,
    [source.kind, source.id])).rows[0];
    if (open) { result.skipped.push({ ...source, reason: open.status === 'pending' ? 'JOB_PENDING' : 'JOB_NEEDS_ATTENTION' }); continue; }
    const sealed = (await tx.query<{ policy: string }>(`SELECT c.effect_policy policy FROM mdf_revision_context c
      JOIN mdf_revision_seals s USING(source_kind,source_id,revision_key)
      WHERE c.source_kind=$1 AND c.source_id=$2 AND c.revision_key=$3`, [source.kind, source.id, head.accepted])).rows[0];
    const effectPolicy = sealed?.policy ?? 'forward';
    const digest = createHash('sha256').update(JSON.stringify([source.kind, source.id, head.accepted, head.epoch]))
      .digest('hex').slice(0, 40);
    const commandKey = `mdf-republish:${input.runId}:${digest}`;
    const job = (await tx.query<{ job_id: string }>(`INSERT INTO mdf_recalculation_jobs
      (event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,error_code,effect_policy)
      VALUES($1,$2,$3,$4,$5::bigint,$6,$7,'pending',NULL,$8)
      ON CONFLICT(event_key) DO NOTHING RETURNING job_id`,
    [commandKey, source.kind, source.id, head.accepted, head.epoch, input.actorUserId, requestId, effectPolicy])).rows[0];
    if (!job) { result.skipped.push({ ...source, reason: 'ALREADY_QUEUED_IN_RUN' }); continue; }
    await tx.query(`INSERT INTO mdf_republish_jobs(job_id,run_id,command_key,actor_user_id,request_id)
      VALUES($1::uuid,$2,$3,$4,$5)`, [job.job_id, input.runId, commandKey, input.actorUserId, requestId]);
    result.queued.push({ ...source, jobId: job.job_id, revisionKey: head.accepted, effectPolicy });
  }
  return result;
}

/** Completion of a run: job states, and how many published baths still carry credited-cut coverage. */
export async function loadMdfRepublishStatus(tx: TransactionClient, runId: string) {
  const jobs = (await tx.query<{ status: string; n: string }>(`SELECT j.status,count(*)::text n
    FROM mdf_republish_jobs r JOIN mdf_recalculation_jobs j ON j.job_id=r.job_id
    WHERE r.run_id=$1 GROUP BY j.status ORDER BY j.status`, [runId])).rows;
  const declaredBaths = Number((await tx.query<{ n: string }>(`SELECT count(*)::text n FROM (SELECT m.source_id
    FROM mdf_published_source_members m WHERE m.source_kind='bath' GROUP BY m.source_id
    HAVING sum(m.declared_covered_quantity)>0) d`)).rows[0]?.n ?? 0);
  return { runId, jobs: Object.fromEntries(jobs.map(j => [j.status, Number(j.n)])), declaredBaths };
}
