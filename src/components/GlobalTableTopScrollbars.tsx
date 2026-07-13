import { useEffect } from 'react';

const TABLE_SELECTOR = '.ant-table-wrapper';
const SCROLLER_SELECTOR = '.ant-table-body, .ant-table-content';

type TableController = {
  measure: () => void;
  destroy: () => void;
};

const findHorizontalScroller = (table: HTMLElement): HTMLElement | null => {
  const candidates = Array.from(table.querySelectorAll<HTMLElement>(SCROLLER_SELECTOR));
  return candidates.find((node) => node.scrollWidth > node.clientWidth + 1) ?? candidates[0] ?? null;
};

const attachTopScrollbar = (table: HTMLElement): TableController | null => {
  if (table.closest('[data-table-top-scroll-managed="true"]')) return null;

  const container = table.querySelector<HTMLElement>('.ant-table-container');
  if (!container) return null;

  const top = document.createElement('div');
  top.className = 'app-table-top-scrollbar';
  top.setAttribute('aria-hidden', 'true');
  const spacer = document.createElement('div');
  spacer.className = 'app-table-top-scrollbar__spacer';
  top.append(spacer);
  container.before(top);

  let scroller: HTMLElement | null = null;
  let syncing = false;
  let resizeObserver: ResizeObserver;

  const onTopScroll = () => {
    if (!scroller || syncing) return;
    syncing = true;
    scroller.scrollLeft = top.scrollLeft;
    syncing = false;
  };

  const onBottomScroll = () => {
    if (!scroller || syncing) return;
    syncing = true;
    top.scrollLeft = scroller.scrollLeft;
    syncing = false;
  };

  const measure = () => {
    const nextScroller = findHorizontalScroller(table);
    if (nextScroller !== scroller) {
      scroller?.removeEventListener('scroll', onBottomScroll);
      if (scroller) resizeObserver?.unobserve(scroller);
      scroller = nextScroller;
      scroller?.addEventListener('scroll', onBottomScroll, { passive: true });
      if (scroller) resizeObserver?.observe(scroller);
    }

    const hasOverflow = Boolean(scroller && scroller.scrollWidth > scroller.clientWidth + 1);
    top.hidden = !hasOverflow;
    spacer.style.width = hasOverflow ? `${scroller?.scrollWidth ?? 0}px` : '0';
    if (hasOverflow && scroller) top.scrollLeft = scroller.scrollLeft;
  };

  resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(table);
  top.addEventListener('scroll', onTopScroll, { passive: true });
  measure();

  return {
    measure,
    destroy: () => {
      top.removeEventListener('scroll', onTopScroll);
      scroller?.removeEventListener('scroll', onBottomScroll);
      resizeObserver.disconnect();
      top.remove();
    },
  };
};

/** Adds a synchronized top scrollbar to every horizontally overflowing Ant table. */
export const GlobalTableTopScrollbars = () => {
  useEffect(() => {
    const controllers = new Map<HTMLElement, TableController>();

    const syncTables = () => {
      for (const [table, controller] of controllers) {
        if (!table.isConnected) {
          controller.destroy();
          controllers.delete(table);
        }
      }

      document.querySelectorAll<HTMLElement>(TABLE_SELECTOR).forEach((table) => {
        const existing = controllers.get(table);
        if (existing) {
          existing.measure();
          return;
        }
        const controller = attachTopScrollbar(table);
        if (controller) controllers.set(table, controller);
      });
    };

    let frame = 0;
    const scheduleSync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncTables);
    };

    const mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(document.documentElement);
    window.addEventListener('resize', scheduleSync, { passive: true });
    syncTables();

    return () => {
      window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleSync);
      controllers.forEach((controller) => controller.destroy());
      controllers.clear();
    };
  }, []);

  return null;
};

export default GlobalTableTopScrollbars;
