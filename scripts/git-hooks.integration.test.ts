import { chmodSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitGateFixture } from './git-gate-test-fixture.mjs';

const fixtures: ReturnType<typeof createGitGateFixture>[] = [];
function fixture() { const f = createGitGateFixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const output = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe.each(['pre-commit', 'pre-push'])('%s execution contract', (hook) => {
  function execute(f: ReturnType<typeof fixture>, env = {}) {
    expect(f.install().status).toBe(0);
    return hook === 'pre-commit' ? f.commit(env) : f.hook(hook, env);
  }
  const args = hook === 'pre-commit' ? 'run typecheck:ratchet'
    : 'run test:business-references -- --maxWorkers=1 --no-file-parallelism --exclude .claude/worktrees/**';

  it('defaults to required guard and forwards the original command', () => {
    const f = fixture(); const before = f.head(); const r = execute(f);
    expect(r.status, output(r)).toBe(0);
    expect(output(r)).toContain('GUARD_CALLED');
    expect(output(r)).toContain('CHECKER_CALLED ' + args);
    if (hook === 'pre-commit') expect(f.head()).not.toBe(before);
  });

  it.each(['missing guard', 'non-executable guard', 'empty guard', 'missing rtk', 'empty mode', 'unknown mode', 'Git config error'])(
    'blocks %s without launching npm', (reason) => {
      const f = fixture(); const before = f.head(); const env: Record<string, string> = {};
      if (reason === 'missing guard') env.RTK_HEAVY_GUARD = resolve(f.owner, 'missing');
      if (reason === 'non-executable guard') chmodSync(resolve(f.bin, 'guard'), 0o644);
      if (reason === 'empty guard') env.RTK_HEAVY_GUARD = '';
      if (reason === 'missing rtk') rmSync(resolve(f.bin, 'rtk'));
      if (reason === 'empty mode') f.git(['config', '--local', 'erp.hooksMode', '']);
      if (reason === 'unknown mode') f.git(['config', '--local', 'erp.hooksMode', 'requird']);
      if (reason === 'Git config error') f.binary('git', 'exit 128');
      const r = execute(f, env);
      expect(r.status, output(r)).not.toBe(0);
      expect(output(r)).not.toContain('CHECKER_CALLED');
      if (reason === 'Git config error') expect(output(r)).toContain('Cannot read erp.hooksMode');
      expect(f.head()).toBe(before);
    },
  );

  it('propagates guard rejection without fallback or a commit', () => {
    const f = fixture(); const before = f.head(); const r = execute(f, { GUARD_EXIT: '17' });
    expect(r.status).toBe(hook === 'pre-commit' ? 1 : 17);
    expect(output(r)).toContain('GUARD_CALLED');
    expect(output(r)).not.toContain('CHECKER_CALLED');
    expect(f.head()).toBe(before);
  });

  it.each(['required', 'portable'])('propagates checker rejection in %s mode', (mode) => {
    const f = fixture(); f.git(['config', '--local', 'erp.hooksMode', mode]);
    const before = f.head(); const r = execute(f, { CHECKER_EXIT: '23' });
    expect(r.status).toBe(hook === 'pre-commit' ? 1 : 23);
    expect(output(r)).toContain('CHECKER_CALLED ' + args);
    expect(f.head()).toBe(before);
  });

  it('allows direct npm only with explicit portable, preserving installer mode', () => {
    const f = fixture(); f.git(['config', '--local', 'erp.hooksMode', 'portable']);
    const r = execute(f, { GUARD_EXIT: '17' });
    expect(r.status, output(r)).toBe(0);
    expect(output(r)).not.toContain('GUARD_CALLED');
    expect(output(r)).toContain('CHECKER_CALLED ' + args);
    expect(f.git(['config', '--local', '--get', 'erp.hooksMode'])).toBe('portable');
  });
});

describe('real installation and TypeScript commit blocking', () => {
  it('preserves executable hooks through clone and installs in the new clone', () => {
    const f = fixture(); const clone = resolve(f.owner, 'fresh clone');
    const modes = f.git(['ls-files', '--stage', '.githooks/pre-commit', '.githooks/pre-push']);
    expect(modes.split('\n')).toHaveLength(2);
    expect(modes.split('\n').every(line => line.startsWith('100755 '))).toBe(true);
    f.git(['clone', '--quiet', f.cwd, clone]);
    expect(f.run(f.gitBinary, ['config', '--local', '--get', 'core.hooksPath'], { cwd: clone }).status).toBe(1);
    expect(f.install(clone).status).toBe(0);
    expect(f.git(['config', '--local', '--get', 'core.hooksPath'], { cwd: clone })).toBe('.githooks');
    for (const hook of ['pre-commit', 'pre-push']) expect(statSync(resolve(clone, '.githooks', hook)).mode & 0o111).not.toBe(0);
    const before = f.git(['rev-parse', 'HEAD'], { cwd: clone });
    const r = f.run(f.gitBinary, ['commit', '--allow-empty', '-qm', 'Тест blocked clone'], {
      cwd: clone, env: { ...f.hookEnv, CHECKER_EXIT: '23' },
    });
    expect(r.status).toBe(1);
    expect(output(r)).toContain('CHECKER_CALLED');
    expect(f.git(['rev-parse', 'HEAD'], { cwd: clone })).toBe(before);
  });

  it.each(['pre-commit', 'pre-push'])('refuses installation when %s is not executable', (hook) => {
    const f = fixture(); chmodSync(resolve(f.cwd, '.githooks', hook), 0o644);
    expect(f.install().status).not.toBe(0);
    expect(f.run(f.gitBinary, ['config', '--local', '--get', 'core.hooksPath']).status).toBe(1);
  });

  it('real TypeScript diagnostic blocks Git commit; fixing it permits commit', () => {
    const f = fixture(); expect(f.install().status).toBe(0);
    const before = f.head();
    f.write('probe.ts', 'const value: number = "Тест";\n');
    f.git(['add', 'probe.ts']);
    const bad = f.commit({ REAL_CHECKER: '1' });
    expect(bad.status, output(bad)).toBe(1);
    expect(output(bad)).toContain('TS2322');
    expect(output(bad)).toContain('New TypeScript diagnostics');
    expect(f.head()).toBe(before);
    f.write('probe.ts', 'const value: number = 2;\n');
    f.git(['add', 'probe.ts']);
    const good = f.commit({ REAL_CHECKER: '1' });
    expect(good.status, output(good)).toBe(0);
    expect(f.head()).not.toBe(before);
  }, 30_000);

  it('normal ratchet also validates baseline counts and always rejects critical diagnostics', () => {
    const f = fixture(); expect(f.install().status).toBe(0); const before = f.head();
    f.write('scripts/typecheck-baseline.json', JSON.stringify({ 'probe.ts|TS2322|message': 'bad' }));
    f.git(['add', 'scripts/typecheck-baseline.json']);
    const invalid = f.commit({ REAL_CHECKER: '1' });
    expect(invalid.status).toBe(1);
    expect(output(invalid)).toContain('positive safe integers');
    f.write('probe.ts', 'const value = doesNotExist;\n');
    f.write('scripts/typecheck-baseline.json', JSON.stringify({ "probe.ts|TS2304|Cannot find name 'doesNotExist'.": 1 }));
    f.git(['add', 'probe.ts', 'scripts/typecheck-baseline.json']);
    const critical = f.commit({ REAL_CHECKER: '1' });
    expect(critical.status).toBe(1);
    expect(output(critical)).toContain('blocked critical diagnostics');
    expect(output(critical)).toContain('TS2304');
    expect(f.head()).toBe(before);
  }, 30_000);
});
