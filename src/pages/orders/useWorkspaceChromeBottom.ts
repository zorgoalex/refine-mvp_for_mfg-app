import { useEffect, useState } from 'react';

/**
 * Bottom edge of the sticky app chrome (top bar + workspace tabs), i.e. where page-owned
 * sticky elements must stop. Works for both shell layouts: tabs sticky under a separate
 * header (their own `top` + height) and tabs living inside the single top bar (height only).
 *
 * The tabs element can be replaced (first tab opened, last tab closed), so every measurement
 * resolves the CURRENT element; a detached node is never measured — it would report 0 and
 * slide the page's sticky rows under the app chrome.
 */
export function useWorkspaceChromeBottom(): number {
  const [bottom, setBottom] = useState(0);

  useEffect(() => {
    let observed: Element | null = null;
    let frame = 0;
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      const tabs = document.querySelector<HTMLElement>('.workspace-tabs');
      if (tabs !== observed) {
        if (observed) resizeObserver?.unobserve(observed);
        if (tabs) resizeObserver?.observe(tabs);
        observed = tabs;
      }
      if (!tabs) return; // keep the last known edge while the tabs are being swapped
      const style = window.getComputedStyle(tabs);
      const stickyTop = style.position === 'sticky' ? Number.parseFloat(style.top) || 0 : 0;
      const next = Math.round(stickyTop + tabs.getBoundingClientRect().height);
      if (next > 0) setBottom(next);
    };
    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    }
    measure();
    // the tabs are mounted, replaced and removed by the shell, outside this page
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return bottom;
}
