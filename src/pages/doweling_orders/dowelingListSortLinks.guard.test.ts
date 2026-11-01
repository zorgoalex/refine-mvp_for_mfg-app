import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const list = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/list.tsx'), 'utf8');
const show = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/show.tsx'), 'utf8');
const links = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/dowelingRecordLinks.tsx'), 'utf8');

describe('Bazis projects list: natural sort and clickable order / client', () => {
  it('loads the whole list and sorts it here, the Bazis project number naturally, newest first by default', () => {
    expect(list).toMatch(/sorters: \{\s*mode: "off",\s*\}/);
    expect(list).toMatch(/pagination: \{\s*mode: "client",/);
    expect(list).toContain('sorter={naturalSorter("doweling_order_name")}');
    expect(list).toMatch(/sorter=\{naturalSorter\("doweling_order_id"\)\}\s*defaultSortOrder="descend"/);
    expect(list).not.toMatch(/\n\s*sorter\n/);
  });

  it('the order and the client open their cards from the list and from the Bazis project card', () => {
    for (const source of [list, show]) {
      expect(source).toContain('<DowelingOrderLink');
      expect(source).toContain('<DowelingClientLink');
    }
    expect(links).toContain('`/orders/show/${orderId}`');
    expect(links).toContain('`/clients/show/${clientId}`');
    expect(links).toContain("canRead('orders.view')");
    expect(links).toContain("canRead('clients.view')");
    expect(links).toContain('useOpenWithOrigin(fromLabel)');
    expect(links).toContain('onDoubleClick={(event) => event.stopPropagation()}');
  });
});
