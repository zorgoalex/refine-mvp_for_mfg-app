#!/usr/bin/env node

const { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { getPriority } = require('node:os');
const path = require('node:path');
const {
  createEvidenceLogger,
  createStageDependencies,
  parseOrderSseRolloutArgs,
  resolveOrderSseRolloutConfig,
  runRolloutController,
  safeErrorMessage,
} = require('./order-sse-rollout-lib.js');

const LOCK_PATH = '/tmp/erp-order-sse-rollout-stage.lock';

async function main(argv) {
  let config = null;
  let lock = null;
  let evidence = null;
  let finalSummary = null;
  let interruptedBy = null;
  const abortController = new AbortController();
  const interrupt = (signalName) => {
    if (interruptedBy) return;
    interruptedBy = signalName;
    evidence?.log('abort_requested', { signal: signalName });
    abortController.abort(new Error(signalName));
  };
  const sigint = () => interrupt('SIGINT');
  const sigterm = () => interrupt('SIGTERM');

  try {
    const parsed = parseOrderSseRolloutArgs(argv.slice(2));
    if (parsed.help) {
      printUsage();
      return;
    }
    config = resolveOrderSseRolloutConfig(parsed);
    assertGuardedRuntime();
    lock = acquireLock(LOCK_PATH);
    evidence = createEvidenceLogger(config.logRoot, config.mode);
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);

    evidence.log('run_started', {
      mode: config.mode,
      apply: config.apply,
      targetEnv: config.targetEnv,
      frontendUrl: config.frontendUrl,
      backendUrl: config.backendUrl,
      dbContainer: config.dbContainer,
      backendContainer: config.backendContainer,
      steps: config.steps,
      samplesPerStep: config.samplesPerStep,
      sampleIntervalSeconds: config.sampleIntervalSeconds,
      cacheWaitSeconds: config.cacheWaitSeconds,
      maxEventLatencyMs: config.maxEventLatencyMs,
      expectedStageSha: config.expectedStageSha,
      samples: config.samples,
      authRefreshEvery: config.authRefreshEvery,
      bypassConfigured: Boolean(config.vercelBypassSecret),
      pid: process.pid,
    });

    const dependencies = createStageDependencies(config, evidence.log, abortController.signal);
    const summary = await runRolloutController(config, dependencies);
    finalSummary = {
      ...summary,
      completedAt: new Date().toISOString(),
      evidence: {
        jsonl: evidence.jsonlPath,
        summary: evidence.summaryPath,
      },
    };
    evidence.log('run_completed', finalSummary);
  } catch (error) {
    finalSummary = {
      status: interruptedBy ? 'aborted' : 'failed',
      mode: config?.mode || 'unknown',
      error: safeErrorMessage(error),
      rollback: error?.rollback || null,
      qualification: error?.qualification || null,
      interruptedBy,
      completedAt: new Date().toISOString(),
      ...(evidence ? { evidence: {
        jsonl: evidence.jsonlPath,
        summary: evidence.summaryPath,
      } } : {}),
    };
    if (evidence) evidence.log('run_failed', finalSummary);
    else process.stderr.write(`${finalSummary.error}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    let lockReleased = lock === null;
    let cleanupError = null;
    if (lock) {
      try {
        lockReleased = lock.release();
        if (!lockReleased) cleanupError = 'rollout lock ownership changed before cleanup';
      } catch (error) {
        cleanupError = safeErrorMessage(error);
      }
      if (cleanupError) process.exitCode = 1;
    }
    if (evidence) {
      const cleanup = { lockReleased, pid: process.pid, ...(cleanupError ? { error: cleanupError } : {}) };
      evidence.log(cleanupError ? 'cleanup_failed' : 'cleanup_verified', cleanup);
      finalSummary = {
        ...(finalSummary || { status: 'failed', mode: config?.mode || 'unknown' }),
        cleanup,
      };
      if (cleanupError) finalSummary.status = 'cleanup_failed';
      try {
        evidence.validate();
        evidence.writeSummary(finalSummary);
      } finally {
        evidence.close();
      }
    }
  }
}

function assertGuardedRuntime() {
  const status = readFileSync('/proc/self/status', 'utf8');
  const allowedList = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]?.trim();
  const parentCmdline = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  const guardedParent = parentCmdline.includes('/home/ovhtest/.codex/rtk-heavy-guard');
  if (allowedList !== '0' || getPriority(0) < 10 || !guardedParent) {
    throw new Error(
      'Refusing unguarded launch: use scripts/order-sse-guarded-run.sh so CPU1/CPU2 blockers and guard own the run',
    );
  }
}

function acquireLock(lockPath) {
  try {
    const descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, `${process.pid}\n`);
    closeSync(descriptor);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existingPid = Number(readFileSync(lockPath, 'utf8').trim());
    if (Number.isSafeInteger(existingPid) && existingPid > 1 && isProcessAlive(existingPid)) {
      throw new Error(`Another Order SSE rollout controller is active: PID ${existingPid}`);
    }
    unlinkSync(lockPath);
    const descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, `${process.pid}\n`);
    closeSync(descriptor);
  }
  return {
    release() {
      try {
        const ownerPid = Number(readFileSync(lockPath, 'utf8').trim());
        if (ownerPid !== process.pid) return false;
        unlinkSync(lockPath);
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
      }
    },
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function printUsage() {
  process.stdout.write([
    'Stage-only Order SSE rollout controller.',
    '',
    'Preflight (read-only):',
    '  scripts/order-sse-guarded-run.sh --mode preflight',
    '',
    'Shadow canary for explicit user 83:',
    '  ORDER_SSE_ROLLOUT_APPROVE_STAGE=true scripts/order-sse-guarded-run.sh --mode shadow-canary --apply',
    '',
    'Closed-loop stage rollout:',
    '  ORDER_SSE_ROLLOUT_APPROVE_STAGE=true scripts/order-sse-guarded-run.sh --mode rollout --apply',
    '',
    'Accelerated exact-SHA qualification (90 samples / 60 seconds):',
    '  ORDER_SSE_ROLLOUT_APPROVE_STAGE=true scripts/order-sse-guarded-run.sh --mode accelerated-soak --apply --expected-stage-sha <40-hex-sha>',
    '',
    'Optional:',
    '  --steps 5,25,50,100',
    '  --samples-per-step 3',
    '  --sample-interval-seconds 20',
    '  --cache-wait-seconds 6',
    '  --max-event-latency-ms 2000',
    '  --samples 90',
    '  --auth-refresh-every 10',
    '  --expected-stage-sha <40-hex-sha>',
    '  --order-id <id>',
    '  --log-root <directory>',
    '',
    `Lock: ${path.basename(LOCK_PATH)}`,
  ].join('\n') + '\n');
}

main(process.argv).catch((error) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
