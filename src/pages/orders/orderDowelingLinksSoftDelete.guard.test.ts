import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ordersListSource = readFileSync(resolve(process.cwd(), 'src/pages/orders/list.tsx'), 'utf8');
const ordersShowSource = readFileSync(resolve(process.cwd(), 'src/pages/orders/show.tsx'), 'utf8');
const dataProviderSource = readFileSync(resolve(process.cwd(), 'src/utils/dataProvider.ts'), 'utf8');

describe('order doweling links soft-delete filters', () => {
  it('loads only active doweling links in orders list', () => {
    const query = ordersListSource.split('resource: "order_doweling_links"')[1]?.split('pagination')[0] ?? '';

    expect(query).toContain('field: "delete_flag"');
    expect(query).toContain('operator: "eq"');
    expect(query).toContain('value: false');
  });

  it('loads only active doweling links in order show fallback query', () => {
    const query = ordersShowSource.split("resource: 'order_doweling_links'")[1]?.split('pagination')[0] ?? '';

    expect(query).toContain("field: 'delete_flag'");
    expect(query).toContain("operator: 'eq'");
    expect(query).toContain('value: false');
  });

  it('loads only active doweling links in order getOne relationship', () => {
    expect(dataProviderSource).toContain('order_doweling_links(where: { delete_flag: { _eq: false } })');
  });
});
