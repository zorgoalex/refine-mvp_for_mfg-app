import React from 'react';
import { createPortal } from 'react-dom';
import { useDragLayer } from 'react-dnd';
import type { DragItem } from '../types/calendar';
import { DRAG_TYPE } from './OrderCard';
import { buildCalendarOrderDragPreview } from './calendarDragPreview';

interface CalendarOrderDragLayerProps {
  enabled: boolean;
}

const VIEWPORT_PADDING = 8;
const POINTER_OFFSET = 14;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const CalendarOrderDragLayer: React.FC<CalendarOrderDragLayerProps> = ({ enabled }) => {
  const { isDragging, itemType, item, clientOffset } = useDragLayer((monitor) => ({
    isDragging: monitor.isDragging(),
    itemType: monitor.getItemType(),
    item: monitor.getItem() as DragItem | null,
    clientOffset: monitor.getClientOffset(),
  }));

  if (
    !enabled ||
    !isDragging ||
    itemType !== DRAG_TYPE ||
    !item?.order ||
    !clientOffset ||
    typeof document === 'undefined' ||
    typeof window === 'undefined'
  ) {
    return null;
  }

  const preview = item.preview ?? buildCalendarOrderDragPreview(item.order, item.sourceDate, null);
  const width = Math.min(preview.width, Math.max(136, window.innerWidth - VIEWPORT_PADDING * 2));
  const height = Math.min(preview.height, Math.max(52, Math.round(window.innerHeight * 0.32)));
  const left = clamp(
    clientOffset.x + POINTER_OFFSET,
    VIEWPORT_PADDING,
    Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
  );
  const top = clamp(
    clientOffset.y + POINTER_OFFSET,
    VIEWPORT_PADDING,
    Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING),
  );
  const style = {
    '--calendar-drag-bg': preview.backgroundColor,
    '--calendar-drag-border': preview.borderColor,
    height,
    left: Math.round(left),
    top: Math.round(top),
    width,
  } as React.CSSProperties;

  return createPortal(
    <div
      aria-hidden="true"
      className="calendar-order-drag-outline"
      data-testid="calendar-order-drag-outline"
      style={style}
    >
      <strong className="calendar-order-drag-outline__title">{preview.orderLabel}</strong>
      {preview.subtitle ? (
        <span className="calendar-order-drag-outline__subtitle">{preview.subtitle}</span>
      ) : null}
      {preview.meta ? (
        <span className="calendar-order-drag-outline__meta">{preview.meta}</span>
      ) : null}
    </div>,
    document.body,
  );
};

export default CalendarOrderDragLayer;
