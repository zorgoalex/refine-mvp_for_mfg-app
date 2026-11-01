import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const listSource = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/list.tsx'), 'utf8');
const dataProviderSource = readFileSync(resolve(process.cwd(), 'src/utils/dataProvider.ts'), 'utf8');
const hasuraMetadata = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/metadata.json'), 'utf8'));

describe('doweling orders list active filter', () => {
  it('shows active state as a list column', () => {
    expect(listSource).toContain('dataIndex="delete_flag"');
    expect(listSource).toContain('title="Активен"');
    expect(listSource).toContain('text={active ? "Активен" : "Неактивен"}');
  });

  it('defaults to active doweling orders and can include inactive rows (the «Показывать неактивные» of the filter bar)', () => {
    const filters = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/dowelingListFilters.ts'), 'utf8');
    expect(listSource).toContain('<ReferenceFilterBar');
    expect(listSource).toContain('applyDowelingFilters(allRows, filters)');
    expect(filters).toContain('activeField: true');
    expect(filters).toContain("(showInactive || row.delete_flag !== true)");
  });

  it('keeps delete_flag selectable and filterable on doweling_orders_view', () => {
    const viewFields = dataProviderSource.split('doweling_orders_view: [')[1]?.split('],')[0] ?? '';

    expect(viewFields).toContain('"delete_flag"');
  });

  it('allows every tracked UI role to read the active flag from Hasura', () => {
    const defaultSource = hasuraMetadata.sources.find((source: { name: string }) => source.name === 'default');
    const view = defaultSource.tables.find(
      (table: { table?: { name?: string } }) => table.table?.name === 'doweling_orders_view',
    );

    for (const permission of view.select_permissions) {
      expect(permission.permission.columns).toContain('delete_flag');
    }
  });
});
