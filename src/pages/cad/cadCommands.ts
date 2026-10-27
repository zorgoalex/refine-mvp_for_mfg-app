/** One definition per CAD command: palette, toolbar and shortcuts read the same entry. */
export interface CadCommand {
  id: string; group: string; label: string;
  /** Display form, e.g. `Ctrl+Shift+G`; also parsed for keyboard matching. */
  keys?: string;
  enabled: boolean; run: () => void;
  /** Extra search words (synonyms) that are not shown. */
  terms?: string;
}

interface KeyEventLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

/** Ctrl and Cmd are the same modifier: CAD users switch between Windows and macOS. */
export function shortcutMatches(keys: string | undefined, event: KeyEventLike): boolean {
  if (!keys) return false;
  const parts = keys.split('+').map(p => p.trim().toLowerCase());
  const key = parts.at(-1)!, mods = new Set(parts.slice(0, -1));
  const wanted = key === 'del' ? 'delete' : key;
  return normalize(event.key) === wanted && (event.ctrlKey || event.metaKey) === mods.has('ctrl')
    && event.shiftKey === mods.has('shift') && event.altKey === mods.has('alt');
}

/** Every query word must occur in the label, group or terms; label prefix hits rank first. */
export function filterCommands(commands: CadCommand[], query: string): CadCommand[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  return commands
    .map((command, index) => {
      const label = normalize(command.label), haystack = `${label} ${normalize(command.group)} ${normalize(command.terms ?? '')}`;
      if (!words.every(w => haystack.includes(w))) return null;
      const rank = label.startsWith(words[0]) ? 0 : label.split(/\s+/).some(w => w.startsWith(words[0])) ? 1 : 2;
      return { command, rank, index };
    })
    .filter((v): v is { command: CadCommand; rank: number; index: number } => v !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(v => v.command);
}

/** Inputs keep their own keys: Delete or Ctrl+Z inside a field never edits the drawing. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || Boolean(target.closest('[role=combobox],[role=dialog]'));
}

export function findShortcut(commands: CadCommand[], event: KeyEventLike): CadCommand | undefined {
  return commands.find(c => shortcutMatches(c.keys, event));
}
