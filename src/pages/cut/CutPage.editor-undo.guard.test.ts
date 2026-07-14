import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-text guards for the manual-editor undo + default zoom (2026-07-14).
 * Undo-stack behavior itself is unit-tested in editorHistory.test.ts; these
 * pin the CutPage wiring. Vitest env=node (no jsdom).
 */
const src = readFileSync(fileURLToPath(new URL('./CutPage.tsx', import.meta.url)), 'utf8');

describe('CutPage editor undo + default zoom guard', () => {
  it('editor opens at the minimum zoom (25%)', () => {
    expect(src).toMatch(/setEditorViewZoom\(MIN_EDITOR_VIEW_ZOOM\)/);
    expect(src).toMatch(/const MIN_EDITOR_VIEW_ZOOM = 0\.25/);
    // no unconditional reset back to 1 on editor open
    expect(src).not.toMatch(/setEditorViewZoom\(1\)/);
  });

  it('every committed gesture pushes a capped history snapshot', () => {
    expect(src).toMatch(/setEditorHistory\(\(h\) => pushHistory\(h, workingSheets\)\)/);
  });

  it('undo button lives in the sticky zoom navbar and disables with an empty history', () => {
    expect(src).toMatch(/undoEditorStep/);
    expect(src).toMatch(/data-testid="undo-edit-step-btn"/);
    expect(src).toMatch(/disabled=\{busy \|\| editorHistory\.length === 0\}/);
    expect(src).toMatch(/Отменить шаг/);
    // placement: inside the sticky editor controls (same navbar as zoom −/+),
    // so it stays visible while the operator scrolls the sheets.
    const stickyIdx = src.indexOf('data-testid="sticky-editor-zoom-controls"');
    const undoIdx = src.indexOf('data-testid="undo-edit-step-btn"');
    const zoomOutIdx = src.indexOf('Уменьшить масштаб группы раскроя');
    expect(stickyIdx).toBeGreaterThan(-1);
    expect(undoIdx).toBeGreaterThan(stickyIdx);
    expect(undoIdx).toBeLessThan(zoomOutIdx);
  });

  it('history resets on enter, cancel and save', () => {
    const resets = src.match(/setEditorHistory\(\[\]\)/g) ?? [];
    expect(resets.length).toBeGreaterThanOrEqual(4); // enter + cancel + save + job-refetch reset
  });

  it('a plain selection click never reaches onChange (no undo-slot burn)', () => {
    // Behavior of the predicate is unit-tested in editorHistory.test.ts;
    // here we pin that SheetEditor short-circuits handleUp with it BEFORE
    // the cross-sheet guard and onChange.
    const editorSrc = readFileSync(fileURLToPath(new URL('./SheetEditor.tsx', import.meta.url)), 'utf8');
    const noopIdx = editorSrc.indexOf('isNoopDrop({');
    const guardIdx = editorSrc.indexOf('Cross-sheet move guard');
    expect(noopIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(noopIdx).toBeLessThan(guardIdx);
  });
});
