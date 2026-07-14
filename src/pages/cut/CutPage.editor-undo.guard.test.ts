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

  it('undo button is wired and disabled with an empty history', () => {
    expect(src).toMatch(/undoEditorStep/);
    expect(src).toMatch(/data-testid="undo-edit-step-btn"/);
    expect(src).toMatch(/disabled=\{busy \|\| editorHistory\.length === 0\}/);
    expect(src).toMatch(/Отменить шаг/);
  });

  it('history resets on enter, cancel and save', () => {
    const resets = src.match(/setEditorHistory\(\[\]\)/g) ?? [];
    expect(resets.length).toBeGreaterThanOrEqual(4); // enter + cancel + save + job-refetch reset
  });
});
