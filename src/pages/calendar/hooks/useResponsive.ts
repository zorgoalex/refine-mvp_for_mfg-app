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
  // Initial width: try the container first (rarely ready before first commit),
  // then fall back to globalThis.innerWidth as best-effort. The ResizeObserver
  // below corrects this on the first effect tick.
  //
  // Limitation: on a desktop window with the sider visible (~900px window,
  // ~700px container) the initial fallback classifies as desktop while the
  // actual container classifies as mobile. The set-once viewMode default in
  // CalendarBoard is therefore set to STANDARD in that edge case. For typical
  // viewports (mobile without sider, desktop with >= 1024px window) the
  // fallback and the container agree, so no flicker. A proper fix would
  // require passing the measured width as a prop from a parent that can
  // read it before mount, which is out of scope.
  const [width, setWidth] = useState<number>(() => {
    const measured = measureContainerWidth(containerRef);
    if (measured > 0) {
      return measured;
    }
    if (windowFallback && typeof globalThis !== 'undefined' && typeof globalThis.innerWidth === 'number') {
      return globalThis.innerWidth;
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
