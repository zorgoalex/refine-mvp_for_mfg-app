import { describe, expect, it, vi } from 'vitest';
import { findTableHorizontalScroller } from './TableTopScroll';

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
