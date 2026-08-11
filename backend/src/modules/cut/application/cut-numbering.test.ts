import { describe, expect, it } from 'vitest';
import { cutJobSnapshotUsesVacuumTable, formatCutJobNumber, formatCutNumber } from './cut-numbering';

describe('cut-numbering', () => {
  it('formats regular and vacuum cut numbers', () => {
    expect(formatCutNumber(42, 3)).toBe('42-3');
    expect(formatCutNumber(42, 3, true)).toBe('В-42-3');
    expect(formatCutJobNumber(42, true)).toBe('В-42');
    expect(formatCutJobNumber(700, false, '12')).toBe('12');
    expect(formatCutNumber(700, 1, false, '12')).toBe('12-1');
    expect(formatCutNumber(700, 1, false, '  ')).toBe('700-1');
    expect(formatCutNumber(700, 1, true, 'В-12')).toBe('В-12-1');
  });

  it('detects vacuum-table frozen snapshots from group summaries', () => {
    expect(cutJobSnapshotUsesVacuumTable({
      groups: [{ cutGroupId: 1, sheetMaterialTypeId: null, filmId: null, status: 'ready', pdfTemplate: 'default', summary: { engine_used: 'vacuum_table' }, sheets: [] }],
    })).toBe(true);
    expect(cutJobSnapshotUsesVacuumTable({
      groups: [{ cutGroupId: 1, sheetMaterialTypeId: null, filmId: null, status: 'ready', pdfTemplate: 'default', summary: { engine_used: 'heuristic' }, sheets: [] }],
    })).toBe(false);
  });
});
