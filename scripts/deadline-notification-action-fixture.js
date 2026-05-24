#!/usr/bin/env node

const { runFixtureCommand } = require('./deadline-notification-action-fixture-lib');

const command = process.argv[2];

try {
  const result = runFixtureCommand(command);
  if (typeof result === 'string') console.log(result);
  else console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
