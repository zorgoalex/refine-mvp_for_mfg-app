import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import rolloutLib from './order-sse-rollout-lib.js';

const {
  assertDatabaseState,
  assertOrderSseRolloutAllowed,
  assertRuntimeConfig,
  countEligibleUsers,
  parseOrderSseRolloutArgs,
  planRolloutSteps,
  resolveOrderSseRolloutConfig,
  rolloutUpdateSql,
  runCommand,
  runRolloutController,
  sanitizeValue,
  stableCohort,
} = rolloutLib;

describe('Order SSE rollout controller', () => {
  it('parses conservative stage defaults', () => {
    const parsed = parseOrderSseRolloutArgs(['--mode', 'rollout', '--apply']);
    const config = resolveOrderSseRolloutConfig(parsed, {
      ERP_WORKER_LOGIN: 'cncworkertest',
      ERP_WORKER_PASSWORD: 'secret',
      ORDER_SSE_ROLLOUT_APPROVE_STAGE: 'true',
    }, '/home/ovhtest/projects/erp_dev');

    expect(config).toMatchObject({
      mode: 'rollout',
      apply: true,
      targetEnv: 'backend-test',
      frontendUrl: 'https://app-test.mebelkz.app',
      backendUrl: 'https://backend-test.mebelkz.app/api/v1',
      backendOrigin: 'https://backend-test.mebelkz.app',
      dbContainer: 'erp_test-postgresdb-1',
      steps: [5, 25, 50, 100],
      samplesPerStep: 3,
      approveStage: true,
    });
    expect(() => assertOrderSseRolloutAllowed(config)).not.toThrow();
  });

  it('refuses production, arbitrary hosts, and unapproved writes', () => {
    const base = validConfig();
    expect(() => assertOrderSseRolloutAllowed({ ...base, targetEnv: 'production' })).toThrow(/stage-only/);
    expect(() => assertOrderSseRolloutAllowed({ ...base, frontendUrl: 'https://mebelkz.app' })).toThrow(/non-stage/);
    expect(() => assertOrderSseRolloutAllowed({ ...base, backendUrl: 'https://example.com/api/v1' })).toThrow(/non-stage/);
    expect(() => assertOrderSseRolloutAllowed({ ...base, apply: false })).toThrow(/--apply/);
    expect(() => assertOrderSseRolloutAllowed({ ...base, approveStage: false })).toThrow(/APPROVE_STAGE/);
  });

  it('requires user 83 and exact stage settings', () => {
    expect(assertDatabaseState(validDatabaseState()).rollout).toEqual({
      enabled: true,
      userIds: ['83'],
      rolloutPercent: 0,
    });
    expect(() => assertDatabaseState({
      ...validDatabaseState(),
      user83: { ...validDatabaseState().user83, username: '' },
    })).toThrow(/has no username/);
    expect(() => assertDatabaseState({
      ...validDatabaseState(),
      rollout: { enabled: true, userIds: [], rolloutPercent: 0 },
    })).toThrow(/only user 83/);
  });

  it('blocks percentage rollout while allowing shadow preflight when live runtime is false', () => {
    const runtime = validRuntimeConfig(false);
    expect(assertRuntimeConfig(runtime, 'shadow-canary')).toBe(false);
    expect(() => assertRuntimeConfig(runtime, 'rollout')).toThrow(/percentage rollout is blocked/);
    expect(assertRuntimeConfig(validRuntimeConfig(true), 'rollout')).toBe(true);
  });

  it('uses the same deterministic cohort and plans only forward steps', () => {
    expect([stableCohort(1), stableCohort(2), stableCohort(83), stableCohort(158)]).toEqual([77, 59, 53, 12]);
    expect(countEligibleUsers([1, 2, 83, 158], 0)).toBe(1);
    expect(countEligibleUsers([1, 2, 83, 158], 25)).toBe(2);
    expect(countEligibleUsers([1, 2, 83, 158], 100)).toBe(4);
    expect(planRolloutSteps(25, [5, 25, 50, 100])).toEqual([50, 100]);
    expect(planRolloutSteps(100, [5, 25, 50, 100])).toEqual([]);
  });

  it('uses compare-and-set SQL and preserves explicit user 83', () => {
    const sql = rolloutUpdateSql(5, 25);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('order-sse-rollout-stage-v1'))");
    expect(sql).toContain("'userIds', jsonb_build_array(83)");
    expect(sql).toContain("'rolloutPercent', 5");
    expect(sql).toContain("to_jsonb(25::integer)");
  });

  it('redacts credentials and authorization values from evidence', () => {
    const result = sanitizeValue({
      password: 'secret-value',
      accessToken: 'token-value',
      message: [
        'Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l',
        'Cookie: session=raw-cookie-value; refresh=raw-refresh-value',
        'Set-Cookie: refresh=raw-set-cookie-value',
        'x-vercel-protection-bypass: raw-bypass-value',
        'password=hunter2 access_token=raw-access-value',
        '"refreshToken":"raw-json-refresh"',
      ].join('\n'),
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(JSON.stringify(result)).not.toContain('token-value');
    expect(JSON.stringify(result)).not.toContain('YWxhZGRpbjpvcGVuc2VzYW1l');
    expect(JSON.stringify(result)).not.toContain('raw-cookie-value');
    expect(JSON.stringify(result)).not.toContain('raw-refresh-value');
    expect(JSON.stringify(result)).not.toContain('raw-set-cookie-value');
    expect(JSON.stringify(result)).not.toContain('raw-bypass-value');
    expect(JSON.stringify(result)).not.toContain('raw-access-value');
    expect(JSON.stringify(result)).not.toContain('raw-json-refresh');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('advances through every verified step', async () => {
    const transitions = [];
    const samples = [];
    const dependencies = fakeDependencies({
      setRolloutPercent: async (from, to) => transitions.push([from, to]),
      sample: async (input) => {
        samples.push(input);
        return { eventLatencyMs: 12, cursorChanged: true, logErrorCount: 0 };
      },
    });

    const result = await runRolloutController(validConfig(), dependencies);

    expect(transitions).toEqual([[0, 5], [5, 25], [25, 50], [50, 100]]);
    expect(samples).toHaveLength(1 + 4 * 3);
    expect(result).toMatchObject({
      status: 'rollout_passed',
      finalPercent: 100,
      verifiedPercent: 100,
      baseline: { eventLatencyMs: 12, cursorChanged: true, logErrorCount: 0 },
    });
  });

  it('rolls back to the last verified percentage when a sample fails', async () => {
    const transitions = [];
    let rolloutSample = 0;
    const dependencies = fakeDependencies({
      setRolloutPercent: async (from, to) => transitions.push([from, to, false]),
      rollbackRolloutPercent: async (from, to) => {
        transitions.push([from, to, true]);
        return { status: 'completed' };
      },
      sample: async (input) => {
        if (input.phase === 'rollout') {
          rolloutSample += 1;
          if (rolloutSample === 4) throw new Error('forced canary failure token=do-not-log');
        }
        return { eventLatencyMs: 12, cursorChanged: true, logErrorCount: 0 };
      },
    });

    await expect(runRolloutController(validConfig(), dependencies)).rejects.toThrow(/forced canary failure/);
    expect(transitions).toEqual([
      [0, 5, false],
      [5, 25, false],
      [25, 5, true],
    ]);
  });

  it('reconciles an ambiguous percentage write acknowledgement', async () => {
    const rollbackRolloutPercent = vi.fn(async () => ({ status: 'completed' }));
    const dependencies = fakeDependencies({
      setRolloutPercent: async () => { throw new Error('connection closed after commit'); },
      rollbackRolloutPercent,
    });

    await expect(runRolloutController(validConfig(), dependencies)).rejects.toMatchObject({
      rollback: { status: 'completed', fromPercent: 5, toPercent: 0 },
    });
    expect(rollbackRolloutPercent).toHaveBeenCalledWith(5, 0);
  });

  it('does not mutate rollout when baseline canary fails', async () => {
    const setRolloutPercent = vi.fn();
    const dependencies = fakeDependencies({
      setRolloutPercent,
      sample: async () => { throw new Error('baseline failed'); },
    });

    await expect(runRolloutController(validConfig(), dependencies)).rejects.toThrow(/baseline failed/);
    expect(setRolloutPercent).not.toHaveBeenCalled();
  });

  it('bounds child cleanup after abort so orchestration can reach rollback', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const command = runCommand(process.execPath, [
      '-e',
      "process.on('SIGINT',()=>{}); setInterval(()=>{},1000)",
    ], { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);

    await expect(command).rejects.toThrow(/aborted/);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('shows only guarded heavy-run commands in CLI help', () => {
    const source = readFileSync(new URL('./order-sse-rollout.js', import.meta.url), 'utf8');
    const examples = source.match(/'  .*npm run order-sse:rollout[^']*'/g) || [];
    expect(examples).toHaveLength(3);
    for (const example of examples) {
      expect(example).toContain('rtk nice -n 10 taskset -c 0 /home/ovhtest/.codex/rtk-heavy-guard --');
    }
    expect(source).toContain('assertGuardedRuntime();');
    expect(source).toContain("allowedList !== '0' || getPriority(0) < 10");
  });
});

function validConfig() {
  return {
    mode: 'rollout',
    apply: true,
    approveStage: true,
    targetEnv: 'backend-test',
    frontendUrl: 'https://app-test.mebelkz.app',
    backendUrl: 'https://backend-test.mebelkz.app/api/v1',
    dbContainer: 'erp_test-postgresdb-1',
    backendContainer: 'erp_test-backend-1',
    username: 'cncworkertest',
    password: 'secret',
    steps: [5, 25, 50, 100],
    samplesPerStep: 3,
    sampleIntervalSeconds: 1,
    cacheWaitSeconds: 5,
    maxEventLatencyMs: 2000,
  };
}

function validDatabaseState() {
  return {
    user83: { userId: 83, username: 'cncworkertest', roleId: 11, isActive: true },
    rollout: { enabled: true, userIds: [83], rolloutPercent: 0 },
    writes: { enabled: true, maxFanoutOrders: 5000, maxDetailIds: 500 },
    streamTablePresent: true,
    eventLogPresent: true,
    emitFunctionPresent: true,
    activeUserIds: [1, 2, 83, 158],
  };
}

function validRuntimeConfig(orderRealtime) {
  return {
    apiUrl: 'https://backend-test.mebelkz.app',
    features: { backendAuth: true, backendOrdersRead: true, orderRealtime },
  };
}

function fakeDependencies(overrides = {}) {
  return {
    preflight: async () => ({
      database: validDatabaseState(),
      runtimeConfig: validRuntimeConfig(true),
      orderId: 11462,
    }),
    setRolloutPercent: async () => undefined,
    rollbackRolloutPercent: async () => ({ status: 'completed' }),
    sample: async () => ({ eventLatencyMs: 10, cursorChanged: true, logErrorCount: 0 }),
    sleep: async () => undefined,
    log: () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}
