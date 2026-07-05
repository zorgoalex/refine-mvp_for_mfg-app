#!/usr/bin/env node
const {
  parseGroupsLiveBackfillRunArgs,
  resolveGroupsLiveBackfillRunConfig,
  runGroupsLiveBackfill,
} = require('./groups-live-backfill-manifest-lib.js');

async function main(argv) {
  const parsed = parseGroupsLiveBackfillRunArgs(argv.slice(2));
  const config = resolveGroupsLiveBackfillRunConfig(parsed, process.env);
  const summary = await runGroupsLiveBackfill(config);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
