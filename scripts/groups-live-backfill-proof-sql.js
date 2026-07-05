#!/usr/bin/env node
const { readFileSync } = require('node:fs');

const { buildGroupsLiveBackfillProofSql } = require('./groups-live-backfill-manifest-lib.js');

function main(argv) {
  const manifestPath = argv[2];
  if (!manifestPath) {
    throw new Error('Usage: node scripts/groups-live-backfill-proof-sql.js <manifest.json>');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const proofSql = buildGroupsLiveBackfillProofSql(manifest);
  process.stdout.write(`${JSON.stringify(proofSql, null, 2)}\n`);
}

try {
  main(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
