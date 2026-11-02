import { useEffect } from 'react';

/**
 * Полоса вкладок экранов на телефоне листается пальцем, как обычная прокрутка.
 *
 * antd Tabs (rc-tabs useTouchMove) ловит touchstart на `.ant-tabs-nav-wrap`, а затем на каждом
 * touchmove документа вызывает preventDefault и сдвигает список через transform. У вкладок
 * приложения transform выключен (`transform: none !important`), а на телефоне полоса — обычная
 * горизонтальная прокрутка (`overflow-x: auto`), поэтому свайп по вкладкам не делал ничего.
 * Перехват на document в фазе capture не пускает touchstart к обработчику rc-tabs: свайп
 * остаётся за браузером. Только там, где CSS включил прокрутку полосы; нажатия (click) не трогаем.
 */
export function shouldUseNativeTabStripScroll(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  const wrap = target.closest('.workspace-tabs .ant-tabs-nav-wrap');
  if (!wrap) return false;
  const overflowX = getComputedStyle(wrap).overflowX;
  return overflowX === 'auto' || overflowX === 'scroll';
}

export function useNativeWorkspaceTabScroll(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onTouchStart = (event: TouchEvent) => {
      if (shouldUseNativeTabStripScroll(event.target)) event.stopPropagation();
    };
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    return () => document.removeEventListener('touchstart', onTouchStart, { capture: true });
  }, []);
}
