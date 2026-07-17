import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

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
  const [compact, setCompact] = useState(false);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof document === 'undefined') return;

    const clone = content.cloneNode(true) as HTMLDivElement;
    clone.classList.add('order-details-toolbar__content--measure');
    clone.classList.remove('order-details-toolbar__content--compact');
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('inert', '');
    clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    document.body.appendChild(clone);
    const expandedWidth = clone.getBoundingClientRect().width;
    clone.remove();

    setCompact(shouldCompactOrderToolbar(expandedWidth, container.clientWidth));
  }, []);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure);
    resizeObserver?.observe(container);

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(measure);
    mutationObserver?.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
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
