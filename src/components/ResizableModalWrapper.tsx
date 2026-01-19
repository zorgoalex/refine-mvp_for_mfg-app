/**
 * ResizableModalWrapper - обёртка для модальных окон с возможностью изменения размера
 *
 * Позволяет изменять высоту модального окна перетаскиванием нижнего края
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

interface ResizableModalWrapperProps {
  children: React.ReactElement;
  open?: boolean;
  minHeight?: number;
  maxHeight?: number;
  defaultHeight?: number;
  onHeightChange?: (height: number) => void;
}

export const ResizableModalWrapper: React.FC<ResizableModalWrapperProps> = ({
  children,
  open = true,
  minHeight = 400,
  maxHeight,
  defaultHeight,
  onHeightChange,
}) => {
  const [height, setHeight] = useState<number | undefined>(defaultHeight);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Calculate max height based on viewport
  const effectiveMaxHeight = maxHeight || (typeof window !== 'undefined' ? window.innerHeight - 150 : 800);

  // Reset height when modal closes
  useEffect(() => {
    if (!open) {
      setHeight(defaultHeight);
    }
  }, [open, defaultHeight]);

  // Handle resize
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - startYRef.current;
      const newHeight = Math.min(
        Math.max(startHeightRef.current + deltaY, minHeight),
        effectiveMaxHeight
      );
      setHeight(newHeight);
      onHeightChange?.(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, minHeight, effectiveMaxHeight, onHeightChange]);

  // Handle resize start
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const modalBody = containerRef.current?.querySelector('.ant-modal-body') as HTMLElement;
    if (!modalBody) return;

    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height || modalBody.offsetHeight;

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [height]);

  // Clone children and inject height style
  const enhancedChildren = React.cloneElement(children, {
    styles: {
      ...children.props.styles,
      body: {
        ...children.props.styles?.body,
        height: height,
        minHeight: minHeight,
        maxHeight: effectiveMaxHeight,
        transition: isResizing ? 'none' : undefined,
      },
    },
  });

  return (
    <div ref={containerRef} className="resizable-modal-wrapper">
      {enhancedChildren}

      {/* Resize handle at bottom of modal */}
      <style>{`
        .resizable-modal-wrapper .ant-modal-content {
          position: relative;
        }

        .resizable-modal-wrapper .ant-modal-content::after {
          content: '';
          position: absolute;
          bottom: 0;
          left: 50%;
          transform: translateX(-50%);
          width: 60px;
          height: 4px;
          background-color: #d9d9d9;
          border-radius: 2px;
          cursor: ns-resize;
          transition: background-color 0.2s;
          z-index: 10;
        }

        .resizable-modal-wrapper .ant-modal-content:hover::after {
          background-color: #1890ff;
        }

        .resizable-modal-wrapper.resizing .ant-modal-content::after {
          background-color: #1890ff;
        }
      `}</style>

      {/* Invisible resize area for easier grabbing */}
      {open && (
        <div
          onMouseDown={handleResizeStart}
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            height: 20,
            cursor: 'ns-resize',
            zIndex: 1000,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Active resize zone overlay when open */}
      {open && (
        <ResizeHandle
          containerRef={containerRef}
          onResizeStart={handleResizeStart}
          isResizing={isResizing}
        />
      )}
    </div>
  );
};

// Separate component for resize handle that attaches to modal
const ResizeHandle: React.FC<{
  containerRef: React.RefObject<HTMLDivElement>;
  onResizeStart: (e: React.MouseEvent) => void;
  isResizing: boolean;
}> = ({ containerRef, onResizeStart, isResizing }) => {
  const [position, setPosition] = useState({ bottom: 0, left: 0, width: 0 });

  useEffect(() => {
    const updatePosition = () => {
      const modal = containerRef.current?.querySelector('.ant-modal') as HTMLElement;
      if (!modal) return;

      const rect = modal.getBoundingClientRect();
      setPosition({
        bottom: window.innerHeight - rect.bottom + 5,
        left: rect.left + rect.width / 2 - 40,
        width: 80,
      });
    };

    updatePosition();

    // Update position on resize
    const observer = new ResizeObserver(updatePosition);
    const modal = containerRef.current?.querySelector('.ant-modal');
    if (modal) {
      observer.observe(modal);
    }

    window.addEventListener('resize', updatePosition);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [containerRef]);

  return (
    <div
      onMouseDown={onResizeStart}
      style={{
        position: 'fixed',
        bottom: position.bottom,
        left: position.left,
        width: position.width,
        height: 16,
        cursor: 'ns-resize',
        zIndex: 1001,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          width: 50,
          height: 4,
          backgroundColor: isResizing ? '#1890ff' : '#bfbfbf',
          borderRadius: 2,
          transition: 'background-color 0.2s',
        }}
      />
    </div>
  );
};

export default ResizableModalWrapper;
