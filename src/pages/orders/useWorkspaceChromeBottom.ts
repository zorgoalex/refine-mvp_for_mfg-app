import { useEffect, useState } from 'react';

/**
 * Bottom edge of the sticky app chrome (top bar + workspace tabs), i.e. where page-owned
 * sticky elements must stop. Works for both shell layouts: tabs sticky under a separate
 * header (their own `top` + height) and tabs living inside the single top bar (height only).
 */
export function useWorkspaceChromeBottom(): number {
  const [bottom, setBottom] = useState(0);

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    const attach = (): boolean => {
      const tabs = document.querySelector<HTMLElement>('.workspace-tabs');
      if (!tabs) return false;
      const measure = () => {
        const style = window.getComputedStyle(tabs);
        const stickyTop = style.position === 'sticky' ? Number.parseFloat(style.top) || 0 : 0;
        setBottom(Math.round(stickyTop + tabs.getBoundingClientRect().height));
      };
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(tabs);
      }
      return true;
    };
    if (attach()) return () => ro?.disconnect();
    const mo = new MutationObserver(() => {
      if (attach()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);

  return bottom;
}
