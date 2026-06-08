import { useEffect, useState, type RefObject } from 'react';
import { LAYOUT_CONFIG } from '../utils/calendarLayout';
import { subscribeMediaQuery } from '../../../hooks/useMediaQuery';

export interface ResponsiveState {
  isMobile: boolean;
  isNarrow: boolean;
  width: number;
}

export const DEFAULT_RESPONSIVE_STATE: ResponsiveState = {
  isMobile: false,
  isNarrow: false,
  width: 0,
};

export function classifyWidth(width: number, fallback: ResponsiveState = DEFAULT_RESPONSIVE_STATE): ResponsiveState {
  if (!Number.isFinite(width) || width <= 0) {
    return fallback;
  }
  return {
    isMobile: width <= LAYOUT_CONFIG.MOBILE_BREAKPOINT,
    isNarrow: width <= 480,
    width,
  };
}

function measureContainerWidth(ref: RefObject<HTMLElement | null>): number {
  if (!ref.current) {
    return 0;
  }
  const rect = ref.current.getBoundingClientRect();
  return rect.width;
}

export function useResponsive(
  containerRef: RefObject<HTMLElement | null>,
  options: { windowFallback?: boolean } = {},
): ResponsiveState {
  const { windowFallback = true } = options;
  const [width, setWidth] = useState<number>(() => {
    const measured = measureContainerWidth(containerRef);
    if (measured > 0) {
      return measured;
    }
    if (windowFallback && typeof globalThis.matchMedia === 'function') {
      return LAYOUT_CONFIG.DESKTOP_COLUMN_WIDTH * 4;
    }
    return 0;
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    setWidth(measureContainerWidth(containerRef));

    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  useEffect(() => {
    if (width > 0 || !windowFallback) {
      return;
    }
    return subscribeMediaQuery(`(min-width: ${LAYOUT_CONFIG.MOBILE_BREAKPOINT + 1}px)`, () => {
      setWidth(window.innerWidth);
    });
  }, [width, windowFallback]);

  return classifyWidth(width);
}
