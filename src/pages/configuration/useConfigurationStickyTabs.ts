import { useEffect, useRef } from 'react';

/** Account for the visible shell bars and wrapped configuration tabs. */
export function useConfigurationStickyTabs() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const bars = Array.from(document.querySelectorAll<HTMLElement>('.evolution-header, .workspace-tabs'));
    const nav = root.querySelector<HTMLElement>('.configuration-tabs-wrap > .ant-tabs-nav');
    const measure = () => {
      let scrollsInsideShell = false;
      for (let parent = root.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
          scrollsInsideShell = true;
          break;
        }
      }
      const top = scrollsInsideShell ? 0 : bars.reduce((bottom, bar) => {
        const style = getComputedStyle(bar);
        if (style.position !== 'sticky' || !bar.getClientRects().length) return bottom;
        return Math.max(bottom, (parseFloat(style.top) || 0) + bar.getBoundingClientRect().height);
      }, 0);
      root.style.setProperty('--configuration-sticky-top', `${top}px`);
      root.style.setProperty('--configuration-tabs-height', `${nav?.getBoundingClientRect().height ?? 0}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    bars.forEach((bar) => observer.observe(bar));
    if (nav) observer.observe(nav);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return ref;
}
