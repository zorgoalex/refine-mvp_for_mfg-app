import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('global table top scrollbars', () => {
  const controller = read('./GlobalTableTopScrollbars.tsx');

  it('discovers every Ant table and mirrors horizontal scrolling both ways', () => {
    expect(controller).toContain("const TABLE_SELECTOR = '.ant-table-wrapper'");
    expect(controller).toContain('scroller.scrollLeft = top.scrollLeft');
    expect(controller).toContain('top.scrollLeft = scroller.scrollLeft');
  });

  it('shows the extra bar only for real horizontal overflow', () => {
    expect(controller).toContain('scroller.scrollWidth > scroller.clientWidth + 1');
    expect(controller).toContain('const nextHidden = !hasOverflow');
    expect(controller).toContain('if (top.hidden !== nextHidden) top.hidden = nextHidden');
  });

  it('covers both application layouts without duplicating existing wrappers', () => {
    expect(read('./CustomLayout.tsx')).toContain('<GlobalTableTopScrollbars />');
    expect(read('./workspace/WorkspaceLayout.tsx')).toContain('<GlobalTableTopScrollbars />');
    expect(read('./TableTopScroll.tsx')).toContain('data-table-top-scroll-managed="true"');
    expect(controller).toContain("table.closest('[data-table-top-scroll-managed=\"true\"]')");
  });

  it('ignores non-table DOM mutations before remeasuring table scrollbars', () => {
    expect(controller).toContain('const hasTableMutation');
    expect(controller).toContain('new MutationObserver((mutations)');
    expect(controller).toContain('if (hasTableMutation(mutations)) scheduleSync();');
  });
});
