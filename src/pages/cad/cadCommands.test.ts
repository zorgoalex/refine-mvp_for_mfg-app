import { describe, expect, it, vi } from 'vitest';
import { filterCommands, findShortcut, shortcutMatches, type CadCommand } from './cadCommands';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
const cmd = (id: string, label: string, extra: Partial<CadCommand> = {}): CadCommand => ({ id, group: 'Правка', label, enabled: true, run: vi.fn(), ...extra });

describe('CAD command registry', () => {
  it('matches shortcuts with exact modifiers; Cmd counts as Ctrl', () => {
    expect(shortcutMatches('Ctrl+G', key('g', { ctrlKey: true }))).toBe(true);
    expect(shortcutMatches('Ctrl+G', key('g', { metaKey: true }))).toBe(true);
    expect(shortcutMatches('Ctrl+G', key('G', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(shortcutMatches('Ctrl+Shift+G', key('G', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shortcutMatches('L', key('l'))).toBe(true);
    expect(shortcutMatches('L', key('l', { ctrlKey: true }))).toBe(false);
    expect(shortcutMatches(undefined, key('l'))).toBe(false);
  });

  it('finds the command bound to a key, including disabled ones (the caller decides)', () => {
    const commands = [cmd('undo', 'Отменить', { keys: 'Ctrl+Z' }), cmd('redo', 'Повторить', { keys: 'Ctrl+Shift+Z', enabled: false })];
    expect(findShortcut(commands, key('z', { ctrlKey: true }))?.id).toBe('undo');
    expect(findShortcut(commands, key('Z', { ctrlKey: true, shiftKey: true }))?.id).toBe('redo');
    expect(findShortcut(commands, key('y', { ctrlKey: true }))).toBeUndefined();
  });

  it('filters by every word across label, group and terms; label prefix ranks first; ё = е', () => {
    const commands = [
      cmd('unlink', 'Разъединить перемещение'),
      cmd('link', 'Связать перемещение', { terms: 'объединить группа' }),
      cmd('layout', 'Разложить по позициям'),
      cmd('export', 'Скачать фрезеровки', { group: 'Вариант', terms: 'выгрузка' }),
    ];
    expect(filterCommands(commands, '').map(c => c.id)).toEqual(['unlink', 'link', 'layout', 'export']);
    expect(filterCommands(commands, 'перемещ').map(c => c.id)).toEqual(['unlink', 'link']);
    expect(filterCommands(commands, 'объедин').map(c => c.id)).toEqual(['link']);
    expect(filterCommands(commands, 'вариант выгр').map(c => c.id)).toEqual(['export']);
    expect(filterCommands(commands, 'раз').map(c => c.id)).toEqual(['unlink', 'layout']);
    expect(filterCommands([cmd('x', 'Ёлка')], 'елка').map(c => c.id)).toEqual(['x']);
    expect(filterCommands(commands, 'по пози').map(c => c.id)).toEqual(['layout']);
  });
});
