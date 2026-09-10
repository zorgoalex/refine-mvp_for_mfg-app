import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

// Execute only the effect gate, never the runner's environment/DB entrypoint.
// A suffix-text assertion breaks whenever a new case alternative is appended.
export function expectMigrationEffectGate(runner: string, migration: string): void {
  const effectGate = /^verify_applied_effect\(\) \{\n[\s\S]*?^\}/m.exec(runner)?.[0];
  expect(effectGate, 'Migration runner must define its effect gate').toBeDefined();

  for (const probeStatus of [0, 1]) {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-s', '--', migration, String(probeStatus)], {
      input: `set -eu
probe_status="$2"
probe_file() { printf '%s\\n' "$1"; return "$probe_status"; }
die() { printf '%s\\n' "$*" >&2; exit 42; }
${effectGate}
verify_applied_effect "$1"
`,
      // Do not allow a caller's BASH_ENV to source external code.
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).toBe(migration);
    expect(result.status, result.stderr).toBe(probeStatus === 0 ? 0 : 42);
    if (probeStatus === 1) expect(result.stderr).toContain('schema_migrations');
  }
}
