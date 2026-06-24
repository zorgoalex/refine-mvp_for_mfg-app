import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, 'up-all.sh');
function run(args: string[]) {
  return execFileSync('bash', [script, ...args], { encoding: 'utf8' });
}

describe('up-all.sh provision', () => {
  it('--dry-run prints the ordered plan and runs nothing destructive', () => {
    const out = run(['provision', '--dry-run']);
    expect(out).toMatch(/ensure-build-repos/);
    expect(out).toMatch(/check-env/);
    expect(out).toMatch(/server-storage/);
    expect(out).toMatch(/compose up/);
    expect(out).toMatch(/apply-migrations/);
    expect(out).toMatch(/smoke/);
    expect(out).toMatch(/dry-run/i);
  });

  it('defaults migrate to skip and hasura to the bundled baseline', () => {
    const out = run(['provision', '--dry-run']);
    expect(out).toMatch(/migrate:\s*skip/i);
    expect(out).toMatch(/hasura:\s*bundled/i);
  });

  it('still refuses a bare down on the merged stack', () => {
    expect(() => run(['down'])).toThrow();
  });

  it('rejects an unknown provision flag', () => {
    expect(() => run(['provision', '--bogus', '--dry-run'])).toThrow();
  });
});
