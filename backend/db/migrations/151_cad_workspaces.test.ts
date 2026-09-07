import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
it('classifies CAD migration and verifies its end state before recording the ledger', () => {
  expect(runner).toContain('151_cad_workspaces*) probe_all');
  expect(runner).toContain('151_*)');
  for (const column of ['cad_commands access_order_ids', 'cad_runs package_actor', 'cad_runs package_request_id', 'cad_events audit_id']) expect(runner).toContain(column);
  for (const trigger of ['cad_sources_immutable', 'cad_revisions_immutable', 'cad_original_immutable']) expect(runner).toContain(trigger);
});
