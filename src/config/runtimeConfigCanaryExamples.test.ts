import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  validateRuntimeConfig,
  validateStagedCanaryDirectory,
} = require('../../scripts/runtime-config-canary-lib.js');
const repoRoot = process.cwd();
const canaryDirectory = path.join(repoRoot, 'docs/runtime-config/canary');
const EXPECTED_FEATURE_KEYS = [
  'backendAuth',
  'backendPermissions',
  'backendOrdersRead',
  'backendOrdersWrite',
  'backendPayments',
  'backendClientPhones',
  'backendProductionActions',
  'backendDeadlines',
  'backendOrderExport',
  'backendUsers',
  'backendVlm',
  'backendReferences',
  'enableLegacyHasura',
];

describe('runtime config canary examples', () => {
  it('passes the staged canary validator', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/check-runtime-config-canary.js'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toContain('Runtime config canary examples validated');
  });

  it('keeps every example explicit about the full feature set', () => {
    const files = readdirSync(canaryDirectory)
      .filter((file) => file.endsWith('.json'))
      .sort();

    expect(files).toEqual([
      '00-all-off.json',
      '01-backend-auth.json',
      '02-backend-permissions.json',
      '03-orders-read.json',
      '04-orders-write.json',
      '05-order-export.json',
      '06-users.json',
      '07-vlm.json',
      '08-payments.json',
      '09-production-actions.json',
      '10-client-phones.json',
      '11-deadlines.json',
      '99-rollback-all-off.json',
    ]);

    for (const file of files) {
      const config = JSON.parse(readFileSync(path.join(canaryDirectory, file), 'utf8'));
      expect(Object.keys(config.features)).toEqual(EXPECTED_FEATURE_KEYS);
      expect(config.features.enableLegacyHasura, `${file}: enableLegacyHasura`).toBe(true);

      for (const key of EXPECTED_FEATURE_KEYS) {
        expect(typeof config.features[key], `${file}: ${key}`).toBe('boolean');
      }
    }
  });

  it('allows generic runtime config validation to disable legacy Hasura', () => {
    const config = JSON.parse(
      readFileSync(path.join(canaryDirectory, '99-rollback-all-off.json'), 'utf8'),
    );
    config.features.enableLegacyHasura = false;

    expect(
      validateRuntimeConfig(config, {
        label: 'runtime-config.json',
        requireCompleteFeatures: true,
      }),
    ).toEqual([]);
  });

  it('requires staged canary examples to keep legacy Hasura enabled', () => {
    const tempDirectory = mkdtempSync(path.join(tmpdir(), 'runtime-config-canary-'));

    try {
      cpSync(canaryDirectory, tempDirectory, { recursive: true });
      const rollbackPath = path.join(tempDirectory, '99-rollback-all-off.json');
      const config = JSON.parse(readFileSync(rollbackPath, 'utf8'));
      config.features.enableLegacyHasura = false;
      writeFileSync(rollbackPath, `${JSON.stringify(config, null, 2)}\n`);

      expect(validateStagedCanaryDirectory(tempDirectory)).toContain(
        '99-rollback-all-off.json: expected features.enableLegacyHasura=true, got false',
      );
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
