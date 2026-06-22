import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-text guards (vitest env=node, no jsdom): assert the /cut page stays a
// backend-owned, no-Hasura-write surface (CLAUDE.md principle 2/3) and keeps the
// no_sheet_spec onboarding signal (plan §5).
const source = readFileSync(fileURLToPath(new URL('./CutPage.tsx', import.meta.url)), 'utf8');

describe('CutPage source guards', () => {
  it('drives every command/read through cutApi, never Hasura', () => {
    expect(source).toContain("from '../../api/cutApi'");
    expect(source).not.toMatch(/hasura/i);
    expect(source).not.toMatch(/graphql/i);
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('surfaces the no_sheet_spec count to the operator', () => {
    expect(source).toContain('noSheetSpecMessage');
    expect(source).toContain('noSheetSpecCount');
  });

  it('gates mutations behind cut.manage', () => {
    expect(source).toContain("can('cut.manage')");
    expect(source).toContain("can('cut.view')");
  });

  it('explains a failed cut instead of a bare status: Alert + reason + retry', () => {
    // Durable failure reason shown prominently (Alert) and on the list tag (Tooltip).
    expect(source).toContain('job.failureReason');
    expect(source).toContain('row.failureReason');
    expect(source).toContain('Tooltip');
    // A failed job is recoverable on the same job: the action re-labels to retry.
    expect(source).toContain('Повторить расчёт');
  });

  it('refreshes the job after a failed calculate so the reason + fresh version show', () => {
    // The calculate catch must reload the job (persisted reason + bumped version),
    // otherwise the Alert never renders and a retry would 409 on a stale version.
    const calc = source.slice(source.indexOf('const calculate'));
    const body = calc.slice(0, calc.indexOf('}, [job'));
    expect(body).toMatch(/catch[\s\S]*cutApi\.get\(/);
  });

  it('Variant B: cut filter sends sheetMaterialTypeIds (not materialIds)', () => {
    // Post-034 the filter key is sheetMaterialTypeIds; materialIds must not be sent.
    expect(source).toContain('sheetMaterialTypeIds');
    expect(source).not.toContain('materialIds');
  });

  it('Variant B: cut filter does NOT depend on useBackendOrdersWrite or sheet_materials.* perms', () => {
    // The /cut page is gated on cut.view/cut.manage only (Critic R22 B3).
    // It must never check orders-write or catalog-level sheet perms.
    expect(source).not.toContain('useBackendOrdersWrite');
    expect(source).not.toMatch(/can\(['"]sheet_materials/);
  });

  // Variant B Task 11: sheet filter is a Select driven by useCutSheetTypeOptions (not a CSV Input).
  it('Variant B Task 11: imports and uses useCutSheetTypeOptions for the sheet filter Select', () => {
    expect(source).toContain('useCutSheetTypeOptions');
    expect(source).toContain('sheetFilterEnabled');
    expect(source).toContain('sheetTypeOptions');
    // The filter must use a Select (not a raw Input for sheet types).
    expect(source).toContain('cut-sheet-type-filter');
    // Must NOT directly call the sheet-materials catalog API from the cut page.
    expect(source).not.toContain('sheetMaterialsApi');
    expect(source).not.toContain('/sheet-material-types');
  });

  it('Variant B Task 11: sheetMaterialTypeIds from form are forwarded as number[] (Select), not CSV string', () => {
    // criteriaFromForm must handle number[] from the Select (not parseIdCsv for sheet types).
    expect(source).toContain('sheetMaterialTypeIds');
    // The array handling must be present (not relying on parseIdCsv for sheet types).
    expect(source).toContain('values.sheetMaterialTypeIds');
  });
});
