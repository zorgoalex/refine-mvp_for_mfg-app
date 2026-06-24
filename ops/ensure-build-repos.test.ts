import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

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
});
