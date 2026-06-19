#!/usr/bin/env node
const { Pool } = require('pg');
const { parseSheetCopyArgs, resolveSheetCopyConfig, assertSheetCopyAllowed, reverseSheetCopy } = require('./runner');

async function main(argv) {
  const config = resolveSheetCopyConfig(parseSheetCopyArgs(argv.slice(2)), process.env);
  if (!config.runIdArg) throw new Error('--run-id <id> is required for reverse');
  // reverse mutates → enforce the same fail-closed envelope as a write run (host allowlist, target-env, approve-write, expected-db-name).
  assertSheetCopyAllowed({ ...config, mode: 'write', manifestOut: config.manifestOut ?? '(reverse)' });
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const result = await reverseSheetCopy(pool, config.runIdArg, { actor: config.actor, expectedDbName: config.expectedDbName });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await pool.end(); }
}
main(process.argv).catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
