import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const orderCard = readFileSync(resolve(__dirname, 'OrderCard.tsx'), 'utf8');
const compactOrderCard = readFileSync(resolve(__dirname, 'OrderCardCompact.tsx'), 'utf8');
const calendarCss = readFileSync(resolve(__dirname, '../styles/calendar.css'), 'utf8');

describe('calendar order card drag zone', () => {
  it('does not render or style a separate drag handle', () => {
    expect(orderCard).not.toContain('calendar-order-card__drag-handle');
    expect(compactOrderCard).not.toContain('calendar-order-card__drag-handle');
    expect(calendarCss).not.toContain('calendar-order-card__drag-handle');
  });

  it('uses the card root as the drag source in both display modes', () => {
    expect(orderCard).not.toContain('dragFromHandleOnly');
    expect(compactOrderCard).not.toContain('dragFromHandleOnly');
    expect(orderCard).toMatch(/const setCardRef = \(node: HTMLDivElement \| null\) => \{[\s\S]*dragRef\(node\);[\s\S]*\};/);
    expect(compactOrderCard).toMatch(/const setCardRef = \(node: HTMLDivElement \| null\) => \{[\s\S]*dragRef\(node\);[\s\S]*\};/);
  });

  it('does not reserve card width for the removed handle', () => {
    expect(calendarCss).not.toContain('padding-right: 48px');
  });
});
