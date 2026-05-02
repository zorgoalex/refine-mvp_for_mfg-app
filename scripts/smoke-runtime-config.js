#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  compareRuntimeConfigFeatures,
  formatEnabledFeatures,
  readJsonFile,
  validateRuntimeConfig,
} = require('./runtime-config-canary-lib');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');

  if (!args.url && !args.file) {
    usageAndExit();
  }

  const source = args.url || args.file;
  const config = args.url
    ? await fetchRuntimeConfig(args.url, getVercelBypassSecret(args))
    : readJsonFile(path.resolve(repoRoot, args.file));

  const errors = validateRuntimeConfig(config, {
    label: source,
    requireCompleteFeatures: true,
  });

  if (args.expect) {
    const expected = readJsonFile(path.resolve(repoRoot, args.expect));
    errors.push(...compareRuntimeConfigFeatures(config, expected, source));
  }

  if (errors.length > 0) {
    console.error('Runtime config smoke failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Runtime config smoke ok: ${source}`);
  console.log(`Enabled features: ${formatEnabledFeatures(config)}`);
}

function parseArgs(rawArgs) {
  const result = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg.startsWith('--url=')) {
      result.url = arg.slice('--url='.length);
    } else if (arg === '--url') {
      result.url = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith('--file=')) {
      result.file = arg.slice('--file='.length);
    } else if (arg === '--file') {
      result.file = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith('--expect=')) {
      result.expect = arg.slice('--expect='.length);
    } else if (arg === '--expect') {
      result.expect = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith('--vercel-bypass-env=')) {
      result.vercelBypassEnv = arg.slice('--vercel-bypass-env='.length);
    } else if (arg === '--vercel-bypass-env') {
      result.vercelBypassEnv = rawArgs[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      usageAndExit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usageAndExit(1);
    }
  }

  if (result.url && result.file) {
    console.error('Use either --url or --file, not both.');
    usageAndExit(1);
  }

  return result;
}

async function fetchRuntimeConfig(url, vercelBypassSecret) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available in this Node runtime.');
  }

  const response = await fetch(url, {
    cache: 'no-store',
    headers: buildHeaders(vercelBypassSecret),
  });

  if (!response.ok) {
    throw new Error(`Runtime config request failed: HTTP ${response.status}`);
  }

  return response.json();
}

function buildHeaders(vercelBypassSecret) {
  const headers = { Accept: 'application/json' };

  if (vercelBypassSecret) {
    headers['x-vercel-protection-bypass'] = vercelBypassSecret;
  }

  return headers;
}

function getVercelBypassSecret(args) {
  const envName = args.vercelBypassEnv || 'VERCEL_AUTOMATION_BYPASS_SECRET';
  const value = process.env[envName];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function usageAndExit(code = 1) {
  const command = path.basename(process.argv[1]);
  console.error(
    [
      `Usage: node scripts/${command} --url <runtime-config-url> [--expect <example-json>]`,
      `   or: node scripts/${command} --file <runtime-config-json> [--expect <example-json>]`,
      '',
      'Optional for protected Vercel previews:',
      `  --vercel-bypass-env VERCEL_AUTOMATION_BYPASS_SECRET`,
    ].join('\n'),
  );
  process.exit(code);
}

main().catch((error) => {
  console.error(`Runtime config smoke failed: ${error.message}`);
  process.exit(1);
});
