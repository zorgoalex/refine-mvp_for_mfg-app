import React, { useEffect, useRef, useState } from 'react';
import { RightOutlined } from '@ant-design/icons';

export const findTableHorizontalScroller = (root: ParentNode): HTMLElement | null =>
  (root.querySelector('.ant-table-body') as HTMLElement | null) ??
  (root.querySelector('.ant-table-content') as HTMLElement | null);

interface TableTopScrollState {
  scrollWidth: number;
  clientWidth: number;
  visible: boolean;
}

interface TableTopScrollProps {
  children: React.ReactNode;
  className?: string;
  manageAntTableScroll?: boolean;
  horizontalEdgeScrollButton?: boolean;
}

const VERTICAL_WHEEL_SCROLL_QUIET_MS = 160;

const createScrollState = (scroller: HTMLElement | null): TableTopScrollState => {
  if (!scroller) {
    return { scrollWidth: 0, clientWidth: 0, visible: false };
  }
  const scrollWidth = scroller.scrollWidth;
  const clientWidth = scroller.clientWidth;
  return {
    scrollWidth,
    clientWidth,
    visible: scrollWidth > clientWidth + 1,
  };
};

export const syncHorizontalEdgeButton = (
  button: HTMLButtonElement | null,
  scroller: HTMLElement | null,
) => {
  if (!button || !scroller) return;
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const scrollsBack = maxScrollLeft > 0 && scroller.scrollLeft >= maxScrollLeft - 1;
  button.dataset.scrollsBack = scrollsBack ? 'true' : 'false';
  button.setAttribute(
    'aria-label',
    scrollsBack ? 'Прокрутить список деталей влево' : 'Прокрутить список деталей вправо',
  );
  button.title = scrollsBack ? 'Прокрутить влево' : 'Прокрутить вправо';
};

export const isPrimarilyVerticalWheel = (
  event: Pick<WheelEvent, 'deltaX' | 'deltaY'>,
): boolean => Math.abs(event.deltaY) > Math.abs(event.deltaX);

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
export const TableTopScroll: React.FC<TableTopScrollProps> = ({
  children,
  className,
  manageAntTableScroll = false,
  horizontalEdgeScrollButton = false,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const edgeButtonRef = useRef<HTMLButtonElement>(null);
  const [scrollState, setScrollState] = useState<TableTopScrollState>({
    scrollWidth: 0,
    clientWidth: 0,
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
    let headerScroller: HTMLElement | null = null;
    let verticalWheelScrollUntil = 0;
    let edgeButtonFrame = 0;

    const updateEdgeButtonTop = () => {
      if (!horizontalEdgeScrollButton) return;
      const rect = wrap.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const visibleTop = Math.max(rect.top, 0);
      const visibleBottom = Math.min(rect.bottom, viewportHeight);
      const rawTop = visibleBottom > visibleTop
        ? ((visibleTop + visibleBottom) / 2) - rect.top
        : rect.height / 2;
      const minTop = 28;
      const maxTop = Math.max(minTop, rect.height - 28);
      const top = Math.min(maxTop, Math.max(minTop, rawTop));
      wrap.style.setProperty('--app-table-horizontal-edge-button-top', `${top}px`);
    };

    const scheduleEdgeButtonTop = () => {
      if (!horizontalEdgeScrollButton) return;
      window.cancelAnimationFrame(edgeButtonFrame);
      edgeButtonFrame = window.requestAnimationFrame(updateEdgeButtonTop);
    };

    const measure = () => {
      const next = createScrollState(scroller);
      setScrollState((current) =>
        current.scrollWidth === next.scrollWidth
          && current.clientWidth === next.clientWidth
          && current.visible === next.visible
          ? current
          : next,
      );
      syncHorizontalEdgeButton(edgeButtonRef.current, scroller);
      scheduleEdgeButtonTop();
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
      const scrollLeft = scroller.scrollLeft;
      if (top.scrollLeft !== scrollLeft) top.scrollLeft = scrollLeft;
      if (manageAntTableScroll && headerScroller && headerScroller.scrollLeft !== scrollLeft) {
        headerScroller.scrollLeft = scrollLeft;
      }
      syncHorizontalEdgeButton(edgeButtonRef.current, scroller);
      syncingScroller = false;
    };

    const onManagedWheelCapture = (event: WheelEvent) => {
      if (
        !scroller
        || !(event.target instanceof Node)
        || (event.target !== scroller && !scroller.contains(event.target))
        || !isPrimarilyVerticalWheel(event)
      ) return;
      verticalWheelScrollUntil = performance.now() + VERTICAL_WHEEL_SCROLL_QUIET_MS;
    };

    const onManagedScrollCapture = (event: Event) => {
      if (event.target === headerScroller) {
        event.stopPropagation();
        return;
      }
      if (event.target !== scroller) return;

      // rc-table reads layout and toggles ping classes here. On wide edit tables
      // that invalidates every cell and can block the main thread for seconds.
      event.stopPropagation();
      if (performance.now() <= verticalWheelScrollUntil) return;
      onScrollerScroll();
    };

    const attach = () => {
      const s = findScroller();
      if (s !== scroller) {
        scroller?.removeEventListener('scroll', onScrollerScroll);
        if (scroller && resizeObserver) resizeObserver.unobserve(scroller);
        scroller = s;
        if (scroller && !manageAntTableScroll) {
          scroller.addEventListener('scroll', onScrollerScroll, { passive: true });
        }
        scrollerRef.current = scroller;
        if (scroller) resizeObserver?.observe(scroller);
      }
      headerScroller = wrap.querySelector('.ant-table-header');
      measure();
    };

    const scheduleAttach = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(attach);
    };

    top.addEventListener('scroll', onTopScroll, { passive: true });
    if (manageAntTableScroll) {
      wrap.addEventListener('wheel', onManagedWheelCapture, { capture: true, passive: true });
      wrap.addEventListener('scroll', onManagedScrollCapture, { capture: true, passive: true });
    }
    if (horizontalEdgeScrollButton) {
      window.addEventListener('scroll', scheduleEdgeButtonTop, { passive: true });
      window.addEventListener('resize', scheduleEdgeButtonTop, { passive: true });
      scheduleEdgeButtonTop();
    }

    resizeObserver = new ResizeObserver(scheduleAttach);
    resizeObserver.observe(wrap);
    attach();

    // Column/data changes swap inner nodes — re-resolve the scroller + width.
    const mo = new MutationObserver(scheduleAttach);
    mo.observe(wrap, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(edgeButtonFrame);
      top.removeEventListener('scroll', onTopScroll);
      wrap.removeEventListener('wheel', onManagedWheelCapture, true);
      wrap.removeEventListener('scroll', onManagedScrollCapture, true);
      window.removeEventListener('scroll', scheduleEdgeButtonTop);
      window.removeEventListener('resize', scheduleEdgeButtonTop);
      scroller?.removeEventListener('scroll', onScrollerScroll);
      resizeObserver?.disconnect();
      mo.disconnect();
    };
  }, [horizontalEdgeScrollButton, manageAntTableScroll]);

  const scrollTableFromEdgeButton = () => {
    const scroller = scrollerRef.current ?? (wrapRef.current ? findTableHorizontalScroller(wrapRef.current) : null);
    if (!scroller) return;
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const step = Math.max(160, Math.floor(scroller.clientWidth * 0.82));
    const nextLeft = scroller.scrollLeft >= maxLeft - 1
      ? 0
      : Math.min(maxLeft, scroller.scrollLeft + step);
    scroller.scrollTo({ left: nextLeft, behavior: 'smooth' });
    if (topRef.current) topRef.current.scrollTo({ left: nextLeft, behavior: 'smooth' });
    syncHorizontalEdgeButton(edgeButtonRef.current, scroller);
  };

  return (
    <div
      ref={wrapRef}
      className={['app-table-top-scroll-container', className].filter(Boolean).join(' ') || undefined}
      data-table-top-scroll-managed="true"
    >
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
      {horizontalEdgeScrollButton && scrollState.visible ? (
        <button
          ref={edgeButtonRef}
          type="button"
          className="app-table-horizontal-edge-button"
          data-scrolls-back="false"
          aria-label="Прокрутить список деталей вправо"
          title="Прокрутить вправо"
          onClick={scrollTableFromEdgeButton}
        >
          <RightOutlined aria-hidden />
        </button>
      ) : null}
    </div>
  );
};
