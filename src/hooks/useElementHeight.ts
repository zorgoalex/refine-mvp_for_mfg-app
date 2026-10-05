import { useEffect, useState, type RefObject } from 'react';

function observeHeight(element: HTMLElement | null, setHeight: (height: number) => void): (() => void) | undefined {
  if (!element) { setHeight(0); return undefined; }
  const update = () => setHeight(Math.ceil(element.getBoundingClientRect().height));
  update();
  const observer = new ResizeObserver(update);
  observer.observe(element);
  window.addEventListener('resize', update);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', update);
  };
}

/** Высота элемента оболочки (липкая лента вкладок, подвал) — для отступов липких блоков страницы; нет элемента — 0. */
export function useSelectorHeight(selector: string): number {
  const [height, setHeight] = useState(0);
  useEffect(() => observeHeight(document.querySelector<HTMLElement>(selector), setHeight), [selector]);
  return height;
}

/** Высота собственного блока страницы (липкая шапка списка) — отступ липкой шапки таблицы под ним. */
export function useRefHeight(ref: RefObject<HTMLElement>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => observeHeight(ref.current, setHeight), [ref]);
  return height;
}

/**
 * Нижняя граница липкого элемента оболочки в закреплённом состоянии: его sticky/fixed `top` + высота. Лента вкладок
 * закрепляется под шапкой приложения (top 64px) или у верхнего края (top 0) — зависит от варианта оболочки.
 */
export function useStickyBottom(selector: string): number {
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) { setBottom(0); return undefined; }
    const update = () => {
      const style = getComputedStyle(element);
      const pinned = style.position === 'sticky' || style.position === 'fixed';
      setBottom(Math.ceil((pinned ? parseFloat(style.top) || 0 : 0) + element.getBoundingClientRect().height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [selector]);
  return bottom;
}
