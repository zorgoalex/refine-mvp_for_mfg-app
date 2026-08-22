import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import loadLib from './order-sse-load-lib.js';

const {
  assertIsolatedLoadAllowed,
  assertIsolatedTargetResolution,
  consumeSseCommentChunk,
  parseOrderSseLoadArgs,
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
});
