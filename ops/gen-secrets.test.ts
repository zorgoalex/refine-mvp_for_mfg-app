import { describe, expect, it, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const repoRoot = resolve(__dirname, '..');
const script = resolve(repoRoot, 'ops/gen-secrets.sh');
const template = resolve(repoRoot, 'ops/templates/env.vps.example');

function run(envFile: string) {
  return execFileSync('bash', [script, '--env-file', envFile], { encoding: 'utf8' });
}

describe('gen-secrets.sh', () => {
  let dir: string;
  let envFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gensec-'));
    envFile = join(dir, '.env');
    copyFileSync(template, envFile);
  });

  it('replaces every cryptographic REPLACE_ME placeholder', () => {
    run(envFile);
    const out = readFileSync(envFile, 'utf8');
    for (const tok of [
      'REPLACE_ME_MAIN_DB_PASSWORD',
      'REPLACE_ME_HASURA_METADATA_DB_PASSWORD',
      'REPLACE_ME_HASURA_ADMIN_SECRET',
      'REPLACE_ME_SHARED_JWT_SECRET_AT_LEAST_32_CHARS',
      'REPLACE_ME_REFRESH_TOKEN_PEPPER_AT_LEAST_32_CHARS',
      'REPLACE_ME_CAD_TOKEN_openssl_rand_hex_32',
    ]) {
      expect(out).not.toContain(tok);
    }
  });

  it('keeps the PG password in sync between PG_PASSWORD and the Hasura DATABASE_URL', () => {
    run(envFile);
    const out = readFileSync(envFile, 'utf8');
    const pg = out.match(/^PG_PASSWORD=(.+)$/m)![1];
    expect(out).toContain(`postgres://erp_user:${pg}@postgresdb:5432/erpdb`);
  });

  it('leaves external integration credentials for the operator', () => {
    run(envFile);
    const out = readFileSync(envFile, 'utf8');
    expect(out).toContain('BITRIX24_WEBHOOK_URL=');
    expect(out).toContain('BITRIX24_PAY_SYSTEM_ID=');
  });

  it('is idempotent: a second run does not change already-filled secrets', () => {
    run(envFile);
    const first = readFileSync(envFile, 'utf8');
    run(envFile);
    const second = readFileSync(envFile, 'utf8');
    expect(second).toBe(first);
  });

  it('doubles $ in the generated CAD basic-auth hash for compose', () => {
    run(envFile);
    const out = readFileSync(envFile, 'utf8');
    const line = out.match(/^CAD_BASICAUTH_USERS=(.+)$/m)![1];
    expect(line).toMatch(/^cad:\$\$apr1\$\$/);
    expect(line).not.toContain('REPLACE');
  });
});
