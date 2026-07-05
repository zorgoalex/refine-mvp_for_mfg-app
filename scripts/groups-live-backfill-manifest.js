#!/usr/bin/env node
const { readFileSync } = require('node:fs');

const manifestLib = require('./groups-live-backfill-manifest-lib.js');

const { buildGroupsLiveBackfillPlan } = manifestLib;

function main(argv) {
  const manifestPath = argv[2];
  if (!manifestPath) {
    throw new Error('Usage: node scripts/groups-live-backfill-manifest.js <manifest.json>');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plan = buildGroupsLiveBackfillPlan(manifest);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

try {
  main(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
