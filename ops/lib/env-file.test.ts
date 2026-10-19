import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const libPath = new URL('./env-file.sh', import.meta.url).pathname;
const dirs: string[] = [];

function envFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'env-file-'));
  dirs.push(dir);
  const file = join(dir, '.env');
  writeFileSync(file, lines.join('\n'));
  return file;
}

// Loads the file under `set -euo pipefail` and prints KEY=[value] per requested key.
function load(file: string, keys: string[], inherited: Record<string, string> = {}) {
  const script = `set -euo pipefail\nsource "$1"\nload_env_file "$2"\nshift 2\nfor k in "$@"; do printf '%s=[%s]\\n' "$k" "\${!k-<unset>}"; done\n`;
  return spawnSync('bash', ['-c', script, 'bash', libPath, file, ...keys], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...inherited },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ops/lib/env-file.sh load_env_file', () => {
  it('reads values literally: `$` in an unrelated secret does not abort under set -u', () => {
    const file = envFile([
      '# comment',
      '',
      'ONEC_PROD_PASSWORD=ab$tcd',
      'CAD_BASICAUTH_USERS=admin:$apr1$x$y',
      'CMD=$(touch /tmp/should-not-run)',
      'PG_DB=old_db',
      "PG_DB='erp$db'",
      'export PG_USER="erp_user"\r',
      'PG_PASSWORD=p@ss$word  # inline comment',
      'PG_DB_EXTRA=other',
      'SPACED = value',
      'EMPTY=',
      'EMPTY_COMMENTED= # use default',
      'HASH_LITERAL=#literal',
    ]);
    const res = load(file, [
      'ONEC_PROD_PASSWORD', 'CAD_BASICAUTH_USERS', 'CMD', 'PG_DB', 'PG_USER', 'PG_PASSWORD',
      'PG_DB_EXTRA', 'SPACED', 'EMPTY', 'EMPTY_COMMENTED', 'HASH_LITERAL', 'MISSING',
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      [
        'ONEC_PROD_PASSWORD=[ab$tcd]',
        'CAD_BASICAUTH_USERS=[admin:$apr1$x$y]',
        'CMD=[$(touch /tmp/should-not-run)]',
        'PG_DB=[erp$db]',
        'PG_USER=[erp_user]',
        'PG_PASSWORD=[p@ss$word]',
        'PG_DB_EXTRA=[other]',
        'SPACED=[value]',
        'EMPTY=[]',
        'EMPTY_COMMENTED=[]',
        'HASH_LITERAL=[#literal]',
        'MISSING=[<unset>]',
        '',
      ].join('\n'),
    );
  });

  it('strips a comment after either kind of quote and keeps `#` inside quotes', () => {
    const file = envFile([
      "PG_USER='erp_user' # restore role",
      'PG_DB="erpdb"   # main db',
      "HASH='a #b'",
      'ESC="say \\"hi\\" \\\\ ok"',
    ]);
    const res = load(file, ['PG_USER', 'PG_DB', 'HASH', 'ESC']);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      ['PG_USER=[erp_user]', 'PG_DB=[erpdb]', 'HASH=[a #b]', 'ESC=[say "hi" \\ ok]', ''].join('\n'),
    );
  });

  it('rejects a malformed line without exporting anything or printing the value', () => {
    for (const bad of ["PG_PASSWORD='secret-value", 'PG_PASSWORD="secret-value', "PG_PASSWORD='a'b'", 'not a kv line secret-value']) {
      const file = envFile(['PG_DB=erpdb', bad]);
      const res = spawnSync(
        'bash',
        ['-c', 'set -euo pipefail\nsource "$1"\nif load_env_file "$2"; then echo loaded; fi\necho "PG_DB=[${PG_DB-<unset>}]"', 'bash', libPath, file],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
      );
      expect(res.stdout).toBe('PG_DB=[<unset>]\n');
      expect(res.stderr).toContain('malformed line 2');
      expect(res.stderr).not.toContain('secret-value');
    }
  });

  it('a missing or unreadable file fails through `|| fail` instead of falling back to inherited values', () => {
    const readable = envFile(['HASURA_FQDN=stage.example']);
    const unreadable = envFile(['HASURA_FQDN=stage.example']);
    chmodSync(unreadable, 0o000);
    const cases = [join(tmpdir(), 'env-file-does-not-exist', '.env'), dirs[dirs.length - 1]];
    if (process.getuid?.() !== 0) cases.push(unreadable);
    for (const target of cases) {
      const res = spawnSync(
        'bash',
        [
          '-c',
          'set -euo pipefail\nfail() { echo "FAIL: $*"; exit 1; }\nsource "$1"\nload_env_file "$2" || fail "Cannot parse env file"\necho "CONTINUED with $HASURA_FQDN"',
          'bash', libPath, target,
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HASURA_FQDN: 'prod.example' } },
      );
      expect(res.status, target).toBe(1);
      expect(res.stdout, target).toBe('FAIL: Cannot parse env file\n');
      expect(res.stderr, target).toContain('not a readable file');
    }
    expect(load(readable, ['HASURA_FQDN'], { HASURA_FQDN: 'prod.example' }).stdout).toBe('HASURA_FQDN=[stage.example]\n');
  });

  it('file values override inherited ones (COMPOSE_PROJECT_NAME must not leak from the caller)', () => {
    const file = envFile(['COMPOSE_PROJECT_NAME=erp_test']);
    const res = load(file, ['COMPOSE_PROJECT_NAME'], { COMPOSE_PROJECT_NAME: 'erp_prod' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('COMPOSE_PROJECT_NAME=[erp_test]\n');
    // Exported to child processes such as docker compose.
    const child = execFileSync(
      'bash',
      ['-c', 'set -euo pipefail\nsource "$1"\nload_env_file "$2"\nbash -c \'printf %s "$COMPOSE_PROJECT_NAME"\'', 'bash', libPath, file],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', COMPOSE_PROJECT_NAME: 'erp_prod' } },
    );
    expect(child).toBe('erp_test');
  });

  it('every ops script that reads .env uses the literal loader, never `source "$ENV_FILE"`', () => {
    for (const name of [
      'apply-hasura-metadata.sh',
      'backup-prod-packet.sh',
      'check-env.sh',
      'reset-test-vps.sh',
      'restore-prod-backup.sh',
      'run-vps-tests.sh',
      'setup-vps.sh',
      'smoke-vps.sh',
      'track-hasura-public-schema.sh',
    ]) {
      const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
      expect(text, name).not.toMatch(/^\s*(source|\.)\s+"\$\{?ENV_FILE\}?"/m);
      expect(text, name).toContain('/lib/env-file.sh"');
      expect(text, name).toContain('load_env_file "$ENV_FILE" || fail "Cannot parse env file: $ENV_FILE"');
    }
  });
});
