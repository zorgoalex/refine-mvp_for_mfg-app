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

  it('prefills the eligible-load criteria with the reserved orders when opening a job', () => {
    // Opening a job must scope "Загрузить подходящие детали" to the order(s) the
    // job was built from, not scan every order. Source of truth = reserved items.
    expect(source).toContain('distinctOrderIdsFromItems');
    expect(source).toContain('form.setFieldsValue');
  });

  it('refreshes the job after a failed calculate so the reason + fresh version show', () => {
    // The calculate catch must reload the job (persisted reason + bumped version),
    // otherwise the Alert never renders and a retry would 409 on a stale version.
    const calc = source.slice(source.indexOf('const calculate'));
    const body = calc.slice(0, calc.indexOf('}, [job'));
    expect(body).toMatch(/catch[\s\S]*cutApi\.get\(/);
  });
});
