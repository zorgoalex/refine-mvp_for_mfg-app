import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const metadata = JSON.parse(readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'));
const tables = metadata.sources[0].tables as Array<Record<string, any>>;

function packerSelectColumns(tableName: string): string[] | '*' {
  const table = tables.find((entry) => entry.table?.name === tableName);
  const permission = table?.select_permissions?.find((entry: any) => entry.role === 'packer');
  return permission?.permission?.columns ?? [];
}

describe('packer production status read permissions', () => {
  it('grants full read access required by the role-independent calendar', () => {
    expect(packerSelectColumns('production_statuses')).toBe('*');
    expect(packerSelectColumns('production_status_events')).toBe('*');
  });
});
