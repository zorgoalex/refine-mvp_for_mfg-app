import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');

describe('order show detail column widths', () => {
  it.each(['height', 'width', 'area'])('keeps %s on the compact dimension width', (key) => {
    expect(source).toMatch(
      new RegExp(`key: '${key}',\\s+width: ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH,`),
    );
  });

  it('keeps quantity on the compact quantity width', () => {
    expect(source).toMatch(
      /key: 'quantity',\s+width: ORDER_DETAIL_SHOW_QUANTITY_COLUMN_WIDTH,/,
    );
  });

  it('keeps the compact width constants stable', () => {
    expect(source).toContain('const ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH = 48.6;');
    expect(source).toContain('const ORDER_DETAIL_SHOW_QUANTITY_COLUMN_WIDTH = 42.525;');
  });
});
