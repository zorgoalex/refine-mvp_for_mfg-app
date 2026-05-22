#!/usr/bin/env node

const VALID_COMMANDS = new Set(['snapshot', 'create', 'restore']);
const PRODUCTION_MARKERS = ['prod', 'production', 'live'];
const TARGET_ENV_KEYS = ['DEADLINE_WORKER_TARGET_ENV', 'APP_ENV', 'BACKEND_ENV', 'BACKEND_NODE_ENV', 'NODE_ENV'];

function usage() {
  return 'Usage: npm run deadline-worker:fixture -- <snapshot|create|restore>';
}

function readTargetEnvironments() {
  return TARGET_ENV_KEYS
    .map((key) => process.env[key])
    .filter((value) => value && value.trim())
    .map((value) => value.trim().toLowerCase());
}

function hasProductionTarget(targetEnvironments) {
  return targetEnvironments.some((targetEnvironment) =>
    PRODUCTION_MARKERS.some((marker) => targetEnvironment.includes(marker)),
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const command = process.argv[2];

if (!VALID_COMMANDS.has(command)) {
  fail(`Unknown or missing deadline worker fixture command. ${usage()}`);
}

if (!process.env.DEADLINE_WORKER_FIXTURE_KEY) {
  fail('Refusing to run deadline worker fixture: DEADLINE_WORKER_FIXTURE_KEY is required.');
}

if (hasProductionTarget(readTargetEnvironments()) && process.env.DEADLINE_WORKER_ALLOW_PRODUCTION !== 'true') {
  fail('Refusing to run deadline worker fixture against a production target without DEADLINE_WORKER_ALLOW_PRODUCTION=true.');
}

console.log(`Deadline worker fixture ${command} scaffold only: no writes or remote connections are implemented.`);
