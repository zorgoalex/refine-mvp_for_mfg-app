import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, 'ensure-build-repos.sh');

describe('ensure-build-repos.sh', () => {
  it('--dry-run reports both target repos and clones nothing', () => {
    const out = execFileSync('bash', [script, '--dry-run'], { encoding: 'utf8' });
    expect(out).toContain('repo_freecut');
    expect(out).toContain('repo_svgdxf');
    expect(out).toMatch(/dry-run/i);
  });

  it('rejects an unknown option', () => {
    expect(() => execFileSync('bash', [script, '--bogus'], { encoding: 'utf8' })).toThrow();
  });

  it('--dry-run against an empty root reports clones and creates nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebr-'));
    const out = execFileSync('bash', [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root },
    });
    expect(out).toMatch(/would clone.*repo_freecut/);
    expect(out).toMatch(/would clone.*repo_svgdxf/);
    expect(existsSync(join(root, 'repo_freecut'))).toBe(false);
    expect(existsSync(join(root, 'repo_svgdxf'))).toBe(false);
  });

  it('fails when a target path exists but is not a git checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebr-'));
    mkdirSync(join(root, 'repo_freecut'));
    expect(() =>
      execFileSync('bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root },
      }),
    ).toThrow();
  });
});
