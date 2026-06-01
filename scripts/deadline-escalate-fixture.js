#!/usr/bin/env node

const { runCommand } = require('./deadline-escalate-fixture-lib');

const command = process.argv[2];

try {
  const result = runCommand(command);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
