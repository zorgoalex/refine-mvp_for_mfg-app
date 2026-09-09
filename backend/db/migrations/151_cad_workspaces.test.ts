import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
it('classifies CAD migration and verifies its end state before recording the ledger', () => {
  expect(runner).toContain('151_cad_workspaces*) probe_all');
  expectMigrationEffectGate(runner, '151_cad_workspaces.sql');
  for (const column of ['cad_commands access_order_ids', 'cad_runs package_actor', 'cad_runs package_request_id', 'cad_events audit_id']) expect(runner).toContain(column);
  for (const trigger of ['cad_sources_immutable', 'cad_revisions_immutable', 'cad_original_immutable']) expect(runner).toContain(trigger);
});
