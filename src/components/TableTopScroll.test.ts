import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { findTableHorizontalScroller, isPrimarilyVerticalWheel } from './TableTopScroll';

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

describe('isPrimarilyVerticalWheel', () => {
  it('distinguishes vertical wheel input from horizontal scrolling', () => {
    expect(isPrimarilyVerticalWheel({ deltaX: 0, deltaY: 120 })).toBe(true);
    expect(isPrimarilyVerticalWheel({ deltaX: 80, deltaY: 10 })).toBe(false);
    expect(isPrimarilyVerticalWheel({ deltaX: 20, deltaY: 20 })).toBe(false);
  });
});

describe('TableTopScroll performance guards', () => {
  it('uses the cached table scroller during scroll synchronization', () => {
    expect(source).toContain('const s = scroller');
    expect(source).toContain('const scrollLeft = scroller.scrollLeft;');
    expect(source).toContain('top.scrollLeft !== scrollLeft');
    expect(source).not.toContain('findScroller()?.scrollLeft');
  });

  it('coalesces observer-driven measurement into animation frames', () => {
    expect(source).toContain('requestAnimationFrame(attach)');
    expect(source).toContain('new ResizeObserver(scheduleAttach)');
    expect(source).toContain('new MutationObserver(scheduleAttach)');
  });

  it('blocks rc-table scroll handlers before reading horizontal layout', () => {
    const captureStart = source.indexOf('const onManagedScrollCapture');
    const stopPropagation = source.indexOf('event.stopPropagation()', captureStart);
    const verticalReturn = source.indexOf('verticalWheelScrollUntil) return', captureStart);
    const horizontalSync = source.indexOf('onScrollerScroll()', captureStart);

    expect(captureStart).toBeGreaterThan(-1);
    expect(stopPropagation).toBeGreaterThan(captureStart);
    expect(verticalReturn).toBeGreaterThan(stopPropagation);
    expect(horizontalSync).toBeGreaterThan(verticalReturn);
  });

  it('supports the floating horizontal edge scroll button only for real overflow', () => {
    expect(source).toContain('horizontalEdgeScrollButton?: boolean');
    expect(source).toContain('horizontalEdgeScrollButton && scrollState.visible');
    expect(source).toContain('className="app-table-horizontal-edge-button"');
    expect(source).toContain("scrollTo({ left: nextLeft, behavior: 'smooth' })");
    expect(source).toContain('edgeButtonScrollsBack ? <LeftOutlined aria-hidden /> : <RightOutlined aria-hidden />');
  });
});
