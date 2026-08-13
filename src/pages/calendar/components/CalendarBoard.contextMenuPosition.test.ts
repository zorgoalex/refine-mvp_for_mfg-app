import { describe, expect, it } from 'vitest';
import { resolveCalendarContextMenuPosition } from './CalendarBoard';

describe('resolveCalendarContextMenuPosition', () => {
  it('opens desktop submenus to the right when there is enough space', () => {
    expect(resolveCalendarContextMenuPosition(120, 80, 1200, 800, false)).toEqual({
      x: 120,
      y: 80,
      submenuDirection: 'right',
    });
  });

  it('opens desktop submenus to the left near the right edge', () => {
    expect(resolveCalendarContextMenuPosition(1120, 80, 1200, 800, false)).toEqual({
      x: 952,
      y: 80,
      submenuDirection: 'left',
    });
  });

  it('keeps compact phone/tablet menus in opposite half-panels', () => {
    expect(resolveCalendarContextMenuPosition(120, 80, 800, 800, true)).toEqual({
      x: 8,
      y: 80,
      submenuDirection: 'right',
    });
    expect(resolveCalendarContextMenuPosition(700, 80, 800, 800, true)).toEqual({
      x: 602,
      y: 80,
      submenuDirection: 'left',
    });
  });
});
