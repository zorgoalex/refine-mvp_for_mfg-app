#!/usr/bin/env node

const { runFixtureCommand } = require('./deadline-worker-fixture-lib');

const command = process.argv[2];

try {
  const result = runFixtureCommand(command);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
