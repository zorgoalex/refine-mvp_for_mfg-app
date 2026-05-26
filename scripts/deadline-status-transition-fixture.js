#!/usr/bin/env node

const { runCommand } = require('./deadline-status-transition-fixture-lib.js');

const command = process.argv[2];

try {
  const result = runCommand(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
