import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';

export type MdfSourceKind = 'packet' | 'bazisCutSet' | 'bath' | 'order' | 'orderDetail';
export interface MdfJob extends QueryResultRow {
  job_id: string; event_key: string; source_kind: MdfSourceKind; source_id: string;
  revision_key: string; correction_epoch: string; actor_user_id: string | null;
  request_id: string; attempts: number;
}
export interface MdfPinnedRule extends QueryResultRow { rule_id: string; rule_version: string }
export interface MdfJobDatabase<Client extends DatabaseClient = DatabaseClient> {
  transaction<T>(handler: (client: Client) => Promise<T>): Promise<T>;
}
export type MdfJobOutcome = 'disabled' | 'idle' | 'done' | 'superseded' | 'retry' | 'needs_attention';
export class MdfNeedsAttention extends Error {
  constructor(readonly code: string) {
    super(code);
    if (!/^MDF_[A-Z0-9_]{1,80}$/.test(code)) throw new Error('INVALID_MDF_ERROR_CODE');
  }
}
export function mdfRetrySeconds(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('INVALID_MDF_ATTEMPTS');
  return [5, 15, 60, 300][Math.min(attempts - 1, 3)];
}

/** Transactional execution primitive. The optional scheduler is default-off and
 * additionally gated by active database mode. The handler owns ordered
 * owner locks, source fences/rule-version rechecks and audit/outbox writes.
 * Command producers own authorization; the handler must have no non-transactional
 * effects. No notification flag involved.
 */
export class MdfJobRunner<Client extends DatabaseClient = DatabaseClient> {
  constructor(private readonly database: MdfJobDatabase<Client>,
    private readonly handle: (tx: Client, job: MdfJob, rules: readonly MdfPinnedRule[])
      => Promise<'done' | 'superseded'>) {}

  processOne(): Promise<{ status: MdfJobOutcome; jobId?: string }> {
    return this.database.transaction(async tx => {
      // Cutover must take the exclusive form of this same lock before changing
      // mode. It waits for old in-flight handlers; unrelated jobs run concurrently.
      await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
      const state = await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton=true');
      if (state.rows[0]?.mode !== 'active') return { status: 'disabled' };
      const selected = await tx.query<MdfJob>(`SELECT job_id,event_key,source_kind,source_id,revision_key,
        correction_epoch,actor_user_id,request_id,attempts FROM mdf_recalculation_jobs
        WHERE status='pending' AND next_attempt_at<=now()
        ORDER BY next_attempt_at,created_at,job_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const job = selected.rows[0];
      if (!job) return { status: 'idle' };
      const attempts = job.attempts + 1;
      await tx.query('UPDATE mdf_recalculation_jobs SET attempts=$2 WHERE job_id=$1', [job.job_id, attempts]);
      const rules = await tx.query<MdfPinnedRule>(`SELECT rule_id,rule_version
        FROM mdf_recalculation_job_rules WHERE job_id=$1 ORDER BY rule_id`, [job.job_id]);
      await tx.query('SAVEPOINT mdf_job_effects');
      try {
        const status = await this.handle(tx, { ...job, attempts }, rules.rows);
        await tx.query(`UPDATE mdf_recalculation_jobs SET status=$2,finished_at=now(),error_code=NULL
          WHERE job_id=$1`, [job.job_id, status]);
        await tx.query('RELEASE SAVEPOINT mdf_job_effects');
        return { status, jobId: job.job_id };
      } catch (error) {
        // SQL failures abort the subtransaction. Roll back all partial effects,
        // then retain retry metadata in the containing transaction. A lost
        // connection rolls back the entire claim; receipt stays pending.
        await tx.query('ROLLBACK TO SAVEPOINT mdf_job_effects');
        await tx.query('RELEASE SAVEPOINT mdf_job_effects');
        const needsAttention = error instanceof MdfNeedsAttention;
        const code = needsAttention ? error.code : 'MDF_PROCESSING_FAILED';
        const status = needsAttention ? 'needs_attention' : 'pending';
        await tx.query(`UPDATE mdf_recalculation_jobs SET status=$2,error_code=$3,
          next_attempt_at=now()+($4::integer * interval '1 second'),
          finished_at=CASE WHEN $2='needs_attention' THEN now() ELSE NULL END
          WHERE job_id=$1`, [job.job_id, status, code, mdfRetrySeconds(attempts)]);
        return { status: needsAttention ? 'needs_attention' : 'retry', jobId: job.job_id };
      }
    });
  }
}
