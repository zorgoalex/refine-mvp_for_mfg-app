/**
 * §5.7a read-only MDF history reconciliation report.
 *   npx tsx scripts/mdf-reconciliation-report.ts --out <dir> [--label <dump-name>]
 * Connection: DATABASE_URL, or PG_TAILSCALE_BIND_IP/PG_BIND_IP + PG_DB/PG_USER/PG_PASSWORD.
 * Runs in one REPEATABLE READ READ ONLY transaction that is always rolled back; refuses to run when the
 * transaction is not read-only. Never prints credentials. Exit 2 when an invariant fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Pool, type QueryResultRow } from 'pg';
import type { DatabaseClient } from '../src/database/database.types';
import { renderMdfReconciliationMarkdown, runMdfReconciliation } from '../src/modules/mdf-board/application/mdf-reconciliation-report';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = option('--out');
if (!out) { process.stderr.write('[mdf-reconciliation] --out <dir> is required\n'); process.exit(1); }

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  : new Pool({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1', database: process.env.PG_DB,
    user: process.env.PG_USER, password: process.env.PG_PASSWORD, max: 1 });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const readOnly = (await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only')).rows[0];
    if (readOnly?.transaction_read_only !== 'on') throw new Error('READ_ONLY_TRANSACTION_REQUIRED');
    await client.query(`SET LOCAL statement_timeout='300s'`);
    const db: DatabaseClient = { query: <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) =>
      client.query<T>(sql, [...params]) } as DatabaseClient;
    let commit = 'unknown';
    try { commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* container */ }
    const report = await runMdfReconciliation(db, { label: option('--label') ?? null, commit, generatedAt: new Date().toISOString() });
    await client.query('ROLLBACK');
    const name = `mdf-reconciliation-${option('--label') ?? String((report.manifest.dump as Record<string, string>).db)}`;
    mkdirSync(out!, { recursive: true });
    writeFileSync(join(out!, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out!, `${name}.md`), renderMdfReconciliationMarkdown(report));
    const failed = report.invariants.filter(i => !i.ok).map(i => i.name);
    process.stdout.write(`[mdf-reconciliation] sources=${report.sources.length} components=${report.components.length} `
      + `runtimeMs=${String(report.manifest.runtimeMs)} invariants=${failed.length ? `FAILED:${failed.join(',')}` : 'ok'}\n`);
    if (failed.length) process.exitCode = 2;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main().catch(error => {
  process.stderr.write(`[mdf-reconciliation] ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}).finally(() => pool.end());
