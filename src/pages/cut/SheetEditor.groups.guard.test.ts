import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./SheetEditor.tsx', import.meta.url), 'utf8');

describe('SheetEditor grouping source guard', () => {
  it('treats Shift+pointer-down as selection-only and does not start a drag', () => {
    expect(src).toMatch(/e\.shiftKey/);
    expect(src).toMatch(/togglePieceOrGroupSelection\(sheetIndex,\s*pieceId\);\s*return;/);
  });

  it('exposes stable group and ungroup context-menu keys with the required labels', () => {
    expect(src).toMatch(/key:\s*'group'/);
    expect(src).toMatch(/label:\s*'Группировать'/);
    expect(src).toMatch(/key:\s*'ungroup'/);
    expect(src).toMatch(/label:\s*'Разгруппировать'/);
  });

  it('stores dragged group members in DragState for preview and commit', () => {
    expect(src).toMatch(/members:\s*DragMember\[]/);
    expect(src).toMatch(/drag\.members\.some/);
    expect(src).toMatch(/members:\s*dragPieces\.map/);
  });

  it('imports and uses rotateGroup90 and pruneIncoherentGroups from pieceGrouping', () => {
    expect(src).toMatch(/rotateGroup90/);
    expect(src).toMatch(/pruneIncoherentGroups/);
    expect(src).toMatch(/setPieceGroups\(\(current\)\s*=>\s*pruneIncoherentGroups\(current,\s*sheets\)\)/);
  });

  it('renders grouped pieces with the violet grouped stroke color', () => {
    expect(src).toMatch(/'#722ed1'/);
    expect(src).toMatch(/strokeDasharray/);
  });
});

describe('selection reconciliation on sheets change (Critic R1)', () => {
  it('selection is intersected with real pieces on one sheet when sheets change', () => {
    expect(src).toMatch(/selection must never feed group creation/);
    expect(src).toMatch(/setSelectedKeys\(new Set<string>\(\)\)/);
  });
  it('group creation requires >= 2 surviving keys', () => {
    expect(src).toMatch(/if \(groupKeys\.length >= 2\)/);
  });
});
