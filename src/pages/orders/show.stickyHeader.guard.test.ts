import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(fileURLToPath(new URL('./show.tsx', import.meta.url)), 'utf8');
const headerSource = readFileSync(fileURLToPath(new URL('./components/sections/OrderShowHeader.tsx', import.meta.url)), 'utf8');
const appCss = readFileSync(fileURLToPath(new URL('../../styles/app.css', import.meta.url)), 'utf8');
const compactHeaderSource = headerSource.match(/if \(compactSticky\) \{[\s\S]*?\n  \}\n\n  return \(/)?.[0] ?? '';
const compactLineCss = appCss.match(/\.order-show-header__compact-line \{[\s\S]*?\n\}/)?.[0] ?? '';

describe('OrderShow sticky detail header guards', () => {
  it('keeps the order summary, tabs, detail actions, and detail header in the sticky stack', () => {
    expect(showSource).toContain('order-show-summary-tabs-sticky');
    expect(showSource).toContain('order-show-tabs-shell');
    expect(showSource).toContain('order-show-details-toolbar');
    expect(showSource).toContain('order-show-details-table');
    expect(showSource).toContain('orderShowStickyEnabled');
  });

  it('switches the order summary to the compact one-line variant only when stuck', () => {
    expect(headerSource).toContain('compactSticky?: boolean');
    expect(showSource).toContain('compactSticky={orderShowStickyEnabled && orderShowSummaryStuck}');
    expect(headerSource).toContain('order-show-header--compact-sticky');
    expect(headerSource).toContain('order-show-header__compact-line');
  });

  it('keeps the compact stuck summary dense enough to avoid horizontal scrolling', () => {
    expect(compactHeaderSource).toContain('<StarOutlined aria-hidden');
    expect(headerSource).toContain('paidAmount > 0 ? `опл.');
    expect(compactHeaderSource).toContain('поз.');
    expect(compactHeaderSource).toContain('дет.');
    expect(compactHeaderSource).not.toContain('приоритет {record?.priority');
    expect(compactHeaderSource).not.toContain('оплачено ${formatNumber(paidAmount');
    expect(compactHeaderSource).not.toContain('Примечание: {record?.notes');
    expect(compactHeaderSource).not.toContain('Материал: <Text strong>{materialsSummary}</Text>');
    expect(compactHeaderSource).not.toContain('Площадь: <Text strong>{formatNumber(totals.total_area');
    expect(compactLineCss).toContain('overflow: hidden;');
    expect(compactLineCss).not.toContain('overflow-x: auto;');
  });

  it('pins the stack below workspace tabs and keeps table headers below the sticky toolbar', () => {
    expect(appCss).toMatch(/\.order-show-page--sticky-enabled \.order-show-summary-tabs-sticky[\s\S]*position:\s*sticky/);
    expect(appCss).toContain('top: var(--order-show-sticky-top)');
    expect(appCss).toContain('top: calc(var(--order-show-sticky-top) + var(--order-show-summary-tabs-height))');
    expect(appCss).toContain('top: var(--order-show-table-header-top)');
    expect(appCss).toMatch(/\.order-show-page--summary-stuck \.order-show-details-table \.ant-table-thead > tr > th[\s\S]*position:\s*sticky/);
    expect(appCss).not.toMatch(/\.order-show-page--sticky-enabled \.order-show-details-table \.ant-table-thead > tr > th[\s\S]*position:\s*sticky/);
  });
});
