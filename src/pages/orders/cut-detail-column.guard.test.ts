import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('cut detail column', () => {
  it('order show page exposes the cut.view-gated Раскрой deep-link column', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    expect(show).toContain("title: 'Раскрой'");
    expect(show).toContain('cutJobDeepLink');
    expect(show).toContain("can('cut.view')");
  });

  it('CutPage gates every open-job mutate affordance on isArchivedJob', () => {
    const src = readFileSync('src/pages/cut/CutPage.tsx', 'utf8');
    expect(src).toContain("const isArchivedJob = job?.status === 'archived'");
    expect(src).toContain('parseJobQueryParam');
    // Each of the FOUR mutate `disabled` conditions must reference isArchivedJob
    // verbatim. Dropping any single guard fails this test (a weak occurrence
    // count would miss a real guard removed + a stray mention added elsewhere).
    // Keep these strings in sync with Step 6 if the conditions change.
    const requiredDisabled = [
      "disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}", // profile Select
      'disabled={!canManage || selected.length === 0 || isArchivedJob}',                 // Добавить выбранные
      'disabled={!canManage || job.items.length === 0 || isArchivedJob}',                // Рассчитать
      'disabled={busy || isArchivedJob}',                                                // per-item Убрать
    ];
    for (const fragment of requiredDisabled) {
      expect(src, `missing archived guard: ${fragment}`).toContain(fragment);
    }
    // jobItemColumns useMemo must depend on isArchivedJob so the remove button
    // re-renders disabled when the open job is archived.
    expect(src).toMatch(/\[busy, canManage, isArchivedJob, removeJobItem, show\]/);

    // Deep-link must read the /cut tab path REACTIVELY from the tab store (not
    // window.location once), so a deep-link clicked while /cut is already mounted
    // still reopens the job (workspace keeps /cut alive keyed by pathname).
    expect(src).toContain("useTabStore((s) => s.tabs.find((t) => t.key === '/cut')?.path)");
    // CutPage must stay free of react-router-dom (orders open via workspace tabs).
    expect(src).not.toContain('react-router-dom');

    // TDZ guard: openJob must be declared BEFORE the deep-link effect that
    // references it. A regression (effect before const) crashes every render with
    // ReferenceError but is invisible to tsc/build.
    const openJobIdx = src.indexOf('const openJob = useCallback');
    const deepLinkIdx = src.indexOf('parseJobQueryParam(');
    expect(openJobIdx).toBeGreaterThan(-1);
    expect(deepLinkIdx).toBeGreaterThan(-1);
    // openJob must be declared BEFORE the effect that depends on it (TDZ guard)
    expect(openJobIdx).toBeLessThan(deepLinkIdx);
  });
});
