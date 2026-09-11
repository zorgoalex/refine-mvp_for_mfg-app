import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createGitGateFixture } from './git-gate-test-fixture.mjs';

const fixtures = [];
function fixture() { const value = createGitGateFixture(); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
const key = 'src/probe.ts|TS2322|Type A | B\nis not assignable';
const baseline = (count) => JSON.stringify({ [key]: count });
const output = (result) => result.stdout + result.stderr;

describe('baseline policy real Git/CLI contract', () => {
  it('permits unchanged/removal and rejects growth, including messages with pipes/newlines', () => {
    const f = fixture();
    const ref = f.target(baseline(2));
    for (const count of [1, 2]) {
      f.write('scripts/typecheck-baseline.json', baseline(count));
      expect(f.policy(ref).status).toBe(0);
    }
    f.write('scripts/typecheck-baseline.json', baseline(3));
    expect(f.policy(ref).status).toBe(1);
    f.write('scripts/typecheck-baseline.json', '{}');
    expect(f.policy(ref).status).toBe(0);
  });

  it.each(['unknown-gate-ref', '0000000000000000000000000000000000000000', '--help'])('rejects invalid ref %s even with bootstrap enabled', (ref) => {
    const r = fixture().policy(ref, ['--allow-initial-baseline']);
    expect(r.status).not.toBe(0);
    expect(output(r)).not.toContain('allowing initial baseline');
  });

  it('rejects a blob ref rather than treating it as an initial commit', () => {
    const f = fixture();
    const blob = f.git(['hash-object', '-w', '--stdin'], { input: '{}' });
    expect(f.policy(blob, ['--allow-initial-baseline']).status).not.toBe(0);
  });

  it('requires explicit bootstrap for a valid commit with no baseline', () => {
    const f = fixture(); const ref = f.target(undefined);
    expect(f.policy(ref).status).not.toBe(0);
    expect(f.policy(ref, ['--allow-initial-baseline']).status).toBe(0);
  });

  it.each(['{', 'null', '[]', '1', '"text"', baseline('1'), baseline('not-a-number'), baseline(0), baseline(-1), baseline(1.5), baseline(Number.MAX_SAFE_INTEGER + 1), '{"bad key":1}'])('rejects malformed target %s despite bootstrap', (json) => {
    const f = fixture();
    expect(f.policy(f.target(json), ['--allow-initial-baseline']).status).not.toBe(0);
  });

  it.each(['{', 'null', '[]', baseline('bad'), baseline(0), baseline(-1), baseline(1.5), '{"bad key":1}'])('validates candidate even on initial bootstrap: %s', (json) => {
    const f = fixture(); f.write('scripts/typecheck-baseline.json', json);
    expect(f.policy(f.target(undefined), ['--allow-initial-baseline']).status).not.toBe(0);
  });

  it('rejects missing/unreadable candidate even on initial bootstrap', () => {
    const f = fixture(); const ref = f.target(undefined);
    const file = path.join(f.cwd, 'scripts/typecheck-baseline.json');
    rmSync(file);
    expect(f.policy(ref, ['--allow-initial-baseline']).status).not.toBe(0);
    mkdirSync(file); // EISDIR remains deterministic even when runner is root.
    expect(f.policy(ref, ['--allow-initial-baseline']).status).not.toBe(0);
  });

  it('rejects symlink target entries even when their blob contains valid JSON', () => {
    const f = fixture();
    expect(f.policy(f.target('{}', '120000'), ['--allow-initial-baseline']).status).not.toBe(0);
  });

  it('rejects a directory target and unsafe aggregate counts', () => {
    const f = fixture();
    const empty = f.git(['mktree'], { input: '' });
    const scripts = f.git(['mktree'], { input: `040000 tree ${empty}\ttypecheck-baseline.json\n` });
    const root = f.git(['mktree'], { input: `040000 tree ${scripts}\tscripts\n` });
    const ref = f.git(['commit-tree', root, '-m', 'Тест baseline directory']);
    expect(f.policy(ref, ['--allow-initial-baseline']).status).not.toBe(0);
    const counts = JSON.stringify({ [key]: Number.MAX_SAFE_INTEGER, 'src/other.ts|TS2322|message': 1 });
    expect(f.policy(f.target(counts)).status).not.toBe(0);
    f.write('scripts/typecheck-baseline.json', counts);
    expect(f.policy(f.target('{}')).status).not.toBe(0);
  });

  it.each(['missing', 'ref', 'tree', 'blob'])('fails closed on Git %s errors', (phase) => {
    const f = fixture(); const ref = f.target('{}');
    if (phase === 'missing') rmSync(path.join(f.bin, 'git'));
    else f.binary('git', `case "$1" in ${phase === 'ref' ? 'rev-parse' : phase === 'tree' ? 'ls-tree' : 'show'}) exit 128;; esac\nexec "${f.gitBinary}" "$@"`);
    expect(f.policy(ref, ['--allow-initial-baseline'], { env: { ...f.env, PATH: f.bin } }).status).not.toBe(0);
  });
});
