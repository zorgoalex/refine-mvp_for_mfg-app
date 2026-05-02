import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const canaryDirectory = path.join(repoRoot, 'docs/runtime-config/canary');
const featureKeys = [
  'backendAuth',
  'backendPermissions',
  'backendOrdersRead',
  'backendOrdersWrite',
  'backendOrderExport',
  'backendUsers',
  'backendVlm',
  'backendReferences',
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
      '99-rollback-all-off.json',
    ]);

    for (const file of files) {
      const config = JSON.parse(readFileSync(path.join(canaryDirectory, file), 'utf8'));
      expect(Object.keys(config.features).sort()).toEqual([...featureKeys].sort());

      for (const key of featureKeys) {
        expect(typeof config.features[key], `${file}: ${key}`).toBe('boolean');
      }
    }
  });
});
