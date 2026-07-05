import { expect, test, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

import manifestLib from '../scripts/groups-live-backfill-manifest-lib.js';

const {
  buildGroupsLiveBackfillPlan,
  validateGroupsLiveBackfillDryRunResponse,
} = manifestLib as {
  buildGroupsLiveBackfillPlan: (manifest: unknown) => LiveBackfillPlan;
  validateGroupsLiveBackfillDryRunResponse: (
    chunk: LiveBackfillChunk,
    response: GroupBatchLinkDryRunResponse,
  ) => unknown;
};

const CANARY_ENABLED = process.env.GROUPS_LIVE_BACKFILL_DRY_RUN_STAGE_CANARY === 'true';
const targetEnv = process.env.GROUPS_LIVE_BACKFILL_TARGET_ENV?.trim() ?? '';
const manifestPath = process.env.GROUPS_LIVE_BACKFILL_MANIFEST_PATH?.trim() ?? '';
const backendApiUrl = trimTrailingSlash(
  process.env.GROUPS_LIVE_BACKFILL_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const username = process.env.GROUPS_LIVE_BACKFILL_USERNAME?.trim()
  || process.env.CODEX_PLAYWRIGHT_USERNAME?.trim()
  || '';
const password = process.env.GROUPS_LIVE_BACKFILL_PASSWORD
  || process.env.CODEX_PLAYWRIGHT_PASSWORD
  || '';

const missingPrerequisites = CANARY_ENABLED
  ? [
      targetEnv === 'backend-test' ? null : 'GROUPS_LIVE_BACKFILL_TARGET_ENV=backend-test',
      manifestPath ? null : 'GROUPS_LIVE_BACKFILL_MANIFEST_PATH',
      username ? null : 'GROUPS_LIVE_BACKFILL_USERNAME or CODEX_PLAYWRIGHT_USERNAME',
      password ? null : 'GROUPS_LIVE_BACKFILL_PASSWORD or CODEX_PLAYWRIGHT_PASSWORD',
    ].filter((value): value is string => Boolean(value))
  : [];

test.describe('Groups live backfill dry-run stage canary', () => {
  test.skip(!CANARY_ENABLED, 'Set GROUPS_LIVE_BACKFILL_DRY_RUN_STAGE_CANARY=true to enable.');
  test.skip(CANARY_ENABLED && missingPrerequisites.length > 0, `Missing prerequisites: ${missingPrerequisites.join(', ')}`);
  test.setTimeout(120000);

  test('runs manifest chunks in dry-run mode only', async ({ request }) => {
    requireBackendTestTarget();
    const plan = buildGroupsLiveBackfillPlan(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const token = await loginForApiToken(request);

    for (const chunk of plan.chunks) {
      const response = await postJson<GroupBatchLinkDryRunResponse>(
        request,
        `/groups/${chunk.groupId}/batch-link`,
        token,
        chunk.dryRunPayload,
      );

      expect(response.mode).toBe('dry-run');
      expect(response.writeEnabled).toBe(false);
      validateGroupsLiveBackfillDryRunResponse(chunk, response);
    }
  });
});

async function loginForApiToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, { data: { username, password } });
  expect(response.status(), 'login status').toBe(200);
  const body = await response.json() as { accessToken?: string };
  expect(body.accessToken, 'login access token').toBeTruthy();
  return body.accessToken!;
}

async function postJson<T>(
  request: APIRequestContext,
  path: string,
  token: string,
  data: unknown,
): Promise<T> {
  const response = await request.post(`${backendApiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  expect(response.status(), `${path} status`).toBe(200);
  return response.json() as Promise<T>;
}

function requireBackendTestTarget(): void {
  if (targetEnv !== 'backend-test') {
    throw new Error('GROUPS_LIVE_BACKFILL_TARGET_ENV=backend-test is required');
  }
  const parsedBackend = new URL(backendApiUrl);
  if (/prod|production|live/i.test(`${backendApiUrl} ${targetEnv}`)) {
    throw new Error('Refusing to run Groups live backfill dry-run against prod/live target');
  }
  expect(parsedBackend.hostname, 'dry-run canary must target backend-test').toBe('backend-test.mebelkz.app');
  expect(parsedBackend.pathname.replace(/\/+$/, ''), 'Backend API path must be /api/v1').toBe('/api/v1');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

interface LiveBackfillPlan {
  chunks: LiveBackfillChunk[];
}

interface LiveBackfillChunk {
  groupId: string;
  dryRunPayload: unknown & { items: unknown[] };
}

interface GroupBatchLinkDryRunResponse {
  groupId?: string;
  mode: 'dry-run' | 'write';
  summary: { proposed: number; skipped: number; conflicts: number; sampledEvidenceRows: number };
  proposals: unknown[];
  skipped: unknown[];
  sampleEvidence: unknown[];
  writeEnabled: boolean;
}
