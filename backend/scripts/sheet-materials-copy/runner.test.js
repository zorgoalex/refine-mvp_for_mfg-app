import { describe, it, expect } from 'vitest';
import runner from './runner.js';
const { parseSheetCopyArgs, resolveSheetCopyConfig, assertSheetCopyAllowed } = runner;
const DEV_URL = 'postgres://postgres:dev@localhost:55432/postgres';

describe('parseSheetCopyArgs', () => {
  it('parses flags incl allowed-db-hosts, run-id, expected-db-name, actor', () => {
    expect(parseSheetCopyArgs([
      '--mode', 'write', '--database-url', DEV_URL, '--target-env', 'backend-test',
      '--material-types', '1,2', '--approve-write', '--manifest-out', '/tmp/m.json',
      '--allowed-db-hosts', 'localhost,postgresdb', '--run-id', 'r-1',
      '--expected-db-name', 'erpdb', '--actor', 'ops-alex',
    ])).toEqual({
      mode: 'write', databaseUrl: DEV_URL, targetEnv: 'backend-test',
      materialTypeAllowlist: [1, 2], approveWrite: true, manifestOut: '/tmp/m.json',
      allowedDbHosts: ['localhost', 'postgresdb'], runIdArg: 'r-1', expectedDbName: 'erpdb', actor: 'ops-alex',
    });
  });
  it('defaults mode=dry-run, material-types=[1,2], allowedDbHosts=[], expectedDbName=null, actor=null', () => {
    const p = parseSheetCopyArgs(['--database-url', DEV_URL, '--target-env', 'backend-test']);
    expect(p.mode).toBe('dry-run'); expect(p.materialTypeAllowlist).toEqual([1, 2]);
    expect(p.allowedDbHosts).toEqual([]); expect(p.expectedDbName).toBeNull(); expect(p.actor).toBeNull();
  });
  it('throws on unknown arg', () => { expect(() => parseSheetCopyArgs(['--nope'])).toThrow(/Unknown argument/); });
});

describe('resolveSheetCopyConfig', () => {
  it('merges env url/target/approve/expected-db/actor and adds default local hosts to the allowlist', () => {
    const cfg = resolveSheetCopyConfig(parseSheetCopyArgs(['--mode', 'write']), {
      SHEET_MATERIALS_COPY_DATABASE_URL: DEV_URL, SHEET_MATERIALS_COPY_TARGET_ENV: 'backend-test',
      SHEET_MATERIALS_COPY_APPROVE_WRITE: 'true', SHEET_MATERIALS_COPY_ALLOWED_DB_HOSTS: 'postgresdb',
      SHEET_MATERIALS_COPY_EXPECTED_DB_NAME: 'erpdb', SHEET_MATERIALS_COPY_ACTOR: 'ops-bot',
    });
    expect(cfg).toMatchObject({ databaseUrl: DEV_URL, targetEnv: 'backend-test', approveWrite: true, expectedDbName: 'erpdb', actor: 'ops-bot' });
    expect(cfg.allowedDbHosts).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1', 'postgresdb']));
  });
});

describe('assertSheetCopyAllowed (fail-closed)', () => {
  const ok = {
    mode: 'write', databaseUrl: DEV_URL, targetEnv: 'backend-test', approveWrite: true,
    materialTypeAllowlist: [1, 2], allowedDbHosts: ['localhost', '127.0.0.1', '::1'],
    manifestOut: '/tmp/m.json', runIdArg: null, expectedDbName: 'postgres', actor: 'tester',
  };
  it('allows a correct write config to a permitted host', () => { expect(() => assertSheetCopyAllowed(ok)).not.toThrow(); });
  it('write mode requires expected-db-name', () => { expect(() => assertSheetCopyAllowed({ ...ok, expectedDbName: '' })).toThrow(/expected-db-name/); });
  it('refuses a host not in the allowlist (e.g. staging-db)', () => {
    expect(() => assertSheetCopyAllowed({ ...ok, databaseUrl: 'postgres://u:p@staging-db:5432/erp' })).toThrow(/allow|host/i);
  });
  it('refuses a prod/production/live host even if allowlisted', () => {
    expect(() => assertSheetCopyAllowed({ ...ok, allowedDbHosts: ['db-production.mebelkz.app'], databaseUrl: 'postgres://u:p@db-production.mebelkz.app:5432/erp' }))
      .toThrow(/prod|production|live/i);
  });
  it('requires target-env backend-test', () => { expect(() => assertSheetCopyAllowed({ ...ok, targetEnv: '' })).toThrow(/backend-test/); });
  it('write mode requires approve-write', () => { expect(() => assertSheetCopyAllowed({ ...ok, approveWrite: false })).toThrow(/approve-write/); });
  it('write mode requires manifest-out', () => { expect(() => assertSheetCopyAllowed({ ...ok, manifestOut: null })).toThrow(/manifest-out/); });
  it('requires a non-empty material-type allowlist', () => { expect(() => assertSheetCopyAllowed({ ...ok, materialTypeAllowlist: [] })).toThrow(/material-types/); });
  it('dry-run allows missing approve-write/manifest-out but still enforces host allowlist', () => {
    expect(() => assertSheetCopyAllowed({ ...ok, mode: 'dry-run', approveWrite: false, manifestOut: null })).not.toThrow();
    expect(() => assertSheetCopyAllowed({ ...ok, mode: 'dry-run', databaseUrl: 'postgres://u:p@staging-db:5432/erp' })).toThrow(/allow|host/i);
  });
});
