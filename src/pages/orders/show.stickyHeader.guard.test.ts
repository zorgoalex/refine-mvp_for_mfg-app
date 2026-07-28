import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(fileURLToPath(new URL('./show.tsx', import.meta.url)), 'utf8');
const headerSource = readFileSync(fileURLToPath(new URL('./components/sections/OrderShowHeader.tsx', import.meta.url)), 'utf8');
const appCss = readFileSync(fileURLToPath(new URL('../../styles/app.css', import.meta.url)), 'utf8');

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

  it('pins the stack below workspace tabs and keeps table headers below the sticky toolbar', () => {
    expect(appCss).toMatch(/\.order-show-page--sticky-enabled \.order-show-summary-tabs-sticky[\s\S]*position:\s*sticky/);
    expect(appCss).toContain('top: var(--order-show-sticky-top)');
    expect(appCss).toContain('top: calc(var(--order-show-sticky-top) + var(--order-show-summary-tabs-height))');
    expect(appCss).toContain('top: var(--order-show-table-header-top)');
  });
});
