import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(__dirname, 'verify-freecut-compose-context.sh');

function verify(json: unknown, expected: string): void {
  execFileSync('bash', [script, expected], { input: JSON.stringify(json), encoding: 'utf8' });
}

describe('verify-freecut-compose-context.sh', () => {
  it('accepts only services.freecut.build.context matching the verified checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'freecut-context-'));
    const expected = join(root, 'repo_freecut');
    mkdirSync(expected);
    expect(() => verify({ services: { freecut: { build: { context: expected } } } }, expected)).not.toThrow();
  });

  it('rejects when another service uses the verified path but Freecut uses a stale path', () => {
    const root = mkdtempSync(join(tmpdir(), 'freecut-context-'));
    const expected = join(root, 'repo_freecut');
    const stale = join(root, 'stale-freecut');
    mkdirSync(expected);
    mkdirSync(stale);
    expect(() => verify({ services: {
      backend: { build: { context: expected } },
      freecut: { build: { context: stale } },
    } }, expected)).toThrow();
  });
});
