import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import manifestLib from './groups-live-backfill-manifest-lib.js';

const {
  parseGroupsLiveBackfillRunArgs,
  resolveGroupsLiveBackfillRunConfig,
  assertGroupsLiveBackfillRunAllowed,
  runGroupsLiveBackfill,
} = manifestLib;

describe('groups live backfill runner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses required runner args and env-backed write approval', () => {
    const parsed = parseGroupsLiveBackfillRunArgs([
      '--manifest',
      '/tmp/manifest.json',
      '--mode',
      'write',
      '--target-env',
      'backend-test',
      '--username-env',
      'BACKFILL_USER',
      '--password-env',
      'BACKFILL_PASS',
    ]);

    expect(parsed).toEqual({
      manifestPath: '/tmp/manifest.json',
      mode: 'write',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      usernameEnv: 'BACKFILL_USER',
      passwordEnv: 'BACKFILL_PASS',
    });

    expect(resolveGroupsLiveBackfillRunConfig(parsed, {
      GROUPS_LIVE_BACKFILL_APPROVE_WRITE: 'true',
      BACKFILL_USER: 'manager',
      BACKFILL_PASS: 'secret',
    })).toMatchObject({
      approveWrite: true,
      username: 'manager',
      password: 'secret',
    });
  });

  it('covers guarded refusal cases before a runner is allowed', () => {
    expect(() => assertGroupsLiveBackfillRunAllowed({
      manifestPath: '/tmp/manifest.json',
      mode: 'dry-run',
      backendUrl: 'https://backend-production.mebelkz.app/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
    })).toThrow(/prod|production|live/);

    expect(() => assertGroupsLiveBackfillRunAllowed({
      manifestPath: '/tmp/manifest.json',
      mode: 'dry-run',
      backendUrl: 'https://example.com/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
    })).toThrow(/non-backend-test backend host/);

    expect(() => assertGroupsLiveBackfillRunAllowed({
      manifestPath: '/tmp/manifest.json',
      mode: 'dry-run',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1',
      targetEnv: 'production',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
    })).toThrow(/backend-test/);

    expect(() => assertGroupsLiveBackfillRunAllowed({
      manifestPath: '/tmp/manifest.json',
      mode: 'write',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
    })).toThrow(/approve-write/);

    expect(() => assertGroupsLiveBackfillRunAllowed({
      manifestPath: '/tmp/manifest.json',
      mode: 'dry-run',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
    })).not.toThrow();

    expect(() => assertGroupsLiveBackfillRunAllowed({
      manifestPath: '/tmp/manifest.json',
      mode: 'dry-run',
      backendUrl: 'http://localhost:3000/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
    })).not.toThrow();
  });

  it('refuses arbitrary non-prod backend hosts before network', async () => {
    const manifestPath = writeManifest(validManifest());
    const fetchMock = vi.fn();

    await expect(runGroupsLiveBackfill({
      manifestPath,
      mode: 'dry-run',
      backendUrl: 'https://example.com/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
      fetchImpl: fetchMock,
    })).rejects.toThrow(/non-backend-test backend host/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs dry-run chunks and returns a safe summary without credentials', async () => {
    const manifestPath = writeManifest(validManifest());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'token-redacted' }))
      .mockResolvedValueOnce(jsonResponse(200, dryRunResponse()));

    const summary = await runGroupsLiveBackfill({
      manifestPath,
      mode: 'dry-run',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://backend-test.mebelkz.app/api/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'manager', password: 'secret' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://backend-test.mebelkz.app/api/v1/groups/11111111-1111-4111-8111-111111111111/batch-link', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer token-redacted' }),
    }));
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(JSON.stringify(summary)).not.toContain('token-redacted');
    expect(summary).toEqual({
      mode: 'dry-run',
      groupId: '11111111-1111-4111-8111-111111111111',
      chunkCount: 1,
      itemCount: 1,
      chunks: [
        {
          chunkNumber: 1,
          status: 200,
          summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
          auditId: null,
          outboxEventId: null,
          requestIdPresent: true,
        },
      ],
    });
  });

  it('runs write chunks only with approval', async () => {
    const manifestPath = writeManifest(validManifest());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'token-redacted' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ...dryRunResponse(),
        mode: 'write',
        writeEnabled: true,
        summary: { proposed: 1, created: 1, existing: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
        auditId: 'audit-1',
        outboxEventId: 'outbox-1',
      }));

    const summary = await runGroupsLiveBackfill({
      manifestPath,
      mode: 'write',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1/',
      targetEnv: 'backend-test',
      approveWrite: true,
      username: 'manager',
      password: 'secret',
      fetchImpl: fetchMock,
    });

    const writeBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(writeBody.mode).toBe('write');
    expect(writeBody.writeIntent).toBe('explicit-selected-ids');
    expect(summary.chunks[0]).toMatchObject({
      chunkNumber: 1,
      status: 200,
      auditId: 'audit-1',
      outboxEventId: 'outbox-1',
      requestIdPresent: true,
    });
  });

  it('rejects unsafe manifests before any network request', async () => {
    const manifestPath = writeManifest({
      ...validManifest(),
      source: { type: 'auto_inference', reference: 'guessed' },
      items: [{ entityId: '11195', reason: 'guessed', confidence: 'inferred' }],
    });
    const fetchMock = vi.fn();

    await expect(runGroupsLiveBackfill({
      manifestPath,
      mode: 'dry-run',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1',
      targetEnv: 'backend-test',
      approveWrite: false,
      username: 'manager',
      password: 'secret',
      fetchImpl: fetchMock,
    })).rejects.toThrow(/manual_selected_ids/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function dryRunResponse() {
  return {
    groupId: '11111111-1111-4111-8111-111111111111',
    mode: 'dry-run',
    summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
    proposals: [{ entityId: '11195' }],
    skipped: [],
    sampleEvidence: [{ entityId: '11195' }],
    auditId: null,
    outboxEventId: null,
    requestId: 'req-1',
    writeEnabled: false,
  };
}

function writeManifest(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'groups-live-backfill-run-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  return manifestPath;
}

function validManifest() {
  return {
    fixtureKey: 'groups-live-backfill-2026-06-15',
    groupId: '11111111-1111-4111-8111-111111111111',
    entityType: 'order',
    relationType: 'manual_backfill',
    source: {
      type: 'manual_selected_ids',
      reference: 'operator-approved-backfill-2026-06-15',
    },
    items: [
      {
        entityId: '11195',
        reason: 'operator selected order for group backfill',
        confidence: 'manual',
        sourceRow: 'manifest-row-1',
      },
    ],
  };
}
