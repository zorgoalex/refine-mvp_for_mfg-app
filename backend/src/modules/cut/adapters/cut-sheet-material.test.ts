import { describe, expect, it } from 'vitest';
import { CutSheetMaterialNotCuttableError } from '../errors/cut.errors';
import { CUT_AUDIT_EVENTS } from '../application/cut-audit';
import { sheetMaterialChangedOutboxKey } from './pg-cut-repository';

describe('sheet-material override foundation', () => {
  it('error maps to 422 with stable code', () => {
    const e = new CutSheetMaterialNotCuttableError(42);
    expect(e.statusCode).toBe(422);
    expect(e.code).toBe('CUT_SHEET_MATERIAL_NOT_CUTTABLE');
    expect(e.details).toMatchObject({ sheetMaterialTypeId: 42 });
  });

  it('audit event name is stable', () => {
    expect(CUT_AUDIT_EVENTS.sheetMaterialChanged).toBe('cut_job.sheet_material_changed');
  });

  it('outbox key is stable per (job, request) and falls back to version', () => {
    expect(sheetMaterialChangedOutboxKey(7, 'req-1', 3)).toBe('cut_job.sheet_material_changed:7:req-1');
    expect(sheetMaterialChangedOutboxKey(7, undefined, 3)).toBe('cut_job.sheet_material_changed:7:v3');
  });
});
