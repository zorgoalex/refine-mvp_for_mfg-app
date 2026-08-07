import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = process.cwd().endsWith('/backend')
  ? process.cwd()
  : resolve(process.cwd(), 'backend');
const contract = readFileSync(
  resolve(backendRoot, 'contracts/04-api-contract.openapi.yaml'),
  'utf8',
);

describe('CNC Telegram OpenAPI contract', () => {
  it('documents the protected idempotent auto-cut configuration and backfill command', () => {
    const start = contract.indexOf('  /api/v1/cnc-telegram/auto-cut-status:');
    const end = contract.indexOf('  /api/v1/cnc-telegram/ingest:', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = contract.slice(start, end);
    expect(section).toContain('operationId: configureCncAutoCutStatus');
    expect(section).toContain('x-permission: status_automation.manage');
    expect(section).toContain('x-transactional: true');
    expect(section).toContain('name: Idempotency-Key');
    expect(section).toContain('maxLength: 160');
    expect(section.match(/additionalProperties: false/g)).toHaveLength(2);
    expect(section).toContain("'201':");
    for (const field of [
      'settingEnabled',
      'completedPacketCount',
      'matchedDetailCount',
      'wholeOrderCount',
      'changedOrderCount',
      'changedDetailCount',
    ]) {
      expect(section).toContain(`${field}:`);
    }
    for (const status of ['401', '403', '409', '422', '503']) {
      expect(section).toContain(`'${status}':`);
    }
  });

  it('documents cut.view and every supported raster type for raw Telegram media', () => {
    const start = contract.indexOf('  /api/v1/cnc-telegram/media/{storageKey}:');
    const end = contract.indexOf('\n  /api/v1/', start + 1);

    expect(start).toBeGreaterThanOrEqual(0);
    const section = contract.slice(start, end < 0 ? undefined : end);
    expect(section).toContain('operationId: getCncTelegramMedia');
    expect(section).toContain('x-permission: cut.view');
    expect(section).not.toContain('x-permission: orders.view');
    expect(section).toContain('image/jpeg:');
    expect(section).toContain('image/png:');
    expect(section).toContain('image/webp:');
  });
});
