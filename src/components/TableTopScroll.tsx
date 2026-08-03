import React, { useEffect, useRef, useState } from 'react';

export const findTableHorizontalScroller = (root: ParentNode): HTMLElement | null =>
  (root.querySelector('.ant-table-body') as HTMLElement | null) ??
  (root.querySelector('.ant-table-content') as HTMLElement | null);

interface TableTopScrollState {
  scrollWidth: number;
  visible: boolean;
}

/**
 * Wraps a horizontally-scrollable Ant Design `<Table>` and renders a SECOND
 * horizontal scrollbar pinned to the TOP of the table, kept in sync with the
 * table's own (bottom) horizontal scroller. This lets a user scroll a wide table
 * sideways without first scrolling all the way down to reach the native bar.
 *
 * The wrapped Table MUST enable horizontal scrolling (e.g. `scroll={{ x: ... }}`)
 * so Ant Design produces an overflow container. Ant Design puts that container on
 * `.ant-table-content` when only `scroll.x` is set, or on `.ant-table-body` when
 * `scroll.y` is also set; we resolve whichever exists at runtime.
 *
 * No external deps, no portals: a thin top bar div whose inner spacer mirrors the
 * table's scrollWidth drives `scrollLeft` both ways. A ResizeObserver +
 * MutationObserver keep the spacer width correct as columns/rows/data change.
 */
export const TableTopScroll: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<TableTopScrollState>({
    scrollWidth: 0,
    visible: false,
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    const top = topRef.current;
    if (!wrap || !top) return;

    const findScroller = (): HTMLElement | null => findTableHorizontalScroller(wrap);

    let scroller: HTMLElement | null = null;
    let syncingTop = false;
    let syncingScroller = false;
    let frame = 0;
    let resizeObserver: ResizeObserver | null = null;

    const measure = () => {
      if (!scroller) return;
      const nextScrollWidth = scroller.scrollWidth;
      const nextVisible = nextScrollWidth > scroller.clientWidth + 1;
      setScrollState((current) =>
        current.scrollWidth === nextScrollWidth && current.visible === nextVisible
          ? current
          : { scrollWidth: nextScrollWidth, visible: nextVisible },
      );
    };

    const onTopScroll = () => {
      if (syncingScroller) return;
      const s = scroller;
      if (!s) return;
      syncingTop = true;
      if (s.scrollLeft !== top.scrollLeft) s.scrollLeft = top.scrollLeft;
      syncingTop = false;
    };
    const onScrollerScroll = () => {
      if (!scroller || syncingTop) return;
      syncingScroller = true;
      if (top.scrollLeft !== scroller.scrollLeft) top.scrollLeft = scroller.scrollLeft;
      syncingScroller = false;
    };

    const attach = () => {
      const s = findScroller();
      if (s && s !== scroller) {
        scroller?.removeEventListener('scroll', onScrollerScroll);
        if (scroller && resizeObserver) resizeObserver.unobserve(scroller);
        scroller = s;
        scroller.addEventListener('scroll', onScrollerScroll, { passive: true });
        resizeObserver?.observe(scroller);
      }
      measure();
    };

    const scheduleAttach = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(attach);
    };

    top.addEventListener('scroll', onTopScroll, { passive: true });

    resizeObserver = new ResizeObserver(scheduleAttach);
    resizeObserver.observe(wrap);
    attach();

    // Column/data changes swap inner nodes — re-resolve the scroller + width.
    const mo = new MutationObserver(scheduleAttach);
    mo.observe(wrap, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(frame);
      top.removeEventListener('scroll', onTopScroll);
      scroller?.removeEventListener('scroll', onScrollerScroll);
      resizeObserver?.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className={className} data-table-top-scroll-managed="true">
      <div
        ref={topRef}
        aria-hidden
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          // Keep layout stable but hide the bar when there is nothing to scroll.
          height: scrollState.visible ? undefined : 0,
        }}
      >
        <div style={{ width: scrollState.scrollWidth, height: 1 }} />
      </div>
      {children}
    </div>
  );
};
