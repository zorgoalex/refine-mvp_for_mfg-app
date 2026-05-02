#!/usr/bin/env node

const path = require('path');
const {
  STAGED_CANARY_FILES,
  validateStagedCanaryDirectory,
} = require('./runtime-config-canary-lib');

const repoRoot = path.resolve(__dirname, '..');
const canaryDirectory = path.join(repoRoot, 'docs/runtime-config/canary');
const errors = validateStagedCanaryDirectory(canaryDirectory);

if (errors.length > 0) {
  console.error('Runtime config canary validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Runtime config canary examples validated: ${STAGED_CANARY_FILES.length} files.`);
