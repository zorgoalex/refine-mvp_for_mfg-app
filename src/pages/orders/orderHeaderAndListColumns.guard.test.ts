import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

describe('order header and list columns', () => {
  it('shows only the order number in the order view title', () => {
    const source = read('./show.tsx');

    expect(source).toContain('? `Заказ ${record.order_name}`');
    expect(source).not.toContain('? `Заказ ${record.order_full_number}`');
  });

  it('does not expose the database order id as a list column', () => {
    const source = read('./list.tsx');

    expect(source).not.toContain("{ key: 'order_id', label: 'id'");
    expect(source).not.toContain('dataIndex: "order_id",\n      key: "order_id",');
    expect(source).not.toContain('ID заказа</span>');
  });
});
