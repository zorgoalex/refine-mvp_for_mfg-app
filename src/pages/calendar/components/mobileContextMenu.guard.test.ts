import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const boardSource = readFileSync(resolve(__dirname, 'CalendarBoard.tsx'), 'utf8');
const menuSource = readFileSync(resolve(__dirname, 'OrderContextMenu.tsx'), 'utf8');
const mobileCss = readFileSync(resolve(__dirname, '../styles/calendar-mobile.css'), 'utf8');

describe('calendar mobile context menu', () => {
  it('uses popup submenus on mobile instead of inline spoiler expansion', () => {
    expect(boardSource).toContain('mobile={isMobile}');
    expect(menuSource).toContain('mobile?: boolean');
    expect(menuSource).toContain("mode={mobile ? 'vertical' : 'inline'}");
    expect(menuSource).toContain("triggerSubMenuAction={mobile ? 'click' : 'hover'}");
    expect(menuSource).toContain("popupClassName: CALENDAR_CONTEXT_SUBMENU_POPUP_CLASS");
  });

  it('keeps the mobile root menu at half width and opens submenus to the right', () => {
    expect(boardSource).toContain('resolveCalendarContextMenuPosition');
    expect(boardSource).toContain('? CONTEXT_MENU_VIEWPORT_PADDING');
    expect(mobileCss).toContain('.calendar-context-menu--mobile');
    expect(mobileCss).toContain('width: calc((100vw - 16px) / 2) !important;');
    expect(mobileCss).toContain('.calendar-context-submenu-popup');
    expect(mobileCss).not.toContain('right: 8px !important');
    expect(mobileCss).not.toContain('width: auto !important');
  });
});
