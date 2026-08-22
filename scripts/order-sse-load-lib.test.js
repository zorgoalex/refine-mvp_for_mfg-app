import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import loadLib from './order-sse-load-lib.js';

const {
  assertIsolatedLoadAllowed,
  assertIsolatedTargetResolution,
  assertSharedStageCleanupAllowed,
  assertSharedStageLoadAllowed,
  assertSharedStageTargetResolution,
  calculateCpuBusyPercent,
  consumeSseCommentChunk,
  consumeSseLoadChunk,
  evaluateSharedStageCpuSafety,
  parseOrderSseLoadArgs,
  parseProcStatCpuSnapshot,
  readLoadCredentials,
} = loadLib;

describe('Order SSE isolated load safety', () => {
  const validConfig = () => parseOrderSseLoadArgs([
    '--target-env', 'isolated-load',
    '--backend-url', 'https://sse-load.example.invalid/api/v1',
    '--credential-file', '/secure/credentials.json',
    '--log-root', '/evidence',
  ]);

  it('accepts only explicit isolated target approval', () => {
    expect(() => assertIsolatedLoadAllowed(
      validConfig(),
      { ORDER_SSE_LOAD_APPROVE_ISOLATED: 'true' },
      { hostname: 'isolated-runner', sharedMarkerPresent: false },
    )).not.toThrow();
    expect(() => assertIsolatedLoadAllowed(
      validConfig(),
      {},
      { hostname: 'isolated-runner', sharedMarkerPresent: false },
    )).toThrow(/APPROVE_ISOLATED/);
  });

  it('hard-denies this runner and every mebelkz target', () => {
    expect(() => assertIsolatedLoadAllowed(
      validConfig(),
      { ORDER_SSE_LOAD_APPROVE_ISOLATED: 'true' },
      { hostname: 'vps-01fca05c', sharedMarkerPresent: true },
    )).toThrow(/forbidden on the ERP shared host/);
    const sharedTarget = { ...validConfig(), backendUrl: 'https://backend-test.mebelkz.app/api/v1' };
    expect(() => assertIsolatedLoadAllowed(
      sharedTarget,
      { ORDER_SSE_LOAD_APPROVE_ISOLATED: 'true' },
      { hostname: 'isolated-runner', sharedMarkerPresent: false },
    )).toThrow(/target is forbidden/);
    expect(() => assertIsolatedLoadAllowed(
      { ...validConfig(), backendUrl: 'https://mebelkz.app/api/v1' },
      { ORDER_SSE_LOAD_APPROVE_ISOLATED: 'true' },
      { hostname: 'isolated-runner', sharedMarkerPresent: false },
    )).toThrow(/target is forbidden/);
    expect(() => assertIsolatedLoadAllowed(
      { ...validConfig(), backendUrl: 'https://135.125.181.241/api/v1' },
      { ORDER_SSE_LOAD_APPROVE_ISOLATED: 'true' },
      { hostname: 'isolated-runner', sharedMarkerPresent: false },
    )).toThrow(/target is forbidden/);
  });

  it('rejects a DNS alias that resolves to the ERP shared address', async () => {
    await expect(assertIsolatedTargetResolution(
      validConfig(),
      async () => [{ address: '::ffff:135.125.181.241', family: 6 }],
    )).rejects.toThrow(/forbidden shared address/);
  });

  it('accepts DNS resolution to a distinct isolated address', async () => {
    await expect(assertIsolatedTargetResolution(
      validConfig(),
      async () => [{ address: '192.0.2.25', family: 4 }],
    )).resolves.toBeUndefined();
  });

  it('requires enough distinct credential capacity for the per-user cap', () => {
    const parsed = validConfig();
    expect(parsed).toMatchObject({ clients: 200, connectionsPerUser: 20 });
    expect(() => parseOrderSseLoadArgs(['--clients', '2001'])).toThrow(/integer/);
  });

  it('requires a private credential file with sufficient connection capacity', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'order-sse-load-'));
    const credentialFile = path.join(root, 'credentials.json');
    try {
      writeFileSync(credentialFile, JSON.stringify([
        { username: 'load-1', password: 'secret', orderId: 10 },
        { username: 'load-2', password: 'secret', orderId: 11 },
      ]));
      chmodSync(credentialFile, 0o600);
      const config = { ...validConfig(), credentialFile, clients: 40, connectionsPerUser: 20 };
      expect(readLoadCredentials(config)).toHaveLength(2);

      chmodSync(credentialFile, 0o640);
      expect(() => readLoadCredentials(config)).toThrow(/group or other users/);
      chmodSync(credentialFile, 0o600);
      expect(() => readLoadCredentials({ ...config, clients: 41 })).toThrow(/capacity/);

      writeFileSync(credentialFile, JSON.stringify([
        { username: 'load-1', password: 'secret', orderId: 10 },
        { username: 'LOAD-1', password: 'other-secret', orderId: 11 },
      ]));
      expect(() => readLoadCredentials(config)).toThrow(/distinct usernames/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts heartbeat comment lines split across transport chunks', () => {
    const first = consumeSseCommentChunk('', ': keep');
    expect(first).toEqual({ remainder: ': keep', heartbeats: 0 });
    const second = consumeSseCommentChunk(first.remainder, '-alive\r\n\n: next\n');
    expect(second).toEqual({ remainder: '', heartbeats: 2 });
  });

  it('parses split heartbeat and invalidation SSE frames', () => {
    const first = consumeSseLoadChunk('', ': keep-alive\n\nevent: order.invalidate\nid: cursor-1\nda');
    expect(first).toMatchObject({ heartbeats: 1, invalidations: [], invalidFrames: 0 });
    const second = consumeSseLoadChunk(
      first.remainder,
      'ta: {"orderId":11569,"cursor":"cursor-1","domains":["detail_status"]}\n\n',
    );
    expect(second).toEqual({
      remainder: '',
      heartbeats: 0,
      invalidFrames: 0,
      invalidations: [{
        id: 'cursor-1',
        data: { orderId: 11569, cursor: 'cursor-1', domains: ['detail_status'] },
      }],
    });
    const malformed = consumeSseLoadChunk('', 'event: order.invalidate\nid: cursor-2\ndata: {nope}\n\n');
    expect(malformed).toMatchObject({ invalidations: [], invalidFrames: 1 });
  });
});

describe('Order SSE guarded shared-stage load safety', () => {
  const validStageConfig = () => parseOrderSseLoadArgs([
    '--target-env', 'shared-stage',
    '--backend-url', 'https://backend-test.mebelkz.app/api/v1',
    '--log-root', '/evidence',
    '--connections-per-user', '3',
    '--reconnect-rounds', '2',
    '--round-seconds', '180',
    '--expected-stage-sha', 'a'.repeat(40),
    '--expected-backend-sha', 'b'.repeat(40),
    '--run-id', '20260822t180000z-stage-load',
    '--order-id', '11569',
  ]);
  const sharedRunner = { hostname: 'vps-01fca05c', sharedMarkerPresent: true };
  const approval = { ORDER_SSE_LOAD_APPROVE_SHARED_STAGE: 'true' };

  it('accepts only the exact shared runner, stage target and bounded gate shape', () => {
    expect(() => assertSharedStageLoadAllowed(validStageConfig(), approval, sharedRunner)).not.toThrow();
    expect(() => assertSharedStageLoadAllowed(validStageConfig(), {}, sharedRunner)).toThrow(/APPROVE_SHARED_STAGE/);
    expect(() => assertSharedStageLoadAllowed(
      validStageConfig(),
      approval,
      { hostname: 'other-runner', sharedMarkerPresent: false },
    )).toThrow(/guarded ERP shared host/);
    expect(() => assertSharedStageLoadAllowed(
      { ...validStageConfig(), backendUrl: 'https://backend-ovh.mebelkz.app/api/v1' },
      approval,
      sharedRunner,
    )).toThrow(/backend-test/);
    expect(() => assertSharedStageLoadAllowed(
      { ...validStageConfig(), clients: 199 },
      approval,
      sharedRunner,
    )).toThrow(/exactly 200/);
    expect(() => assertSharedStageLoadAllowed(
      { ...validStageConfig(), connectionsPerUser: 4 },
      approval,
      sharedRunner,
    )).toThrow(/exactly 3 connections/);
    expect(() => assertSharedStageLoadAllowed(
      { ...validStageConfig(), rampClients: [50, 100, 200] },
      approval,
      sharedRunner,
    )).toThrow(/ramp must be/);
  });

  it('requires shared DNS and allows exact-run fixture cleanup only on this host', async () => {
    await expect(assertSharedStageTargetResolution(
      validStageConfig(),
      async () => [{ address: '::ffff:135.125.181.241', family: 6 }],
    )).resolves.toBeUndefined();
    await expect(assertSharedStageTargetResolution(
      validStageConfig(),
      async () => [{ address: '192.0.2.25', family: 4 }],
    )).rejects.toThrow(/outside the ERP shared host/);

    const cleanup = parseOrderSseLoadArgs([
      '--target-env', 'shared-stage',
      '--cleanup-run-id', '20260822t180000z-stage-load',
    ]);
    expect(() => assertSharedStageCleanupAllowed(cleanup, approval, sharedRunner)).not.toThrow();
    expect(() => assertSharedStageCleanupAllowed(cleanup, approval, {
      hostname: 'other-runner',
      sharedMarkerPresent: false,
    })).toThrow(/ERP shared host/);
  });

  it('parses four-core samples and fails closed on CPU3 or three saturated cores', () => {
    const previous = parseProcStatCpuSnapshot([
      'cpu 0 0 0 0 0 0 0 0 0 0',
      'cpu0 100 0 100 800 0 0 0 0 0 0',
      'cpu1 100 0 100 800 0 0 0 0 0 0',
      'cpu2 100 0 100 800 0 0 0 0 0 0',
      'cpu3 100 0 100 800 0 0 0 0 0 0',
    ].join('\n'));
    const safeCurrent = parseProcStatCpuSnapshot([
      'cpu 0 0 0 0 0 0 0 0 0 0',
      'cpu0 190 0 100 810 0 0 0 0 0 0',
      'cpu1 180 0 100 820 0 0 0 0 0 0',
      'cpu2 130 0 100 870 0 0 0 0 0 0',
      'cpu3 110 0 100 890 0 0 0 0 0 0',
    ].join('\n'));
    const safeBusy = calculateCpuBusyPercent(previous, safeCurrent);
    expect(safeBusy).toEqual([90, 80, 30, 10]);
    expect(evaluateSharedStageCpuSafety(safeBusy)).toMatchObject({ safe: true });
    expect(evaluateSharedStageCpuSafety([90, 90, 90, 10])).toMatchObject({
      safe: false,
      reason: 'three_or_more_cpus_saturated',
    });
    expect(evaluateSharedStageCpuSafety([20, 20, 20, 51])).toMatchObject({
      safe: false,
      reason: 'reserved_cpu_busy',
    });
    expect(() => parseProcStatCpuSnapshot('cpu0 1 2 3 4 5')).toThrow(/exactly four/);
  });
});
