// Draggable wrapper for Ant Design modals
// Allows moving modal windows within the browser viewport

import React, { useEffect, useRef, useState } from 'react';

interface DraggableModalWrapperProps {
  children: React.ReactElement;
  /** Controls reset of position when modal closes */
  open?: boolean;
  /** Optional inner padding for viewport bounds */
  boundaryPadding?: number;
}

export const DraggableModalWrapper: React.FC<DraggableModalWrapperProps> = ({
  children,
  open = true,
  boundaryPadding = 16,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef({ x: 0, y: 0 });
  const listenersRef = useRef<{ move?: (event: MouseEvent) => void; up?: (event: MouseEvent) => void }>({});
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!open) {
      positionRef.current = { x: 0, y: 0 };
      setPosition({ x: 0, y: 0 });
    }
  }, [open]);

  useEffect(
    () => () => {
      const { move, up } = listenersRef.current;
      if (move) {
        document.removeEventListener('mousemove', move);
      }
      if (up) {
        document.removeEventListener('mouseup', up);
      }
    },
    []
  );

  const clampPosition = (nextX: number, nextY: number, deltaX: number, deltaY: number) => {
    const modalElement = containerRef.current?.querySelector('.ant-modal') as HTMLElement | null;
    if (!modalElement) {
      return { x: nextX, y: nextY };
    }

    const rect = modalElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = nextX;
    let adjustedY = nextY;

    const newLeft = rect.left + deltaX;
    const newRight = rect.right + deltaX;
    const newTop = rect.top + deltaY;
    const newBottom = rect.bottom + deltaY;

    if (newLeft < boundaryPadding) {
      adjustedX += boundaryPadding - newLeft;
    }
    if (newRight > viewportWidth - boundaryPadding) {
      adjustedX -= newRight - (viewportWidth - boundaryPadding);
    }
    if (newTop < boundaryPadding) {
      adjustedY += boundaryPadding - newTop;
    }
    if (newBottom > viewportHeight - boundaryPadding) {
      adjustedY -= newBottom - (viewportHeight - boundaryPadding);
    }

    return { x: adjustedX, y: adjustedY };
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const interactiveSelectors = ['input', 'textarea', 'button', 'select', '.ant-select', '.ant-picker', '.ant-input-number'];
    if (interactiveSelectors.some((selector) => target.closest(selector))) {
      return;
    }

    const draggableArea = target.closest(
      '.ant-modal-header, .ant-modal-confirm-title, .ant-modal-confirm-body, .ant-card-head'
    );
    if (!draggableArea) {
      return;
    }

    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const initialX = positionRef.current.x;
    const initialY = positionRef.current.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let nextX = initialX + deltaX;
      let nextY = initialY + deltaY;

      const { x, y } = clampPosition(nextX, nextY, nextX - positionRef.current.x, nextY - positionRef.current.y);
      nextX = x;
      nextY = y;

      positionRef.current = { x: nextX, y: nextY };
      setPosition({ x: nextX, y: nextY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      listenersRef.current = {};
    };

    listenersRef.current = { move: handleMouseMove, up: handleMouseUp };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      ref={containerRef}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        cursor: 'move',
      }}
      onMouseDown={handleMouseDown}
    >
      {children}
    </div>
  );
};
