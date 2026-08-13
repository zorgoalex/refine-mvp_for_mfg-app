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

  it('defaults to active doweling orders and can include inactive rows', () => {
    expect(listSource).toContain('const [showInactive, setShowInactive] = useState(false)');
    expect(listSource).toContain('field: "delete_flag"');
    expect(listSource).toContain('operator: "in"');
    expect(listSource).toContain('value: showInactive ? [false, true] : [false]');
    expect(listSource).toContain('aria-label="Показывать неактивные"');
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
