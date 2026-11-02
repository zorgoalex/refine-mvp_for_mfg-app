import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workbenchPhoneLayout } from '../../pages/calendar/utils/workbenchCalendar';

const mobileCss = readFileSync('src/ui-evolution/styles/workbench-mobile.css', 'utf8');

describe('NewLine phone (~400 CSS px portrait): two columns, a narrow orders list', () => {
  it('calendar: two days across the screen; one only when a half would be under 150px', () => {
    expect(workbenchPhoneLayout(402, 32, 16)).toEqual({ columnWidth: 177, columnsPerRow: 2 });
    expect(workbenchPhoneLayout(360, 32, 16)).toEqual({ columnWidth: 156, columnsPerRow: 2 });
    expect(workbenchPhoneLayout(320, 32, 16)).toEqual({ columnWidth: 288, columnsPerRow: 1 });
    const board = readFileSync('src/pages/calendar/components/CalendarBoard.tsx', 'utf8');
    expect(board).toContain('return workbenchPhoneLayout(containerWidth, LAYOUT_CONFIG.CONTAINER_PADDING, LAYOUT_CONFIG.COLUMN_GAP);');
    expect(mobileCss).toMatch(/\.evolution-shell--wb-phone \.day-column \{\s*min-width: 0;/);
  });

  it('boards (MDF, statuses): two columns per screen', () => {
    expect(mobileCss).toContain('width: calc(50cqw - 16px) !important;');
    expect(mobileCss).toContain('grid-auto-columns: calc(50cqw - 16px) !important;');
    expect(mobileCss).not.toContain('calc(100cqw - 24px)');
  });

  it('orders «Список»: no actions column, a half-width order column, double tap opens the order', () => {
    const list = readFileSync('src/pages/orders/list.tsx', 'utf8');
    expect(list).toContain(".filter((column) => column.key !== 'actions')");
    expect(list).toContain("(column.key === 'order_name' ? { ...column, width: 56 } : column)");
    expect(list).toContain('if (last && last.orderId === record.order_id && now - last.at < 500) {');
    expect(list).toContain('columns={(groupedListRows ? groupedListColumns : phoneListColumns ?? visibleOrderListColumns) as any}');
  });

  it('calendar: scrolls down inside the grid (not clipped), standard cards by default', () => {
    expect(mobileCss).toMatch(/\.evolution-shell--wb-phone \.calendar-grid \{[^}]*overflow-x: hidden;\s*overflow-y: auto;/);
    const board = readFileSync('src/pages/calendar/components/CalendarBoard.tsx', 'utf8');
    expect(board).toContain('responsive.isMobile && !isWorkbench ? ViewMode.BRIEF : ViewMode.STANDARD,');
  });

  it('order card: no customer screen on a phone, wide tables scroll inside, materials keep their columns', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    const form = readFileSync('src/pages/orders/components/OrderForm.tsx', 'utf8');
    expect(show).toContain('const clientScreenControl = record?.order_id && !deletedOrder && !isMobile ? (');
    expect(form).toContain('const clientScreenControl = isMobile ? null : (');
    expect(mobileCss).toMatch(/\.order-show-page--workbench \.ant-table-content \{\s*overflow-x: auto;/);
    expect(mobileCss).toMatch(/\.order-show-page--workbench \.wb-materials__table \{\s*min-width: 600px;/);
  });

  it('bottom bar returns to the open tab of a section with its search (MDF board ?q=)', () => {
    const bar = readFileSync('src/ui-evolution/shell/WorkbenchMobileTabBar.tsx', 'utf8');
    expect(bar).toContain('navigate(workbenchMobileTabTarget(tab.route, useTabStore.getState().tabs));');
  });
});
