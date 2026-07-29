import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/orders/list.tsx'), 'utf8');

describe('orders list Basis-project column wiring', () => {
  it('renames the column and resolves its fallback from detail Basis projects', () => {
    expect(source).toContain("{ key: 'doweling_order_name', label: 'Базис-проект' }");
    expect(source).toContain('title: "Базис-проект"');
    expect(source).toContain('resolveOrderListBasisProjectValues({');
    expect(source).toContain('basisProjects: record.basis_projects');
    expect(source).toContain('details: detailsByOrderId[record.order_id]');
  });
});
