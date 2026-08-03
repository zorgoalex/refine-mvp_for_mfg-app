import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { findTableHorizontalScroller } from './TableTopScroll';

const source = readFileSync(new URL('./TableTopScroll.tsx', import.meta.url), 'utf8');

describe('findTableHorizontalScroller', () => {
  it('uses the table body when vertical scrolling creates both containers', () => {
    const body = { scrollLeft: 0 } as HTMLElement;
    const content = { scrollLeft: 0 } as HTMLElement;
    const root = {
      querySelector: vi.fn((selector: string) =>
        selector === '.ant-table-body' ? body : content),
    } as unknown as ParentNode;

    expect(findTableHorizontalScroller(root)).toBe(body);
    expect(root.querySelector).toHaveBeenCalledTimes(1);
  });

  it('falls back to table content when there is no vertical body', () => {
    const content = { scrollLeft: 0 } as HTMLElement;
    const root = {
      querySelector: vi.fn((selector: string) =>
        selector === '.ant-table-body' ? null : content),
    } as unknown as ParentNode;

    expect(findTableHorizontalScroller(root)).toBe(content);
  });
});

describe('TableTopScroll performance guards', () => {
  it('uses the cached table scroller during scroll synchronization', () => {
    expect(source).toContain('const s = scroller');
    expect(source).toContain('top.scrollLeft !== scroller.scrollLeft');
    expect(source).not.toContain('findScroller()?.scrollLeft');
  });

  it('coalesces observer-driven measurement into animation frames', () => {
    expect(source).toContain('requestAnimationFrame(attach)');
    expect(source).toContain('new ResizeObserver(scheduleAttach)');
    expect(source).toContain('new MutationObserver(scheduleAttach)');
  });
});
