import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { CutSheetMaterialNotCuttableError } from '../errors/cut.errors';
import { CUT_AUDIT_EVENTS } from '../application/cut-audit';
import { sheetMaterialChangedOutboxKey, PgCutRepository } from './pg-cut-repository';

const anyUser: CurrentUser = {
  id: '1',
  username: 'tester',
  role: 'operator',
  permissions: ['cut.view'],
} as CurrentUser;

/** Build a PgCutRepository whose database.query returns the given rows for any query. */
function makeRepoWithRows(rows: Record<string, unknown>[]): PgCutRepository {
  const service = {
    query: (_text: string, _params?: readonly unknown[]) => Promise.resolve({ rows, rowCount: rows.length }),
    transaction: async <T>(fn: (c: DatabaseService) => Promise<T>) => fn(service as unknown as DatabaseService),
  } as unknown as DatabaseService;
  // freecut is not used by listSheetTypesForCut; pass a minimal stub.
  const freecutStub = { optimize: () => Promise.reject(new Error('not used')) } as never;
  return new PgCutRepository(service, freecutStub);
}

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

describe('listSheetTypesForCut', () => {
  it('returns materialTypeId and thicknessMm', async () => {
    const repo = makeRepoWithRows([
      { sheet_material_type_id: 1, name: 'ЛДСП 18 2800x2070', material_type_id: 5, thickness_mm: 18, width_mm: 2800, height_mm: 2070, is_cuttable: true },
    ]);
    const out = await repo.listSheetTypesForCut({ currentUser: anyUser });
    expect(out[0]).toMatchObject({
      sheetMaterialTypeId: 1,
      name: 'ЛДСП 18 2800x2070',
      materialTypeId: 5,
      thicknessMm: 18,
      widthMm: 2800,
      heightMm: 2070,
      isCuttable: true,
    });
  });
});
