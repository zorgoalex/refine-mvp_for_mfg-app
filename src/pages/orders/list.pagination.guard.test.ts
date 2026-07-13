import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('orders list pagination', () => {
  it('renders pagination above and below the orders table in compact mode', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'list.tsx'), 'utf8');

    expect(source).toContain('ordersCompactPagination');
    expect(source).toContain("position: ['topRight', 'bottomRight']");
    expect(source).toContain("size: 'small'");
    expect(source).toContain('simple: false');
  });

  it('vertically centers compact pagination controls of different heights', () => {
    const styles = fs.readFileSync(path.resolve(__dirname, 'list.css'), 'utf8');

    expect(styles).toMatch(/\.orders-table \.ant-pagination\s*\{[^}]*align-items:\s*center;/s);
  });
});
