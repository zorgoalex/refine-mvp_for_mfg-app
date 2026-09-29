import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const metadata = JSON.parse(readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'));
const tables = metadata.sources[0].tables as Array<Record<string, any>>;

// «Переделка» (migration 211): stage events are written only by the backend
// (production rounds, DB command boundary). Hasura keeps read access only.
describe('production_status_events is backend-owned in Hasura', () => {
  const table = tables.find((entry) => entry.table?.name === 'production_status_events');

  it('grants no insert/update/delete to any role', () => {
    expect(table).toBeDefined();
    expect(table?.insert_permissions ?? []).toEqual([]);
    expect(table?.update_permissions ?? []).toEqual([]);
    expect(table?.delete_permissions ?? []).toEqual([]);
  });

  it('keeps read access for the calendar roles', () => {
    const roles = (table?.select_permissions ?? []).map((entry: any) => entry.role).sort();
    expect(roles).toEqual(['manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker']);
  });
});
