import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = process.cwd().endsWith('/backend') ? process.cwd() : resolve(process.cwd(), 'backend');
const contract = readFileSync(resolve(backendRoot, 'contracts/04-api-contract.openapi.yaml'), 'utf8');

describe('bounded CNC observation API contract', () => {
  it('documents a server-selected bounded claim with no client target or version inputs', () => {
    const section = operation('/api/v1/cnc-telegram/observation-worker/claim');
    expect(section).toContain('operationId: claimCncTelegramMdfObservation');
    expect(section).toContain('x-permission: cut.manage');
    expect(section).toContain('claimGeneration');
    expect(section).toContain('observationVersion');
    expect(section).toContain('maxItems: 3');
    expect(section).toContain('enum: [svg, gcode, image]');
    expect(section).not.toContain('requestBody:');
  });

  it('documents exact post-claim group facts, rejects unknown authority fields, and separates fetch failure', () => {
    const complete = operation('/api/v1/cnc-telegram/observation-worker/claims/{claimId}/complete');
    expect(complete).toContain('operationId: completeCncTelegramMdfObservation');
    expect(complete).toContain('additionalProperties: false');
    expect(complete).toContain('required: [claimId, claimToken, claimGeneration, messages]');
    for (const field of ['messageId', 'chatId', 'role', 'sha256', 'present', 'thumbsUp']) expect(complete).toContain(`${field}:`);
    expect(complete).not.toMatch(/sourceVersion:|observedAt:|completionStatus:/);

    const failure = operation('/api/v1/cnc-telegram/observation-worker/claims/{claimId}/fail');
    expect(failure).toContain('operationId: failCncTelegramMdfObservation');
    expect(failure).toContain('FETCH_FAILED');
    expect(failure).toContain('MESSAGE_MISSING');
    expect(failure).toContain('MESSAGE_MEDIA_MISMATCH');
  });

  it('keeps the old generic ingest path documented but does not redirect observation traffic through it', () => {
    const ingest = operation('/api/v1/cnc-telegram/ingest');
    const claim = operation('/api/v1/cnc-telegram/observation-worker/claim');
    expect(ingest).toContain('operationId: ingestCncTelegramPacket');
    expect(claim).toContain('observation-worker');
    expect(claim).not.toContain('/ingest');
  });
});

function operation(path: string): string {
  const start = contract.indexOf(`  ${path}:`);
  expect(start, `${path} is present`).toBeGreaterThanOrEqual(0);
  const end = contract.indexOf('\n  /api/v1/', start + 1);
  return contract.slice(start, end < 0 ? undefined : end);
}
