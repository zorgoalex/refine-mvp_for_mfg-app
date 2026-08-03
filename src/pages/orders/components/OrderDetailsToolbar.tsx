import React, { useCallback, useEffect, useRef, useState } from 'react';

export const OrderToolbarLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="order-details-toolbar__label">{children}</span>
);

export const shouldCompactOrderToolbar = (
  expandedWidth: number,
  availableWidth: number,
): boolean => expandedWidth > availableWidth + 1;

export const OrderDetailsToolbar: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const expandedWidthRef = useRef<number | null>(null);
  const [compact, setCompact] = useState(false);

  const measure = useCallback((availableWidth?: number, contentChanged = false) => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof document === 'undefined') return;

    let expandedWidth = expandedWidthRef.current;
    if (expandedWidth === null || contentChanged) {
      if (!content.classList.contains('order-details-toolbar__content--compact')) {
        expandedWidth = content.scrollWidth;
      } else {
        const clone = content.cloneNode(true) as HTMLDivElement;
        clone.classList.add('order-details-toolbar__content--measure');
        clone.classList.remove('order-details-toolbar__content--compact');
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('inert', '');
        clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
        container.appendChild(clone);
        expandedWidth = clone.scrollWidth;
        clone.remove();
      }
      expandedWidthRef.current = expandedWidth;
    }

    setCompact(shouldCompactOrderToolbar(expandedWidth, availableWidth ?? container.clientWidth));
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    let mutationFrame = 0;
    const scheduleContentMeasure = () => {
      window.cancelAnimationFrame(mutationFrame);
      mutationFrame = window.requestAnimationFrame(() => measure(undefined, true));
    };

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const entry = entries.find(({ target }) => target === container);
          if (entry) measure(entry.contentRect.width);
        });
    resizeObserver?.observe(container);
    if (!resizeObserver) scheduleContentMeasure();

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scheduleContentMeasure);
    mutationObserver?.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.cancelAnimationFrame(mutationFrame);
    };
  }, [measure]);

  return (
    <div ref={containerRef} className="order-details-toolbar">
      <div
        ref={contentRef}
        className={`order-details-toolbar__content${compact ? ' order-details-toolbar__content--compact' : ''}`}
        data-compact={compact ? 'true' : 'false'}
      >
        {children}
      </div>
    </div>
  );
};
