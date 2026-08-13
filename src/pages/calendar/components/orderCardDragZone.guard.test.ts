import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const orderCard = readFileSync(resolve(__dirname, 'OrderCard.tsx'), 'utf8');
const compactOrderCard = readFileSync(resolve(__dirname, 'OrderCardCompact.tsx'), 'utf8');
const calendarBoard = readFileSync(resolve(__dirname, 'CalendarBoard.tsx'), 'utf8');
const dragLayer = readFileSync(resolve(__dirname, 'CalendarOrderDragLayer.tsx'), 'utf8');
const calendarCss = readFileSync(resolve(__dirname, '../styles/calendar.css'), 'utf8');
const tabletCss = readFileSync(resolve(__dirname, '../../../ui-evolution/styles/tablet.css'), 'utf8');

describe('calendar order card drag zone', () => {
  it('does not render or style a separate drag handle', () => {
    expect(orderCard).not.toContain('calendar-order-card__drag-handle');
    expect(compactOrderCard).not.toContain('calendar-order-card__drag-handle');
    expect(calendarCss).not.toContain('calendar-order-card__drag-handle');
    expect(tabletCss).not.toContain('calendar-order-card__drag-handle');
  });

  it('uses the card root as the drag source in both display modes', () => {
    expect(orderCard).not.toContain('dragFromHandleOnly');
    expect(compactOrderCard).not.toContain('dragFromHandleOnly');
    expect(orderCard).toMatch(/const setCardRef = \(node: HTMLDivElement \| null\) => \{[\s\S]*dragRef\(node\);[\s\S]*\};/);
    expect(compactOrderCard).toMatch(/const setCardRef = \(node: HTMLDivElement \| null\) => \{[\s\S]*dragRef\(node\);[\s\S]*\};/);
  });

  it('does not reserve card width for the removed handle', () => {
    expect(calendarCss).not.toContain('padding-right: 48px');
    expect(tabletCss).not.toContain('padding-right: 52px');
  });

  it('renders a tablet drag outline without adding a drag handle', () => {
    expect(calendarBoard).toContain("import CalendarOrderDragLayer from './CalendarOrderDragLayer'");
    expect(calendarBoard).toContain('<CalendarOrderDragLayer enabled={isTabletLayout} />');
    expect(orderCard).toContain('preview: buildCalendarOrderDragPreview(order, sourceDate, cardNodeRef.current)');
    expect(compactOrderCard).toContain('preview: buildCalendarOrderDragPreview(order, sourceDate, cardNodeRef.current)');

    expect(dragLayer).toContain('useDragLayer');
    expect(dragLayer).toContain('monitor.getClientOffset()');
    expect(dragLayer).toContain('createPortal');
    expect(dragLayer).toContain('data-testid="calendar-order-drag-outline"');
    expect(dragLayer).toContain('itemType !== DRAG_TYPE');

    expect(calendarCss).toContain('.calendar-order-drag-outline');
    expect(calendarCss).toContain('pointer-events: none;');
    expect(calendarCss).toContain('transition-property: opacity, box-shadow;');
    expect(calendarCss).not.toContain('transition: all');
    expect(tabletCss).toMatch(/\.evolution-shell--tablet \.order-card--dragging \{[\s\S]*opacity: 0\.58;/);
  });
});
