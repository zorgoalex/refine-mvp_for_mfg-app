import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./list.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');

describe('orders list modern UI header wrapping', () => {
  const modernScope = ':root:where([data-ui-variant="evolution"], [data-ui-variant="line"], [data-ui-variant="air"])';

  it('wraps header titles to two word-based lines only in the modern UI family', () => {
    expect(source).toContain('orders-table-header-title');
    expect(source).toContain('withOrderListHeaderTitles([');

    expect(css).toContain(`${modernScope} .orders-table .ant-table-thead > tr > th`);
    expect(css).toMatch(/\.orders-table-header-title[\s\S]*-webkit-line-clamp:\s*2/);
    expect(css).toMatch(/\.orders-table-header-title[\s\S]*word-break:\s*normal/);
    expect(css).toMatch(/\.orders-table-header-title[\s\S]*overflow-wrap:\s*normal/);
    expect(css).not.toMatch(/:root:where\(\[data-ui-variant="evolution"\], \[data-ui-variant="line"\], \[data-ui-variant="air"\]\)[\s\S]*word-break:\s*break-word/);
  });
});
