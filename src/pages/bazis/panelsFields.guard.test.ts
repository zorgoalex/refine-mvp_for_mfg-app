import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const notesCell = readFileSync(new URL('./PanelNotesCell.tsx', import.meta.url), 'utf8');

describe('PanelsTab derived/notes columns', () => {
  it('renders Кромка/Присадка/Фрезеровка/Плёнка/Краска/Примечания columns in order', () => {
    expect(panelsTab).toContain("title: 'Кромка'");
    expect(panelsTab).toContain("title: 'Присадка'");
    expect(panelsTab).toContain("title: 'Фрезеровка'");
    expect(panelsTab).toContain("title: 'Плёнка'");
    expect(panelsTab).toContain("title: 'Краска'");
    expect(panelsTab).toContain("title: 'Примечания'");
    expect(panelsTab).toContain('PanelNotesCell');
    const drillingIndex = panelsTab.indexOf("title: 'Присадка'");
    const millingIndex = panelsTab.indexOf("title: 'Фрезеровка'");
    const filmIndex = panelsTab.indexOf("title: 'Плёнка'");
    const paintIndex = panelsTab.indexOf("title: 'Краска'");
    expect(millingIndex).toBeGreaterThan(drillingIndex);
    expect(filmIndex).toBeGreaterThan(millingIndex);
    expect(paintIndex).toBeGreaterThan(filmIndex);
  });

  it('coerces rollout fields defensively', () => {
    expect(panelsTab).toContain('node.edgeCount ?? 0');
    expect(panelsTab).toContain('node.hasDrilling ?? false');
    expect(panelsTab).toContain('normalizeText(node.millingName)');
    expect(panelsTab).toContain('normalizeText(node.filmName)');
    expect(panelsTab).toContain('normalizeText(node.paintName)');
    expect(panelsTab).toContain('node.notes ?? null');
    expect(panelsTab).toContain('node.bazisCutSets ?? []');
  });

  it('renders linked Basis-cut set numbers as links after the ERP order column', () => {
    const orderIndex = panelsTab.indexOf("title: 'Заказ'");
    const cutSetIndex = panelsTab.indexOf("title: 'Базис-раскрой'");
    expect(cutSetIndex).toBeGreaterThan(orderIndex);
    expect(panelsTab).toContain('to={`/bazis-cut/${cutSet.bazisCutSetId}`}');
    expect(panelsTab).toContain('`БР-${cutSet.bazisCutSetId}`');
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

  it('summary row spans all 21 columns after the Basis-cut column', () => {
    expect(panelsTab).toContain('[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]');
    expect(panelsTab).not.toContain('[5, 6, 7, 8, 9, 10, 11, 12].map');
  });
});
