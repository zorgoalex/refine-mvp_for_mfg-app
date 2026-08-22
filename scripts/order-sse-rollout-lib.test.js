import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import rolloutLib from './order-sse-rollout-lib.js';

const {
  STAGE_REMOTE_URL,
  assertDatabaseState,
  assertBackendReadyPayload,
  attachFetchResponseCleanup,
  assertOrderSseRolloutAllowed,
  assertRuntimeConfig,
  countEligibleUsers,
  createEvidenceLogger,
  discardFetchResponse,
  parseOrderSseRolloutArgs,
  planRolloutSteps,
  releaseFetchResponse,
  resolveOrderSseRolloutConfig,
  rolloutUpdateSql,
  runCommand,
  runRolloutController,
  sanitizeValue,
  stableCohort,
} = rolloutLib;

describe('Order SSE rollout controller', () => {
  it('pins canonical stage identity to the repository URL instead of cwd origin', () => {
    expect(STAGE_REMOTE_URL).toBe('https://github.com/zorgoalex/refine-mvp_for_mfg-app.git');
    const source = readFileSync(new URL('./order-sse-rollout-lib.js', import.meta.url), 'utf8');
    expect(source).toContain("['git', 'ls-remote', '--heads', STAGE_REMOTE_URL, STAGE_REF]");
    expect(source).not.toContain("['git', 'ls-remote', '--heads', 'origin', STAGE_REF]");
  });

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

  it('parses accelerated qualification defaults and immutable SHA', () => {
    const sha = 'a154fef554948d9643630a827cb1aa4795117e54';
    const parsed = parseOrderSseRolloutArgs([
      '--mode', 'accelerated-soak', '--apply', '--expected-stage-sha', sha,
    ]);
    const config = resolveOrderSseRolloutConfig(parsed, {
      ERP_WORKER_LOGIN: 'cncworkertest',
      ERP_WORKER_PASSWORD: 'secret',
      ORDER_SSE_ROLLOUT_APPROVE_STAGE: 'true',
    }, '/home/ovhtest/projects/erp_dev');

    expect(config).toMatchObject({
      mode: 'accelerated-soak',
      expectedStageSha: sha,
      samples: 90,
      sampleIntervalSeconds: 60,
      authRefreshEvery: 10,
    });
    expect(() => assertOrderSseRolloutAllowed(config)).not.toThrow();
    expect(() => parseOrderSseRolloutArgs([
      '--mode', 'accelerated-soak', '--expected-stage-sha', 'short',
    ])).toThrow(/40-character/);
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
    expect(() => assertRuntimeConfig(runtime, 'rollout')).toThrow(/realtime qualification is blocked/);
    expect(assertRuntimeConfig(validRuntimeConfig(true), 'rollout')).toBe(true);
  });

  it('rejects disabled realtime health and mismatched backend deployment identity', () => {
    const sha = 'a154fef554948d9643630a827cb1aa4795117e54';
    expect(() => assertBackendReadyPayload({
      status: 'ready',
      deployment: { gitCommitSha: sha },
      checks: { realtime: { status: 'ok', message: 'order realtime stream disabled' } },
    }, sha)).toThrow(/stream is disabled/);
    expect(() => assertBackendReadyPayload({
      status: 'ready',
      deployment: { gitCommitSha: 'b'.repeat(40) },
      checks: { realtime: { status: 'ok' } },
    }, sha)).toThrow(/deployment SHA mismatch/);
    expect(assertBackendReadyPayload({
      status: 'ready',
      deployment: { gitCommitSha: sha },
      checks: { realtime: { status: 'ok' } },
    }, sha)).toMatchObject({ status: 'ready' });
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

  it('releases bounded fetch ownership after body consumption or explicit stream cleanup', async () => {
    const consumedCleanup = vi.fn();
    const consumed = attachFetchResponseCleanup(new Response('ok'), consumedCleanup);
    await expect(consumed.text()).resolves.toBe('ok');
    expect(consumedCleanup).toHaveBeenCalledTimes(1);

    const streamCleanup = vi.fn();
    const stream = attachFetchResponseCleanup(new Response('stream'), streamCleanup);
    releaseFetchResponse(stream);
    expect(streamCleanup).toHaveBeenCalledTimes(1);

    const discardedCleanup = vi.fn();
    const discarded = attachFetchResponseCleanup(new Response('discarded'), discardedCleanup);
    await discardFetchResponse(discarded);
    expect(discardedCleanup).toHaveBeenCalledTimes(1);
    expect(discarded.bodyUsed).toBe(true);
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

  it('runs exact accelerated samples on a fixed cadence with periodic re-auth', async () => {
    const sha = 'a154fef554948d9643630a827cb1aa4795117e54';
    let clock = Date.parse('2026-08-20T22:00:00.000Z');
    const resetAuth = vi.fn();
    const verifyCandidateIdentity = vi.fn(async () => ({
      stageSha: sha,
      frontendSha: sha,
      backendSha: sha,
    }));
    const sample = vi.fn(async () => ({ eventLatencyMs: 15, cursorChanged: true, logErrorCount: 0 }));
    const config = {
      ...validConfig(),
      mode: 'accelerated-soak',
      expectedStageSha: sha,
      samples: 3,
      authRefreshEvery: 2,
      sampleIntervalSeconds: 60,
    };
    const dependencies = fakeDependencies({
      resetAuth,
      verifyCandidateIdentity,
      sample,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    });

    const result = await runRolloutController(config, dependencies);

    expect(result).toMatchObject({
      status: 'accelerated_soak_passed',
      expectedSamples: 3,
      completedSamples: 3,
      failureCount: 0,
      expectedStageSha: sha,
    });
    expect(sample).toHaveBeenCalledTimes(3);
    expect(verifyCandidateIdentity).toHaveBeenCalledTimes(6);
    expect(resetAuth).toHaveBeenCalledTimes(2);
    expect(clock).toBe(Date.parse('2026-08-20T22:02:00.000Z'));
  });

  it('fails accelerated qualification on the first identity error', async () => {
    const sha = 'a154fef554948d9643630a827cb1aa4795117e54';
    const dependencies = fakeDependencies({
      verifyCandidateIdentity: vi.fn(async () => { throw new Error('frontend deployment SHA mismatch'); }),
      resetAuth: vi.fn(),
      now: () => 0,
    });
    const config = {
      ...validConfig(),
      mode: 'accelerated-soak',
      expectedStageSha: sha,
      samples: 3,
    };

    await expect(runRolloutController(config, dependencies)).rejects.toMatchObject({
      qualification: {
        expectedSamples: 3,
        completedSamples: 0,
        failureCount: 1,
        failedSample: 1,
      },
    });
  });

  it('writes durable evidence atomically and rejects collisions or partial JSONL', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'order-sse-evidence-'));
    const now = new Date('2026-08-20T22:00:00.000Z');
    try {
      const evidence = createEvidenceLogger(root, 'accelerated-soak', now);
      evidence.log('run_started', { accessToken: 'must-not-survive' });
      expect(evidence.validate()).toEqual({ records: 1 });
      evidence.writeSummary({ status: 'pass' });
      evidence.close();
      expect(JSON.parse(readFileSync(evidence.summaryPath, 'utf8'))).toEqual({ status: 'pass' });
      expect(readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(false);
      expect(() => createEvidenceLogger(root, 'accelerated-soak', now)).toThrow();

      const partial = createEvidenceLogger(root, 'preflight', now);
      partial.log('run_started');
      appendFileSync(partial.jsonlPath, '{partial');
      expect(() => partial.validate()).toThrow();
      partial.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds child cleanup after abort so orchestration can reach rollback', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const command = runCommand(process.execPath, [
      '-e',
      "process.on('SIGINT',()=>{}); setInterval(()=>{},1000)",
    ], {
      signal: controller.signal,
      abortIntGraceMs: 25,
      abortTermGraceMs: 25,
      abortKillGraceMs: 100,
    });
    setTimeout(() => controller.abort(), 25);

    await expect(command).rejects.toThrow(/aborted/);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('requires the exact guarded launcher and direct guard parent proof', () => {
    const source = readFileSync(new URL('./order-sse-rollout.js', import.meta.url), 'utf8');
    const launcher = readFileSync(new URL('./order-sse-guarded-run.sh', import.meta.url), 'utf8');
    expect(source).toContain('assertGuardedRuntime();');
    expect(source).toContain("allowedList !== '0' || getPriority(0) < 10 || !guardedParent");
    expect(source).toContain('/home/ovhtest/.codex/rtk-heavy-guard');
    expect(source).toContain("if (!lockReleased) cleanupError = 'rollout lock ownership changed before cleanup'");
    expect(launcher).toContain('/tmp/codex-rtk-heavy-core.1.lock');
    expect(launcher).toContain('/tmp/codex-rtk-heavy-core.2.lock');
    expect(launcher).toContain('flock --no-fork --nonblock --conflict-exit-code 75');
    expect(launcher).toContain('node --env-file="$PROJECT_ENV"');
    expect(launcher).not.toContain('dotenv/config');
    expect(launcher).toContain('node --env-file="$PROJECT_ENV" "$SCRIPT_DIR/order-sse-rollout.js" "$@"');
    expect(launcher).not.toContain('npm run order-sse:rollout');
  });

  it('prepares the continuous monitor without enabling it', () => {
    const installer = readFileSync(
      new URL('../ops/install-order-sse-continuous-monitor.sh', import.meta.url),
      'utf8',
    );
    const service = readFileSync(
      new URL('../ops/systemd/order-sse-continuous-monitor.service', import.meta.url),
      'utf8',
    );
    const runner = readFileSync(
      new URL('../ops/order-sse-continuous-once.sh', import.meta.url),
      'utf8',
    );
    expect(installer).toContain('Prepared only. Start later with:');
    expect(installer).toContain('is-active --quiet order-sse-continuous-monitor.timer');
    expect(installer).toContain('is-enabled --quiet order-sse-continuous-monitor.timer');
    expect(installer).toContain('is-active --quiet order-sse-continuous-monitor.service');
    expect(installer).toContain('actual_sha="$(git -C "$REPO_DIR" rev-parse --verify HEAD');
    expect(installer).toContain('candidates/$SHA');
    expect(installer).toContain('ORDER_SSE_RUNNER_DIR=%s');
    expect(installer).not.toMatch(/^\s*systemctl --user (?:enable|start)/m);
    expect(service).toContain('TimeoutStartSec=120s');
    expect(service).toContain('KillMode=mixed');
    expect(service).toContain('ExecStart=%h/.local/libexec/erp-order-sse/order-sse-continuous-once.sh');
    expect(service).not.toContain('/home/ovhtest/projects/erp_dev/repo_erp');
    expect(runner).toContain("-mtime +30 -delete");
    expect(runner).toContain('ORDER_SSE_RUNNER_DIR:?ORDER_SSE_RUNNER_DIR is required');
    expect(runner).toContain('candidate bundle SHA mismatch');
    expect(runner).toContain("trap 'forward_signal TERM' TERM");
    expect(runner).toContain("trap 'forward_signal INT' INT");
    expect(runner).toContain('wait "$child_pid"');
  });

  it('publishes backend identity only from a clean exact repository HEAD', () => {
    const deploy = readFileSync(new URL('../ops/deploy-stack.sh', import.meta.url), 'utf8');
    const compose = readFileSync(
      new URL('../ops/templates/docker-compose.vps.yml', import.meta.url),
      'utf8',
    );
    const dockerfile = readFileSync(new URL('../backend/Dockerfile', import.meta.url), 'utf8');
    const identityOverlay = readFileSync(
      new URL('../ops/templates/docker-compose.backend-build-identity.yml', import.meta.url),
      'utf8',
    );
    expect(deploy).toContain('rev-parse --verify HEAD');
    expect(deploy).toContain('status --porcelain --untracked-files=normal');
    expect(deploy).toContain('BACKEND_BUILD_SHA does not match exact repository HEAD');
    expect(deploy).toContain('export BACKEND_BUILD_SHA="$revision"');
    expect(deploy).toContain('export BACKEND_BUILD_CONTEXT="$backend_context"');
    expect(deploy).toContain('export BACKEND_BUILD_IMAGE="$expected_image"');
    expect(deploy).toContain('BACKEND_IDENTITY_OVERLAY');
    expect(deploy).toContain('assert_backend_image_revision');
    expect(deploy).toContain('["services"]["backend"]["image"]');
    expect(compose).toContain('BACKEND_BUILD_SHA: ${BACKEND_BUILD_SHA:-}');
    expect(compose).toContain('BACKEND_BUILD_SHA: ${BACKEND_BUILD_SHA:-local}');
    expect(identityOverlay).toContain('image: ${BACKEND_BUILD_IMAGE:?');
    expect(identityOverlay).toContain('context: ${BACKEND_BUILD_CONTEXT:?');
    expect(identityOverlay).toContain('BACKEND_BUILD_SHA: ${BACKEND_BUILD_SHA:?');
    expect(dockerfile).toContain('LABEL org.opencontainers.image.revision="$BACKEND_BUILD_SHA"');
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
    samples: 90,
    authRefreshEvery: 10,
    expectedStageSha: null,
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
    deployment: { gitCommitSha: null },
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
    verifyCandidateIdentity: async () => ({ stageSha: null, frontendSha: null, backendSha: null }),
    resetAuth: () => undefined,
    now: () => Date.now(),
    ...overrides,
  };
}
