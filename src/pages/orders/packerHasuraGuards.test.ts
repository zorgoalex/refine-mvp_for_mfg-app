import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const orderListSource = readFileSync('src/pages/orders/list.tsx', 'utf8');
const orderShowSource = readFileSync('src/pages/orders/show.tsx', 'utf8');
const orderShowHeaderSource = readFileSync(
  'src/pages/orders/components/sections/OrderShowHeader.tsx',
  'utf8',
);
const orderFinanceBlockSource = readFileSync(
  'src/pages/orders/components/sections/OrderFinanceBlock.tsx',
  'utf8',
);

describe('packer Hasura lookup guards', () => {
  it('does not load reference lookup tables unconditionally on the order list', () => {
    for (const resource of ['materials', 'milling_types', 'edge_types', 'films']) {
      expect(resourceBlock(orderListSource, resource)).toContain('canViewReferences');
    }
    expect(resourceBlock(orderListSource, 'production_statuses')).toContain(
      'canViewProductionReferences',
    );
    expect(resourceBlock(orderListSource, 'production_status_events')).toContain(
      'canViewProductionReferences',
    );
  });

  it('does not load protected order show lookups unconditionally', () => {
    for (const resource of ['materials', 'milling_types', 'edge_types', 'films']) {
      expect(resourceBlock(orderShowSource, resource)).toContain('canViewReferences');
    }
    expect(resourceBlock(orderShowSource, 'payment_types')).toContain('canViewFinancials');
    expect(resourceBlock(orderShowSource, 'client_phones')).toContain('canExportOrders');
    expect(resourceBlock(orderShowSource, 'employees')).toContain('canViewEmployees');
  });

  it('does not load protected order show header lookups unconditionally', () => {
    expect(resourceBlock(orderShowHeaderSource, 'employees')).toContain('canViewEmployees');
    expect(resourceBlock(orderShowHeaderSource, 'materials')).toContain('canViewReferences');
    expect(resourceBlock(orderShowHeaderSource, 'client_phones')).toContain('canViewClients');
    expect(resourceBlock(orderShowHeaderSource, 'production_statuses')).toContain(
      'canViewProductionReferences',
    );
    expect(resourceBlock(orderFinanceBlockSource, 'payment_types')).toContain(
      'canViewFinancials',
    );
  });
});

function resourceBlock(source: string, resource: string): string {
  const marker = `resource: '${resource}'`;
  const doubleQuoteMarker = `resource: "${resource}"`;
  const start = source.indexOf(marker) >= 0
    ? source.indexOf(marker)
    : source.indexOf(doubleQuoteMarker);
  expect(start, `${resource} block exists`).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + 450);
}
