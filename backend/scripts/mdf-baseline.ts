/**
 * §5.7b MDF baseline population CLI.
 *   npx tsx scripts/mdf-baseline.ts dry-run --out <dir> [--label <name>]    one transaction, ALWAYS rolled back
 *   npx tsx scripts/mdf-baseline.ts apply    [--handoff]                     freeze + populate (+ atomic activation)
 *   npx tsx scripts/mdf-baseline.ts resume   --run <uuid> [--handoff]
 *   npx tsx scripts/mdf-baseline.ts handoff  --run <uuid>
 *   npx tsx scripts/mdf-baseline.ts abort    --run <uuid>
 *   npx tsx scripts/mdf-baseline.ts reset    --run <uuid>
 * Every command except dry-run requires MDF_BASELINE_TARGET="<current_database()>:<cluster system_identifier>" of the
 * intended cluster (refuses otherwise) and MDF_BASELINE_OPERATOR_ID (user id recorded in audit). Apply/resume hold the
 * exclusive cutover lock on this ONE session for the whole run (writers get 409 MDF_CUTOVER_IN_PROGRESS).
 * Connection: DATABASE_URL, or PG_TAILSCALE_BIND_IP/PG_BIND_IP + PG_DB/PG_USER/PG_PASSWORD. Never prints credentials.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { TransactionClient } from '../src/database/database.types';
import { abortMdfBaseline, dryRunMdfBaseline, handoffMdfBaseline, loadMdfBaselineBuild, markMdfBaselineRecorded,
  recordMdfBaselineBatch, resetMdfBaseline, startMdfBaselineRun, MdfBaselineRefused, type MdfBaselineActor } from
  '../src/modules/mdf-board/adapters/mdf-baseline-runner';

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(name);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  : new Pool({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1', database: process.env.PG_DB,
    user: process.env.PG_USER, password: process.env.PG_PASSWORD, max: 1 });
const log = (message: string) => process.stdout.write(`[mdf-baseline] ${message}\n`);
const tx = (client: PoolClient): TransactionClient => ({ raw: client as never,
  query: <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => client.query<T>(sql, [...params]) }) as TransactionClient;

async function inTransaction<T>(client: PoolClient, run: (t: TransactionClient) => Promise<T>): Promise<T> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try { const value = await run(tx(client)); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}

async function target(client: PoolClient): Promise<string> {
  return (await client.query<{ t: string }>(
    "SELECT current_database()||':'||(SELECT system_identifier::text FROM pg_control_system()) t")).rows[0].t;
}

async function main() {
  const client = await pool.connect();
  try {
    const actor: MdfBaselineActor = { operatorUserId: process.env.MDF_BASELINE_OPERATOR_ID
      ? Number(process.env.MDF_BASELINE_OPERATOR_ID) : null, requestId: `mdf-baseline:${randomUUID()}` };
    if (command === 'dry-run') {
      const out = option('--out');
      if (!out) throw new MdfBaselineRefused('MDF_BASELINE_OUT_REQUIRED');
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        await client.query(`SET LOCAL statement_timeout='600s'`);
        const report = await dryRunMdfBaseline(tx(client), actor);
        await client.query('ROLLBACK');
        const name = `mdf-baseline-dryrun-${option('--label') ?? 'run'}`;
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ target: await target(client), ...report }, null, 2)}\n`);
        log(`dry-run rolled back: items=${report.build.items} handoff=${report.handoff} jobs=${JSON.stringify(report.jobs)} `
          + `needsAttention=${report.needsAttention.length} mismatches=${report.mismatches.length} `
          + `statusesUnchanged=${report.statusesUnchanged} outboxDelta=${report.outboxDelta} automationDelta=${report.automationDelta} `
          + `durationMs=${report.durationMs}`);
        log(`cards=${report.published.sources} cardIssues=${JSON.stringify(report.cardIssues)} columns=${JSON.stringify(report.columns)}`);
        log(`passed=${report.passed}${report.failures.length ? ` failures=${report.failures.join(',')}` : ''} `
          + `unfinishedJobs=${report.unfinishedJobs} missingCards=${report.missingCards.length} missingPositions=${report.missingPositions}`);
        if (!report.passed) process.exitCode = 2;
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      return;
    }
    const expected = process.env.MDF_BASELINE_TARGET, actual = await target(client);
    if (!expected || expected !== actual) throw new MdfBaselineRefused('MDF_BASELINE_TARGET_MISMATCH');
    if (actor.operatorUserId === null || !Number.isSafeInteger(actor.operatorUserId)) throw new MdfBaselineRefused('MDF_BASELINE_OPERATOR_REQUIRED');
    const runId = option('--run');
    if (command === 'abort' || command === 'reset') {
      if (!runId) throw new MdfBaselineRefused('MDF_BASELINE_RUN_REQUIRED');
      await inTransaction(client, t => command === 'abort' ? abortMdfBaseline(t, actor, runId) : resetMdfBaseline(t, actor, runId));
      log(`${command} ${runId}: done`);
      return;
    }
    // apply / resume / handoff: one session, exclusive session-level cutover lock for the whole run.
    const locked = (await client.query<{ l: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('mdf-engine-cutover',0)) l")).rows[0].l;
    if (!locked) throw new MdfBaselineRefused('MDF_CUTOVER_IN_PROGRESS');
    try {
      let id = runId, seq: string;
      if (command === 'apply') {
        const started = await inTransaction(client, t => startMdfBaselineRun(t, actor, { dryRun: false }));
        id = started.runId; seq = started.runSeq;
        log(`run ${id} started (items=${started.build.items.length})`);
      } else {
        if (!id) throw new MdfBaselineRefused('MDF_BASELINE_RUN_REQUIRED');
        const row = (await client.query<{ status: string; run_seq: string }>(
          'SELECT status,run_seq::text FROM mdf_baseline_runs WHERE run_id=$1', [id])).rows[0];
        if (!row) throw new MdfBaselineRefused('MDF_BASELINE_RUN_NOT_FOUND');
        seq = row.run_seq;
        if (command === 'resume' && row.status !== 'started' && row.status !== 'recorded') throw new MdfBaselineRefused('MDF_BASELINE_NOT_RESUMABLE', row.status);
        if (command === 'handoff' && row.status !== 'recorded') throw new MdfBaselineRefused('MDF_BASELINE_NOT_RECORDED', row.status);
      }
      if (command !== 'handoff') {
        const status = (await client.query<{ status: string }>('SELECT status FROM mdf_baseline_runs WHERE run_id=$1', [id])).rows[0].status;
        if (status === 'started') {
          // The item set is recomputed under the lock; resume admission = only this run's rows + its pre-existing set.
          const build = await inTransaction(client, async t => {
            await t.query("SELECT set_config('mdf.command_writer','mdf.baseline',true)");
            await assertResumeAdmission(t, id!);
            return loadMdfBaselineBuild(t);
          });
          const manifestDigest = (await client.query<{ d: string }>("SELECT manifest->>'itemsDigest' d FROM mdf_baseline_runs WHERE run_id=$1", [id])).rows[0].d;
          if (manifestDigest !== build.itemsDigest) {
            await inTransaction(client, t => abortMdfBaseline(t, actor, id!));
            throw new MdfBaselineRefused('MDF_BASELINE_DRIFT_BEFORE_RECORDED');
          }
          for (let i = 0; i < build.items.length; i += 100) {
            const n = await inTransaction(client, t => recordMdfBaselineBatch(t, actor, id!, seq, build.items.slice(i, i + 100)));
            log(`batch ${i / 100 + 1}: recorded ${n}`);
          }
          await inTransaction(client, t => markMdfBaselineRecorded(t, actor, id!, build));
          log(`run ${id} recorded`);
        }
      }
      if (command === 'handoff' || flag('--handoff')) {
        const result = await inTransaction(client, t => handoffMdfBaseline(t, actor, id!));
        log(`handoff ${id}: ${result.status}${result.drift.length ? ` drift=${result.drift.length}` : ''}`);
        if (result.status !== 'activated') process.exitCode = 2;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('mdf-engine-cutover',0))").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** RESUME admission (R2#4/R8): every engine row is bound to this run's items or to its pre-existing snapshot. */
async function assertResumeAdmission(t: TransactionClient, runId: string) {
  const foreign = (await t.query<{ n: string }>(`SELECT (
      (SELECT count(*) FROM mdf_evidence_revisions r WHERE NOT EXISTS (SELECT 1 FROM mdf_baseline_run_items i
        WHERE i.run_id=$1 AND (i.source_kind,i.source_id,i.revision_key)=(r.source_kind,r.source_id,r.revision_key))
        AND NOT EXISTS (SELECT 1 FROM mdf_baseline_run_preexisting p WHERE p.run_id=$1 AND p.row_kind='revision'
          AND p.row_key=r.source_kind||':'||r.source_id||':'||r.revision_key))
    + (SELECT count(*) FROM mdf_recalculation_jobs j WHERE NOT EXISTS (SELECT 1 FROM mdf_baseline_run_items i
        WHERE i.run_id=$1 AND (i.source_kind,i.source_id,i.revision_key)=(j.source_kind,j.source_id,j.revision_key))
        AND NOT EXISTS (SELECT 1 FROM mdf_baseline_run_preexisting p WHERE p.run_id=$1 AND p.row_kind='job' AND p.row_key=j.job_id::text))
    + (SELECT count(*) FROM mdf_bath_allocations) + (SELECT count(*) FROM mdf_published_sources)
    )::text n`, [runId])).rows[0].n;
  if (foreign !== '0') throw new MdfBaselineRefused('MDF_BASELINE_FOREIGN_ROWS', Number(foreign));
}

main().catch(error => {
  const detail = error instanceof MdfBaselineRefused && error.detail !== undefined ? ` ${JSON.stringify(error.detail)}` : '';
  process.stderr.write(`[mdf-baseline] ${error instanceof Error ? error.message : 'failed'}${detail}\n`);
  process.exitCode = 1;
}).finally(() => pool.end());
