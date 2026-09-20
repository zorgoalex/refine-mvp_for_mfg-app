import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { DatabaseService } from '../../../database/database.service';
import { loadMdfComparisonSnapshot, ShadowScopeError } from '../adapters/mdf-comparison-snapshot';
import { compareMdfShadow, MDF_COMPARISON_VERSION } from '../domain/mdf-shadow-comparison';

type Observation = { source_kind: 'packet' | 'bath' | 'bazisCutSet'; source_id: string; revision_key: string; source_digest: string; attempts: number };
const identity = (o: Observation) => [o.source_kind, o.source_id, o.revision_key, MDF_COMPARISON_VERSION];
const failure = (code: string) => ({ algorithmVersion: MDF_COMPARISON_VERSION, surface: 'legacy-server-return-model',
  semantics: 'current-state-not-event-replay', cutoverReady: false, status: 'blocked',
  issues: [code, 'BASELINE_NOT_VERIFIED', 'INCOMPLETE_PRODUCER_COVERAGE'], differenceCount: 0 });

/** Only diagnostic tables can be written. Existing jobs/heads/evidence and
 * production state are intentionally not reachable through this service. */
export class MdfShadowComparisonService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(MdfShadowComparisonService.name);
  constructor(private readonly db: DatabaseService,
    private readonly load = loadMdfComparisonSnapshot) {}
  onModuleInit() {
    if (process.env.BACKEND_MDF_SHADOW_COMPARE !== 'true' || !this.db.isConfigured || this.timer) return;
    this.timer = setInterval(() => { void this.runTick(); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async runTick(): Promise<void> {
    if (process.env.BACKEND_MDF_SHADOW_COMPARE !== 'true' || !this.db.isConfigured || this.running) return;
    this.running = true;
    try { await this.db.transaction(tx => this.process(tx)); }
    catch { this.logger.warn({ event: 'mdf_shadow_compare_failed', code: 'DIAGNOSTIC_TRANSACTION_FAILED' }); }
    finally { this.running = false; }
  }
  private async process(tx: TransactionClient) {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.query("SET LOCAL statement_timeout='5s'");
    await tx.query("SET LOCAL lock_timeout='100ms'");
    await tx.query('SET LOCAL max_parallel_workers_per_gather=0');
    const locked = (await tx.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('mdf-shadow-compare',0)) acquired")).rows[0]?.acquired;
    if (!locked) return;
    const fence = (await tx.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0)) acquired")).rows[0]?.acquired;
    if (!fence) return;
    const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
    if (mode !== 'legacy' && mode !== 'shadow') return;
    const observation = (await tx.query<Observation>(`SELECT o.source_kind,o.source_id,o.revision_key,o.source_digest,COALESCE(a.attempts,0) attempts
      FROM mdf_shadow_observations o LEFT JOIN mdf_shadow_comparison_attempts a
        ON a.source_kind=o.source_kind AND a.source_id=o.source_id AND a.revision_key=o.revision_key AND a.algorithm_version=$1
      WHERE NOT EXISTS(SELECT 1 FROM mdf_shadow_comparisons c WHERE c.source_kind=o.source_kind AND c.source_id=o.source_id
        AND c.revision_key=o.revision_key AND c.algorithm_version=$1)
      AND (a.next_attempt_at IS NULL OR a.next_attempt_at<=now())
      ORDER BY o.created_at,o.source_kind,o.source_id,o.revision_key LIMIT 1`, [MDF_COMPARISON_VERSION])).rows[0];
    if (!observation) return;
    const started = Date.now();
    await tx.query('SAVEPOINT shadow_snapshot');
    try {
      // Deadline checked before every read and after calculation; SQL timeouts
      // cancel work server-side (no orphan Promise.race queries).
      const readOnly: DatabaseClient = { query: async (sql, params, options) => {
        if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CALL)\b/i.test(sql)) {
          throw new ShadowScopeError('NON_READ_QUERY_REJECTED');
        }
        const remaining = 15_000 - (Date.now() - started);
        if (remaining <= 0) throw new ShadowScopeError('TIME_BUDGET');
        await tx.query(`SET LOCAL statement_timeout='${Math.min(5000, remaining)}ms'`);
        return tx.query(sql, params, options);
      } };
      const snapshot = await this.load(readOnly, { kind: observation.source_kind, id: observation.source_id });
      const report = { ...compareMdfShadow(snapshot.input), snapshotAt: snapshot.snapshotAt,
        triggerRevision: observation.revision_key, triggerDigest: observation.source_digest,
        observedDigest: snapshot.sourceDigest, triggerSuperseded: observation.source_digest !== snapshot.sourceDigest,
        ownerCount: snapshot.ownerCount, sourceCount: snapshot.sourceCount };
      if (Date.now() - started > 15_000) throw new ShadowScopeError('TIME_BUDGET');
      if (report.triggerSuperseded) report.issues.push('TRIGGER_SUPERSEDED');
      await tx.query("SET LOCAL statement_timeout='5s'");
      await this.persist(tx, observation, report, snapshot.snapshotAt, Date.now() - started);
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT shadow_snapshot');
      await tx.query("SET LOCAL statement_timeout='5s'");
      const code = error instanceof ShadowScopeError ? error.code :
        (error as { code?: string })?.code === '57014' ? 'QUERY_TIMEOUT' : 'SNAPSHOT_FAILED';
      const attempts = Number(observation.attempts) + 1;
      // Domain limits are permanent for this report; transient errors back off
      // outside the immutable report and cannot block later observations.
      if (error instanceof ShadowScopeError || attempts >= 3) {
        await this.persist(tx, observation, failure(code), new Date().toISOString(), Date.now() - started);
      } else {
        await tx.query(`INSERT INTO mdf_shadow_comparison_attempts
          (source_kind,source_id,revision_key,algorithm_version,attempts,next_attempt_at,error_code)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(secs=>$6),$7)
          ON CONFLICT(source_kind,source_id,revision_key,algorithm_version) DO UPDATE
          SET attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at,error_code=EXCLUDED.error_code`,
        [...identity(observation), attempts, 60 * 2 ** attempts, code]);
      }
    }
  }
  private async persist(tx: DatabaseClient, o: Observation, report: { status: string }, at: string, duration: number) {
    await tx.query(`INSERT INTO mdf_shadow_comparisons
      (source_kind,source_id,revision_key,algorithm_version,status,snapshot_at,duration_ms,report)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
    [...identity(o), report.status, at, duration, JSON.stringify(report)]);
  }
}
