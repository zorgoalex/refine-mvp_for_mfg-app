import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./SheetEditor.tsx', import.meta.url), 'utf8');
describe('SheetEditor source contract', () => {
  it('exports SheetEditor and uses the geometry module for snap/rotate/orient', () => {
    expect(src).toMatch(/export function SheetEditor/);
    expect(src).toMatch(/snapDraggedPiece/);
    expect(src).toMatch(/rotatePiece/);
    expect(src).toMatch(/orientPieceRect/);
  });
  it('does not import testing-library or jsdom', () => {
    expect(src).not.toMatch(/@testing-library|jsdom/);
  });
  it('renders an svg and calls onChange', () => {
    expect(src).toMatch(/<svg/);
    expect(src).toMatch(/onChange\(/);
  });
  it('uses scale-aware snap threshold (SNAP_THRESHOLD_PX) and captures guide lines (guideXmm)', () => {
    expect(src).toMatch(/SNAP_THRESHOLD_PX/);
    expect(src).toMatch(/guideXmm/);
  });
});
