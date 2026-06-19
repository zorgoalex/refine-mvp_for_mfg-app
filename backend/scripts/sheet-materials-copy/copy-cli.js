#!/usr/bin/env node
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { Pool } = require('pg');
const { parseSheetCopyArgs, resolveSheetCopyConfig, assertSheetCopyAllowed, runSheetCopy, SheetCopyConflictError } = require('./runner');

async function main(argv) {
  const config = resolveSheetCopyConfig(parseSheetCopyArgs(argv.slice(2)), process.env);
  assertSheetCopyAllowed(config);
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const runId = config.runIdArg ?? `sheet-copy-${randomUUID()}`;
    const summary = await runSheetCopy(pool, { ...config, runId });
    if (config.mode === 'write' && summary.reversalRecord) {
      writeFileSync(config.manifestOut, `${JSON.stringify({ ...summary.reversalRecord, createdAt: new Date().toISOString() }, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally { await pool.end(); }
}
main(process.argv).catch((e) => {
  if (e instanceof SheetCopyConflictError) process.stderr.write(`${e.message}\n${JSON.stringify(e.conflicts, null, 2)}\n`);
  else process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
