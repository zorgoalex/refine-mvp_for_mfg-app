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

  it('lists the details already reserved into the job (job.items), not only the eligible pool', () => {
    // The reopened-job surface must render the reserved cut_job_item rows so a
    // selection staged from Orders "Добавить в раскрой" is visible; otherwise the
    // job looks empty and only the candidate-pool button shows.
    expect(source).toContain('Детали задания');
    expect(source).toContain('jobItemColumns');
    expect(source).toContain('dataSource={job.items}');
    // The reserved details are removable on the same job (release reservation).
    expect(source).toContain('cutApi.removeItem');
    expect(source).toContain('Убрать');
  });

  it('shows the full per-detail order fields (position + names), never price/sum', () => {
    // Position number + resolved dictionary names mirror the order form's detail.
    expect(source).toContain('detailNumber');
    expect(source).toContain('materialName');
    expect(source).toContain('millingTypeName');
    expect(source).toContain('edgeTypeName');
    expect(source).toContain('productionStatusName');
    // The /cut surface is production-facing: detail price/sum must not leak.
    expect(source).not.toContain('detailCost');
    expect(source).not.toContain('millingCostPerSqm');
  });

  it('opens a job on row double-click', () => {
    expect(source).toContain('onDoubleClick');
  });

  it('opens the order in an in-app workspace tab (not a new browser tab)', () => {
    // Use Refine navigation push (keep-alive tab) for the order number; not a
    // react-router Link with target="_blank".
    expect(source).toContain("show('orders_view', r.orderId, 'push')");
    expect(source).not.toContain('react-router-dom');
  });

  it('fail-closes detail file links against javascript:/data: stored-link XSS', () => {
    // Operator-clickable detail links must be sanitized; a raw href is never
    // rendered directly into an anchor on this cut.view surface.
    expect(source).toContain('safeHttpHref');
    expect(source).not.toMatch(/href=\{href as string\}/);
  });

  it('prefills the eligible-load criteria with the reserved orders when opening a job', () => {
    // Opening a job must scope "Загрузить подходящие детали" to the order(s) the
    // job was built from, not scan every order. Source of truth = reserved items.
    expect(source).toContain('distinctOrderIdsFromItems');
    expect(source).toContain('form.setFieldsValue');
  });

  it('auto-loads small per-sheet layout previews for a ready job', () => {
    // Ready jobs show an inline thumbnail per sheet (light 'thumb' preset),
    // fetched automatically, click-to-enlarge.
    expect(source).toContain("job.status !== 'ready'");
    expect(source).toContain('loadThumb');
    expect(source).toContain("'thumb'");
    expect(source).toContain('sheetThumbs');
  });

  it('resets previews on recalculate and revokes blob URLs (no stale preview, no leak)', () => {
    // Recalculate must clear thumbs+ref via the shared reset (otherwise a stale
    // preview survives the dedupe), and blob URLs must be revoked on reset,
    // overwrite, and unmount — /cut stays mounted (keep-alive) so leaks accrue.
    expect(source).toContain('resetSheetViews');
    expect(source).toContain('URL.revokeObjectURL');
    const calc = source.slice(source.indexOf('const calculate'));
    const body = calc.slice(0, calc.indexOf('}, [job'));
    expect(body).toContain('resetSheetViews()');
    // create switches job context -> must also reset/revoke prior previews.
    const create = source.slice(source.indexOf('const createJob'));
    expect(create.slice(0, create.indexOf('}, [form')).includes('resetSheetViews()')).toBe(true);
    // In-flight sheet/thumb fetches are generation-gated: a late completion after
    // a job switch/reset is discarded, never repopulating cleared maps.
    expect(source).toContain('viewEpochRef');
    expect(source).toContain('viewEpochRef.current !== epoch');
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

  it('INELIGIBLE_LABELS covers not_cuttable so a non-cuttable detail shows a human label, not raw text (critic R4 MAJOR)', () => {
    // The label map must include all four ineligibility reasons so no raw reason key
    // leaks into the UI when the backend returns not_cuttable for a non-cuttable sheet type.
    expect(source).toContain("not_cuttable:");
    // The label value must be a non-empty Russian string.
    const match = source.match(/not_cuttable:\s*['"]([^'"]+)['"]/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeGreaterThan(2);
  });
});
