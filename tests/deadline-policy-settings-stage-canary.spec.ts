import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.DEADLINE_POLICY_SETTINGS_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_POLICY_SETTINGS_BACKEND_API_URL ??
    process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ??
    'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_POLICY_SETTINGS_POSTGRES_CONTAINER ??
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ??
  'erp_test-postgresdb-1';
const targetEnv = process.env.DEADLINE_POLICY_SETTINGS_TARGET_ENV ?? '';
const fixtureKey =
  process.env.DEADLINE_POLICY_SETTINGS_FIXTURE_KEY ??
  'deadline-policy-settings-canary-2026-05-24';
const policyCode =
  process.env.DEADLINE_POLICY_SETTINGS_POLICY_CODE ??
  'canary.policy-settings.20260524';
const policyCreateRequestId =
  process.env.DEADLINE_POLICY_SETTINGS_POLICY_CREATE_REQUEST_ID ??
  'req-deadline-policy-settings-policy-create-2026-05-24';
const policyUpdateRequestId =
  process.env.DEADLINE_POLICY_SETTINGS_POLICY_UPDATE_REQUEST_ID ??
  'req-deadline-policy-settings-policy-update-2026-05-24';
const settingsUpdateRequestId =
  process.env.DEADLINE_POLICY_SETTINGS_SETTINGS_UPDATE_REQUEST_ID ??
  'req-deadline-policy-settings-settings-update-2026-05-24';
const settingKey = 'setOverdueFlagEnabled';
const settingActionType = 'set_overdue_flag';
const settingScopes = ['order', 'order_stage', 'client_action'];

test.describe('deadline policy/settings stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set DEADLINE_POLICY_SETTINGS_STAGE_CANARY=true to enable the policy/settings stage canary.',
  );
  test.setTimeout(240000);

  const userIds: number[] = [];
  let baselineActionRules: ActionRulesSnapshot | null = null;
  let createdPolicyId: string | null = null;

  test.beforeAll(() => {
    requireCanaryEnv();
    assertNonProductionLikeTarget();
    assertNonProductionLikePostgresTarget();
    restoreFixtureRows();
    expectResidueRestored(loadResidueCounts());
    baselineActionRules = loadActionRulesSnapshot();
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (process.env.DEADLINE_POLICY_SETTINGS_RESTORE === 'true') {
        assertNonProductionLikePostgresTarget();
        restoreFixtureRows();
        if (baselineActionRules) restoreActionRulesSnapshot(baselineActionRules);
        expectResidueRestored(loadResidueCounts());
        if (baselineActionRules) expect(loadActionRulesSnapshot()).toEqual(baselineActionRules);
      }
    } catch (error) {
      restoreError = error;
    } finally {
      try {
        cleanupUsers(userIds);
      } catch (cleanupError) {
        if (!restoreError) throw cleanupError;
      }
      if (restoreError) throw restoreError;
    }
  });

  test('writes policy/settings through deployed backend and restores fixture-scoped residue', async ({
    request,
  }) => {
    expect(baselineActionRules).not.toBeNull();
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const adminUsername = `e2e_test_deadline_policy_settings_admin_${runId}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const managerUsername = `e2e_test_deadline_policy_settings_manager_${runId}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const adminPassword = crypto.randomBytes(24).toString('base64url');
    const managerPassword = crypto.randomBytes(24).toString('base64url');

    userIds.push(createSmokeUser(adminUsername, adminPassword, 1));
    userIds.push(createSmokeUser(managerUsername, managerPassword, 10));

    const adminToken = await loginForApiToken(request, adminUsername, adminPassword);
    const managerToken = await loginForApiToken(request, managerUsername, managerPassword);

    await expectReadAvailable(request, adminToken);

    await expectForbidden(
      request.post(`${backendApiUrl}/deadline-policies`, {
        data: policyCreatePayload(),
        headers: {
          Authorization: `Bearer ${managerToken}`,
          'x-request-id': `${policyCreateRequestId}-denied`,
        },
      }),
    );
    await expectForbidden(
      request.patch(`${backendApiUrl}/deadline-policies/11111111-1111-4111-8111-111111111111`, {
        data: { policyName: 'Denied deadline policy update' },
        headers: {
          Authorization: `Bearer ${managerToken}`,
          'x-request-id': `${policyUpdateRequestId}-denied`,
        },
      }),
    );
    await expectForbidden(
      request.patch(`${backendApiUrl}/deadline-settings`, {
        data: { [settingKey]: true },
        headers: {
          Authorization: `Bearer ${managerToken}`,
          'x-request-id': `${settingsUpdateRequestId}-denied`,
        },
      }),
    );

    const createResponse = await request.post(`${backendApiUrl}/deadline-policies`, {
      data: policyCreatePayload(),
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'x-request-id': policyCreateRequestId,
      },
    });
    await expectOk(createResponse, 201);
    const created = await expectPolicyResponse(createResponse);
    createdPolicyId = created.policy.policyId;
    expect(created.policy.policyCode).toBe(policyCode);
    expect(created.policy.policyName).toBe('Deadline policy/settings canary');
    expect(created.policy.scopeType).toBe('order');
    expect(created.policy.durationValue).toBe(2);
    expect(created.policy.durationUnit).toBe('working_day');

    const updateResponse = await request.patch(`${backendApiUrl}/deadline-policies/${createdPolicyId}`, {
      data: {
        policyName: 'Deadline policy/settings canary updated',
        durationValue: 3,
        isEnabled: false,
        config: { fixtureKey, fixtureRole: 'policy-settings-canary-updated' },
      },
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'x-request-id': policyUpdateRequestId,
      },
    });
    await expectOk(updateResponse);
    const updated = await expectPolicyResponse(updateResponse);
    expect(updated.policy.policyId).toBe(createdPolicyId);
    expect(updated.policy.policyName).toBe('Deadline policy/settings canary updated');
    expect(updated.policy.durationValue).toBe(3);
    expect(updated.policy.isEnabled).toBe(false);

    const baselineSettingValue = await loadSettingValue(request, adminToken);
    const targetSettingValue = !baselineSettingValue;
    const settingsResponse = await request.patch(`${backendApiUrl}/deadline-settings`, {
      data: { [settingKey]: targetSettingValue },
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'x-request-id': settingsUpdateRequestId,
      },
    });
    await expectOk(settingsResponse);
    const settings = await expectSettingsResponse(settingsResponse);
    expect(settings.settings[settingKey]).toBe(targetSettingValue);

    const policyEvidence = loadPolicyEvidence(createdPolicyId);
    expect(policyEvidence).toEqual({
      policyRows: 1,
      policyVersions: 2,
      createAuditRows: 1,
      updateAuditRows: 1,
      outboxRows: 0,
    });

    const settingsEvidence = loadSettingsEvidence(targetSettingValue);
    expect(settingsEvidence.scopedActionRules).toBeGreaterThanOrEqual(3);
    if (targetSettingValue) {
      expect(settingsEvidence.enabledActionRules).toBeGreaterThanOrEqual(3);
    } else {
      expect(settingsEvidence.enabledActionRules).toBe(0);
    }
    expect(settingsEvidence.settingsAuditRows).toBe(1);
    expect(settingsEvidence.outboxRows).toBe(0);

    console.log(
      JSON.stringify({
        fixtureKey,
        policyCode,
        policyId: createdPolicyId,
        policyCreateRequestId,
        policyUpdateRequestId,
        settingsUpdateRequestId,
        baselineActionRuleFingerprint: baselineActionRules?.fingerprint,
        policyEvidence,
        settingsEvidence,
      }),
    );
  });
});

function policyCreatePayload() {
  return {
    policyCode,
    policyName: 'Deadline policy/settings canary',
    scopeType: 'order',
    durationValue: 2,
    durationUnit: 'working_day',
    startPoint: 'order_created',
    isEnabled: true,
    config: { fixtureKey, fixtureRole: 'policy-settings-canary' },
  };
}

function requireCanaryEnv() {
  if (process.env.DEADLINE_POLICY_SETTINGS_RESTORE !== 'true') {
    throw new Error('DEADLINE_POLICY_SETTINGS_RESTORE=true is required');
  }
  if (targetEnv !== 'backend-test') {
    throw new Error('DEADLINE_POLICY_SETTINGS_TARGET_ENV=backend-test is required');
  }
  if (!fixtureKey.trim()) {
    throw new Error('DEADLINE_POLICY_SETTINGS_FIXTURE_KEY must not be empty');
  }
  if (!policyCode.trim()) {
    throw new Error('DEADLINE_POLICY_SETTINGS_POLICY_CODE must not be empty');
  }
}

function assertNonProductionLikeTarget() {
  const { hostname, pathname } = new URL(backendApiUrl);
  const safeHost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.local') ||
    hostname.includes('test') ||
    hostname.includes('stage') ||
    hostname.includes('staging') ||
    hostname.includes('dev');

  if (!safeHost || !pathname.startsWith('/api/v1')) {
    throw new Error(`Refusing to run policy/settings canary against production-like target: ${backendApiUrl}`);
  }
}

function assertNonProductionLikePostgresTarget() {
  const target = postgresContainer.toLowerCase();
  const isExplicitlyNonProduction =
    target.includes('test') ||
    target.includes('stage') ||
    target.includes('staging') ||
    target.includes('dev') ||
    target.includes('local') ||
    target.includes('localhost') ||
    target.includes('127.0.0.1');

  if (!isExplicitlyNonProduction) {
    throw new Error(`Refusing to run policy/settings canary cleanup against production-like postgres target: ${postgresContainer}`);
  }
}

async function expectReadAvailable(request: APIRequestContext, token: string) {
  const policies = await request.get(`${backendApiUrl}/deadline-policies`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(policies);
  const policyBody = await policies.json();
  expect(Array.isArray(policyBody.data)).toBe(true);

  const settings = await request.get(`${backendApiUrl}/deadline-settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(settings);
  await expectSettingsResponse(settings);
}

async function loadSettingValue(request: APIRequestContext, token: string): Promise<boolean> {
  const response = await request.get(`${backendApiUrl}/deadline-settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(response);
  const body = await expectSettingsResponse(response);
  return body.settings[settingKey];
}

async function loginForApiToken(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, {
    data: { username, password },
  });
  await expectOk(response);
  const body = await response.json();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken;
}

async function expectForbidden(responsePromise: Promise<APIResponse>) {
  const response = await responsePromise;
  const body = await readResponseBody(response);
  expect(response.status(), body).toBe(403);
  if (body.trim().startsWith('{')) {
    const parsed = JSON.parse(body);
    expect(parsed.error?.code ?? parsed.code).toBe('PERMISSION_DENIED');
  }
}

async function expectPolicyResponse(response: APIResponse): Promise<PolicyResponse> {
  const body = (await response.json()) as PolicyResponse;
  expect(typeof body.policy.policyId).toBe('string');
  expect(typeof body.policy.policyCode).toBe('string');
  return body;
}

async function expectSettingsResponse(response: APIResponse): Promise<SettingsResponse> {
  const body = (await response.json()) as SettingsResponse;
  expect(typeof body.settings.setOverdueFlagEnabled).toBe('boolean');
  return body;
}

async function expectOk(response: APIResponse, expectedStatus = 200) {
  const body = response.ok() ? '' : await response.text();
  expect(response.status(), body).toBe(expectedStatus);
  expect(response.ok(), body).toBe(true);
}

async function readResponseBody(response: APIResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function createSmokeUser(username: string, password: string, roleId: number): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);

  return Number(
    psql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
        VALUES (
          '${escapeSql(username)}',
          '${escapeSql(email)}',
          '${escapeSql(passwordHash)}',
          ${roleId},
          'E2E Test Deadline Policy Settings Stage Canary',
          true
        )
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
}

function cleanupUsers(ids: number[]) {
  if (ids.length === 0) return;
  const idList = ids.map((id) => String(id)).join(', ');

  psql(`
    DELETE FROM refresh_tokens WHERE user_id IN (${idList});
    DELETE FROM auth_sessions WHERE user_id IN (${idList});
    UPDATE users
    SET is_active = false,
        edited_by = NULL
    WHERE user_id IN (${idList});
  `);
}

function loadPolicyEvidence(policyId: string): PolicyEvidence {
  return psql<PolicyEvidence>(
    `
    SELECT json_build_object(
      'policyRows', (
        SELECT count(*)::int
        FROM deadline_policies
        WHERE policy_id = '${escapeSql(policyId)}'::uuid
          AND policy_code = '${escapeSql(policyCode)}'
      ),
      'policyVersions', (
        SELECT count(*)::int
        FROM deadline_policy_versions
        WHERE policy_id = '${escapeSql(policyId)}'::uuid
      ),
      'createAuditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE event = 'deadlines.policy.created'
          AND entity_type = 'deadline_policy'
          AND entity_id = '${escapeSql(policyId)}'
          AND request_id = '${escapeSql(policyCreateRequestId)}'
          AND source = 'backend-deadline-command'
      ),
      'updateAuditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE event = 'deadlines.policy.updated'
          AND entity_type = 'deadline_policy'
          AND entity_id = '${escapeSql(policyId)}'
          AND request_id = '${escapeSql(policyUpdateRequestId)}'
          AND source = 'backend-deadline-command'
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_id = '${escapeSql(policyId)}'
           OR payload_json->>'requestId' IN (
             '${escapeSql(policyCreateRequestId)}',
             '${escapeSql(policyUpdateRequestId)}'
           )
      )
    )::text;
    `,
    { json: true },
  );
}

function loadSettingsEvidence(expectedEnabled: boolean): SettingsEvidence {
  return psql<SettingsEvidence>(
    `
    WITH scoped_rules AS (
      SELECT action_rule_id, is_enabled
      FROM deadline_action_rules
      WHERE scope_type = ANY(ARRAY[${settingScopes.map((scope) => `'${escapeSql(scope)}'`).join(', ')}])
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = '${escapeSql(settingActionType)}'
    )
    SELECT json_build_object(
      'scopedActionRules', (SELECT count(*)::int FROM scoped_rules),
      'enabledActionRules', (
        SELECT count(*)::int
        FROM scoped_rules
        WHERE is_enabled = ${expectedEnabled ? 'true' : 'false'}
      ),
      'settingsAuditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE event = 'deadlines.settings.updated'
          AND entity_type = 'deadline_settings'
          AND entity_id = 'global'
          AND request_id = '${escapeSql(settingsUpdateRequestId)}'
          AND source = 'backend-deadline-command'
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE payload_json->>'requestId' = '${escapeSql(settingsUpdateRequestId)}'
      )
    )::text;
    `,
    { json: true },
  );
}

function restoreFixtureRows() {
  psql(`
    WITH scoped_policies AS (
      SELECT policy_id::text
      FROM deadline_policies
      WHERE policy_code = '${escapeSql(policyCode)}'
    ),
    deleted_audit AS (
      DELETE FROM audit_log
      WHERE request_id IN (
          '${escapeSql(policyCreateRequestId)}',
          '${escapeSql(policyUpdateRequestId)}',
          '${escapeSql(settingsUpdateRequestId)}'
        )
         OR (
          entity_type = 'deadline_policy'
          AND entity_id IN (SELECT policy_id FROM scoped_policies)
        )
      RETURNING 1
    )
    DELETE FROM deadline_policies
    WHERE policy_id::text IN (SELECT policy_id FROM scoped_policies);
  `);
}

function loadResidueCounts(): ResidueCounts {
  return psql<ResidueCounts>(
    `
    WITH scoped_policies AS (
      SELECT policy_id::text
      FROM deadline_policies
      WHERE policy_code = '${escapeSql(policyCode)}'
    )
    SELECT json_build_object(
      'policies', (SELECT count(*)::int FROM scoped_policies),
      'policyVersions', (
        SELECT count(*)::int
        FROM deadline_policy_versions
        WHERE policy_id::text IN (SELECT policy_id FROM scoped_policies)
      ),
      'auditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE request_id IN (
            '${escapeSql(policyCreateRequestId)}',
            '${escapeSql(policyUpdateRequestId)}',
            '${escapeSql(settingsUpdateRequestId)}'
          )
           OR (
            entity_type = 'deadline_policy'
            AND entity_id IN (SELECT policy_id FROM scoped_policies)
          )
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE payload_json->>'requestId' IN (
          '${escapeSql(policyCreateRequestId)}',
          '${escapeSql(policyUpdateRequestId)}',
          '${escapeSql(settingsUpdateRequestId)}'
        )
      )
    )::text;
    `,
    { json: true },
  );
}

function expectResidueRestored(counts: ResidueCounts) {
  expect(counts.policies).toBe(0);
  expect(counts.policyVersions).toBe(0);
  expect(counts.auditRows).toBe(0);
  expect(counts.outboxRows).toBe(0);
}

function loadActionRulesSnapshot(): ActionRulesSnapshot {
  return psql<ActionRulesSnapshot>(
    `
    WITH rows AS (
      SELECT
        action_rule_id::text,
        policy_id::text,
        scope_type,
        event_type,
        action_type,
        is_enabled,
        config_json,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM deadline_action_rules
      WHERE scope_type = ANY(ARRAY[${settingScopes.map((scope) => `'${escapeSql(scope)}'`).join(', ')}])
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = '${escapeSql(settingActionType)}'
      ORDER BY scope_type, action_rule_id
    )
    SELECT json_build_object(
      'rows', coalesce(json_agg(rows), '[]'::json),
      'fingerprint', md5(coalesce(jsonb_agg(to_jsonb(rows) ORDER BY scope_type, action_rule_id), '[]'::jsonb)::text)
    )::text
    FROM rows;
    `,
    { json: true },
  );
}

function restoreActionRulesSnapshot(snapshot: ActionRulesSnapshot) {
  const rowsJson = escapeSql(JSON.stringify(snapshot.rows));

  psql(`
    WITH snapshot AS (
      SELECT *
      FROM jsonb_to_recordset('${rowsJson}'::jsonb) AS row(
        action_rule_id uuid,
        policy_id uuid,
        scope_type text,
        event_type text,
        action_type text,
        is_enabled boolean,
        config_json jsonb,
        created_at timestamptz,
        updated_at timestamptz
      )
    ),
    upserted AS (
      INSERT INTO deadline_action_rules (
        action_rule_id, policy_id, scope_type, event_type, action_type,
        is_enabled, config_json, created_at, updated_at
      )
      SELECT
        action_rule_id, policy_id, scope_type, event_type, action_type,
        is_enabled, config_json, created_at, updated_at
      FROM snapshot
      ON CONFLICT (action_rule_id) DO UPDATE
      SET policy_id = EXCLUDED.policy_id,
          scope_type = EXCLUDED.scope_type,
          event_type = EXCLUDED.event_type,
          action_type = EXCLUDED.action_type,
          is_enabled = EXCLUDED.is_enabled,
          config_json = EXCLUDED.config_json,
          updated_at = EXCLUDED.updated_at
      RETURNING 1
    )
    DELETE FROM deadline_action_rules ar
    WHERE ar.scope_type = ANY(ARRAY[${settingScopes.map((scope) => `'${escapeSql(scope)}'`).join(', ')}])
      AND ar.event_type = 'DEADLINE_EXPIRED'
      AND ar.action_type = '${escapeSql(settingActionType)}'
      AND NOT EXISTS (
        SELECT 1
        FROM snapshot s
        WHERE s.action_rule_id = ar.action_rule_id
      );
  `);
}

function psql<T = string>(sql: string, options: { json?: boolean } = {}): T {
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      postgresContainer,
      'psql',
      '-U',
      'erp_user',
      '-d',
      'erpdb',
      '-qAtX',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();

  if (options.json) return JSON.parse(output) as T;
  return output as T;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

interface PolicyResponse {
  policy: {
    policyId: string;
    policyCode: string;
    policyName: string;
    scopeType: string;
    durationValue: number | null;
    durationUnit: string | null;
    isEnabled: boolean;
  };
}

interface SettingsResponse {
  settings: {
    setOverdueFlagEnabled: boolean;
  };
}

interface PolicyEvidence {
  policyRows: number;
  policyVersions: number;
  createAuditRows: number;
  updateAuditRows: number;
  outboxRows: number;
}

interface SettingsEvidence {
  scopedActionRules: number;
  enabledActionRules: number;
  settingsAuditRows: number;
  outboxRows: number;
}

interface ResidueCounts {
  policies: number;
  policyVersions: number;
  auditRows: number;
  outboxRows: number;
}

interface ActionRulesSnapshot {
  rows: Array<{
    action_rule_id: string;
    policy_id: string | null;
    scope_type: string;
    event_type: string;
    action_type: string;
    is_enabled: boolean;
    config_json: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }>;
  fingerprint: string;
}
