import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const notesCell = readFileSync(new URL('./PanelNotesCell.tsx', import.meta.url), 'utf8');

describe('PanelsTab derived/notes columns', () => {
  it('renders Кромка/Присадка/Примечания columns', () => {
    expect(panelsTab).toContain("title: 'Кромка'");
    expect(panelsTab).toContain("title: 'Присадка'");
    expect(panelsTab).toContain("title: 'Примечания'");
    expect(panelsTab).toContain('PanelNotesCell');
  });

  it('coerces rollout fields defensively', () => {
    expect(panelsTab).toContain('node.edgeCount ?? 0');
    expect(panelsTab).toContain('node.hasDrilling ?? false');
    expect(panelsTab).toContain('node.notes ?? null');
  });

  it('notes editor saves via backend command with one-shot close semantics', () => {
    expect(notesCell).toContain('bazisApi.setNodeNotes');
    expect(notesCell).toContain('stopPropagation');
    expect(notesCell).toContain('onPressEnter');
    expect(notesCell).toContain("event.key === 'Escape'");
    expect(notesCell).toContain('makeNotesEditorHandlers');
    expect(notesCell).toContain('normalizeNotesInput');
  });

  it('PanelsTab guards stale notes responses by a render-synchronous epoch', () => {
    expect(panelsTab).toContain('notesEpochRef');
    // бамп в useMemo (синхронно в рендере), НЕ в useEffect — иначе окно
    // в один render, где поздний PATCH прошлой ревизии проходит guard
    expect(panelsTab).toContain('const notesEpoch = useMemo(() => {');
    expect(panelsTab).toContain('notesEpochRef.current += 1;');
    expect(panelsTab).toContain('epoch={notesEpoch}');
    expect(panelsTab).toContain('shouldApplyNotesResponse');
  });

  it('summary row spans all 17 columns after the new Bazis project column', () => {
    expect(panelsTab).toContain('[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]');
    expect(panelsTab).not.toContain('[5, 6, 7, 8, 9, 10, 11, 12].map');
  });
});
