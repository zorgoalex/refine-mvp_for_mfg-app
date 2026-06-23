import React, { useEffect, useRef, useState } from 'react';

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
  const [scrollWidth, setScrollWidth] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    const top = topRef.current;
    if (!wrap || !top) return;

    const findScroller = (): HTMLElement | null =>
      (wrap.querySelector('.ant-table-content') as HTMLElement | null) ??
      (wrap.querySelector('.ant-table-body') as HTMLElement | null);

    let scroller: HTMLElement | null = null;
    let syncingTop = false;
    let syncingScroller = false;

    const measure = () => {
      const s = findScroller();
      if (!s) return;
      setScrollWidth(s.scrollWidth);
      setVisible(s.scrollWidth > s.clientWidth + 1);
    };

    const onTopScroll = () => {
      if (syncingScroller) return;
      const s = findScroller();
      if (!s) return;
      syncingTop = true;
      s.scrollLeft = top.scrollLeft;
      syncingTop = false;
    };
    const onScrollerScroll = () => {
      if (syncingTop) return;
      syncingScroller = true;
      top.scrollLeft = (findScroller()?.scrollLeft) ?? 0;
      syncingScroller = false;
    };

    const attach = () => {
      const s = findScroller();
      if (s && s !== scroller) {
        scroller?.removeEventListener('scroll', onScrollerScroll);
        scroller = s;
        scroller.addEventListener('scroll', onScrollerScroll, { passive: true });
      }
      measure();
    };

    top.addEventListener('scroll', onTopScroll, { passive: true });
    attach();

    const ro = new ResizeObserver(() => attach());
    if (scroller) ro.observe(scroller);
    ro.observe(wrap);
    // Column/data changes swap inner nodes — re-resolve the scroller + width.
    const mo = new MutationObserver(() => attach());
    mo.observe(wrap, { childList: true, subtree: true });

    return () => {
      top.removeEventListener('scroll', onTopScroll);
      scroller?.removeEventListener('scroll', onScrollerScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className={className}>
      <div
        ref={topRef}
        aria-hidden
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          // Keep layout stable but hide the bar when there is nothing to scroll.
          height: visible ? undefined : 0,
        }}
      >
        <div style={{ width: scrollWidth, height: 1 }} />
      </div>
      {children}
    </div>
  );
};
