import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const boardSource = readFileSync(resolve(__dirname, 'CalendarBoard.tsx'), 'utf8');
const menuSource = readFileSync(resolve(__dirname, 'OrderContextMenu.tsx'), 'utf8');
const mobileCss = readFileSync(resolve(__dirname, '../styles/calendar-mobile.css'), 'utf8');

describe('calendar adaptive context menu', () => {
  it('uses popup submenus on every device instead of inline spoiler expansion', () => {
    expect(menuSource).toContain('compact?: boolean');
    expect(menuSource).toContain("submenuDirection?: 'right' | 'left'");
    expect(menuSource).toContain('mode="vertical"');
    expect(menuSource).toContain("triggerSubMenuAction={compact ? 'click' : 'hover'}");
    expect(menuSource).toContain('builtinPlacements={submenuPlacements}');
    expect(menuSource).toContain('const submenuPopupClassName');
    expect(menuSource).toContain('popupClassName: submenuPopupClassName');
    expect(menuSource).toContain('popupOffset: submenuPopupOffset');
    expect(menuSource).not.toContain('mode="inline"');
  });

  it('uses the compact half-width menu on phone and tablet', () => {
    expect(boardSource).toContain('useDeviceTier');
    expect(boardSource).toContain('isTabletTier');
    expect(boardSource).toContain('const compactContextMenu = isMobile || isTabletLayout');
    expect(boardSource).toContain('compact={contextMenu.compact}');
    expect(mobileCss).toContain('.calendar-context-menu--compact');
    expect(mobileCss).toContain('width: calc((100vw - 16px) / 2) !important;');
    expect(mobileCss).toContain('.calendar-context-submenu-popup--compact');
    expect(mobileCss).not.toContain('calendar-context-menu--mobile');
    expect(mobileCss).not.toContain('right: 8px !important');
    expect(mobileCss).not.toContain('width: auto !important');
  });

  it('chooses submenu side by available space near the card', () => {
    expect(boardSource).toContain('resolveCalendarContextMenuPosition');
    expect(boardSource).toContain('clientX + menuWidth + submenuWidth');
    expect(boardSource).toContain("opensRight ? 'right' : 'left'");
    expect(boardSource).toContain('submenuDirection: menuPosition.submenuDirection');
    expect(menuSource).toContain('calendar-context-menu--submenu-${submenuDirection}');
    expect(menuSource).toContain('CALENDAR_CONTEXT_SUBMENU_POPUP_CLASS}--${submenuDirection}');
    expect(mobileCss).toContain('.calendar-context-submenu-popup');
  });
});
