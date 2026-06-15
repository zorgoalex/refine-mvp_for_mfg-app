#!/usr/bin/env node
const {
  parseProjectsLiveBackfillRunArgs,
  resolveProjectsLiveBackfillRunConfig,
  runProjectsLiveBackfill,
} = require('./projects-live-backfill-manifest-lib.js');

async function main(argv) {
  const parsed = parseProjectsLiveBackfillRunArgs(argv.slice(2));
  const config = resolveProjectsLiveBackfillRunConfig(parsed, process.env);
  const summary = await runProjectsLiveBackfill(config);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
