import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const boardSource = readFileSync(resolve(__dirname, 'CalendarBoard.tsx'), 'utf8');
const menuSource = readFileSync(resolve(__dirname, 'DayContextMenu.tsx'), 'utf8');
const columnSource = readFileSync(resolve(__dirname, 'DayColumn.tsx'), 'utf8');

describe('calendar day header context menu', () => {
  it('uses the shared compact menu classes and a vertical menu without inline mode', () => {
    expect(menuSource).toContain('compact?: boolean');
    expect(menuSource).toContain("'calendar-context-menu'");
    expect(menuSource).toContain("compact ? 'calendar-context-menu--compact' : ''");
    expect(menuSource).toContain('mode="vertical"');
    expect(menuSource).not.toContain('mode="inline"');
    expect(menuSource).toContain("e.key === 'Escape'");
    expect(menuSource).toContain('Отправить в чат');
  });

  it('keeps separate state and the shared positioning helper in the board', () => {
    expect(boardSource).toContain('const [dayMenu, setDayMenu]');
    expect(boardSource).toContain('<DayContextMenu');
    expect(boardSource).toContain('compact={dayMenu.compact}');
    expect(boardSource).toContain("const dayMenuAvailable = !packerMode && calendarSendSupport === 'supported'");
    expect(boardSource).toContain('onDayContextMenu={dayMenuAvailable ? handleDayContextMenu : undefined}');
    expect(boardSource).toContain('formatDateForApi(date)');
  });

  it('opens on header click and right click, without hijacking interactive children', () => {
    expect(columnSource).toContain('onClick={onDayContextMenu ? handleHeaderClick : undefined}');
    expect(columnSource).toContain('onContextMenu={onDayContextMenu ? handleHeaderContextMenu : undefined}');
    expect(columnSource).toContain("closest('button, a, input, [role=\"button\"]')");
    expect(columnSource).not.toContain('onTouchStart');
    expect(columnSource).not.toContain('onTouchEnd');
    const briefIndex = columnSource.indexOf('viewMode === ViewMode.BRIEF');
    expect(briefIndex).toBeGreaterThan(-1);
    expect(columnSource.indexOf('handleHeaderClick : undefined')).toBeGreaterThan(briefIndex);
  });

  it('has a header send icon that does not open the menu and ignores repeats in flight', () => {
    expect(columnSource).toContain('onDaySend ?');
    expect(columnSource).toContain('aria-label="Отправить в чат"');
    expect(columnSource).toContain('aria-disabled={daySending}');
    expect(columnSource).toContain('e.stopPropagation();');
    expect(columnSource).toContain('if (!daySending && onDaySend) onDaySend(date);');
    expect(columnSource).toContain("from '../../../ui/tooltipDelay'");
    expect(boardSource).toContain('onDaySend={dayMenuAvailable ?');
    expect(boardSource).toContain('daySending={sendingDays.has(formatDateForApi(day))}');
    expect(boardSource).toContain('if (sendingDaysRef.current.has(date)) return;');
  });
});
