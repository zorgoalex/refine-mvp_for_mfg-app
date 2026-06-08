import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readTemplate(relativePaths: string[]): string {
  const path = relativePaths
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
  expect(path, `Expected one of ${relativePaths.join(', ')} to exist`).toBeDefined();
  return readFileSync(path as string, 'utf8');
}

describe('VPS templates expose notification engine flags with safe defaults', () => {
  const compose = readTemplate([
    'ops/templates/docker-compose.vps.yml',
    '../ops/templates/docker-compose.vps.yml',
  ]);
  const envExample = readTemplate([
    'ops/templates/env.vps.example',
    '../ops/templates/env.vps.example',
  ]);

  it('docker-compose passes the engine + relay flags through with default-off values', () => {
    expect(compose).toContain(
      'BACKEND_ENABLE_NOTIFICATION_ENGINE: ${BACKEND_ENABLE_NOTIFICATION_ENGINE:-false}',
    );
    expect(compose).toContain(
      'BACKEND_NOTIFICATION_RULES_READ_ONLY: ${BACKEND_NOTIFICATION_RULES_READ_ONLY:-true}',
    );
    expect(compose).toContain('BACKEND_OUTBOX_RELAY_OWNER: ${BACKEND_OUTBOX_RELAY_OWNER:-none}');
    expect(compose).toContain(
      'BACKEND_OUTBOX_RELAY_POLL_INTERVAL_MS: ${BACKEND_OUTBOX_RELAY_POLL_INTERVAL_MS:-60000}',
    );
    expect(compose).toContain(
      'BACKEND_OUTBOX_RELAY_BATCH_SIZE: ${BACKEND_OUTBOX_RELAY_BATCH_SIZE:-100}',
    );
    expect(compose).toContain(
      'BACKEND_OUTBOX_RELAY_WORKER_ID: ${BACKEND_OUTBOX_RELAY_WORKER_ID:-backend-local}',
    );
    expect(compose).toContain(
      'BACKEND_OUTBOX_RELAY_MAX_ATTEMPTS: ${BACKEND_OUTBOX_RELAY_MAX_ATTEMPTS:-10}',
    );
  });

  it('env.vps.example documents the flags with safe defaults', () => {
    expect(envExample).toContain('BACKEND_ENABLE_NOTIFICATION_ENGINE=false');
    expect(envExample).toContain('BACKEND_NOTIFICATION_RULES_READ_ONLY=true');
    expect(envExample).toContain('BACKEND_OUTBOX_RELAY_OWNER=none');
    expect(envExample).toContain('BACKEND_OUTBOX_RELAY_POLL_INTERVAL_MS=60000');
    expect(envExample).toContain('BACKEND_OUTBOX_RELAY_BATCH_SIZE=100');
    expect(envExample).toContain('BACKEND_OUTBOX_RELAY_WORKER_ID=backend-local');
    expect(envExample).toContain('BACKEND_OUTBOX_RELAY_MAX_ATTEMPTS=10');
  });
});
