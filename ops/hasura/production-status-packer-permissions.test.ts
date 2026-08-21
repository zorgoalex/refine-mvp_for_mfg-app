import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const metadata = JSON.parse(readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'));
const tables = metadata.sources[0].tables as Array<Record<string, any>>;

function packerSelectColumns(tableName: string): string[] {
  const table = tables.find((entry) => entry.table?.name === tableName);
  const permission = table?.select_permissions?.find((entry: any) => entry.role === 'packer');
  return permission?.permission?.columns ?? [];
}

describe('packer production status read permissions', () => {
  it('grants only columns needed by order header stage markers', () => {
    expect(packerSelectColumns('production_statuses')).toEqual([
      'production_status_id',
      'production_status_name',
      'production_status_code',
      'sort_order',
      'color',
      'is_active',
    ]);
    expect(packerSelectColumns('production_status_events')).toEqual([
      'event_id',
      'order_id',
      'production_status_id',
      'event_at',
    ]);
  });
});
