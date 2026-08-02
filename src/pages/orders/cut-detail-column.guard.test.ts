import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('cut detail column', () => {
  it('order show page exposes the cut.view-gated Раскрой deep-link column', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    expect(show).toContain("title: 'Раскрой'");
    expect(show).toContain('cutJobDeepLink');
    expect(show).toContain("can('cut.view')");
    expect(show).toContain('useCutDetailLastReady');
    expect(show).toContain("title: 'Расчет ванны'");
    expect(show).toContain('bathCutJobByDetailId');
    expect(show).toContain('<CutJobVersionLines job={ref} />');
  });

  it('details table is horizontally scrollable with a synced top scrollbar', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    // Wrapped in the top-scrollbar helper + horizontal scroll enabled so the
    // wide details table is reachable without scrolling to the bottom.
    expect(show).toContain('<TableTopScroll');
    expect(show).toContain("scroll={{ x: 'max-content' }}");
  });

  it('order show page exposes a live detail production status column', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    expect(show).toContain("{ key: 'production_status_id', label: 'Статус' }");
    expect(show).toContain("title: 'Статус'");
    expect(show).toContain('OrderDetailProductionStatusTag');
    expect(show).toContain('productionStatusesById');
    expect(show).toContain('ORDER_DETAIL_STATUS_REFRESH_MS');
    expect(show).toContain('refreshLiveDetailProductionStatuses');
    expect(show).toContain('areDetailProductionStatusMapsEqual');
    expect(show).toContain('setLiveDetailProductionStatusById(nextLiveStatuses)');
    expect(show).toContain("document.addEventListener('visibilitychange'");
    expect(show).toContain("resource: \"production_statuses\"");
    expect(show).toContain('canViewProductionReferences');
    expect(show).not.toContain('refetch: refetchDetails');
  });

  it('summary row aligns with the selection column and the trailing Раскрой column', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    // rowSelection (cutSelectMode) prepends a checkbox column → `base`. «Раскрой»
    // is appended as the last entry of detailColumns (conditionally via cutColumnEnabled)
    // and flows through visibleDetailColumns.map, so no literal per-column indices needed.
    expect(show).toContain('const base = cutSelectMode ? 1 : 0');
    // leading checkbox summary cell only while selecting
    expect(show).toContain('{cutSelectMode && <Table.Summary.Cell index={0} />}');
    // Summary cells iterate visibleDetailColumns dynamically (Раскрой is the last
    // element of detailColumns when cutColumnEnabled, so it is included in the map).
    expect(show).toContain('visibleDetailColumns.map((column, index) =>');
    // Every cell uses base + dynamic loop index (base shifts by 1 for the checkbox column)
    expect(show).toContain('index={base + index}');
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
    expect(src).toMatch(/\[busy, canManage, isArchivedJob, jobBathCutJobByDetailId, openJob, removeJobItem, show\]/);
    expect(src).toContain('<CutJobVersionLines job={ref} />');

    // Deep-link must read the /cut tab path REACTIVELY from the tab store (not
    // window.location once), so a deep-link clicked while /cut is already mounted
    // still reopens the job (workspace keeps /cut alive keyed by pathname).
    expect(src).toContain("useTabStore((s) => s.tabs.find((t) => t.key === '/cut')?.path)");
    // CutPage must stay free of react-router-dom (orders open via workspace tabs).
    expect(src).not.toContain('react-router-dom');

    // openJob must be last-write-wins (epoch guard) so a stale in-flight cutApi.get
    // from a rapid deep-link (45 -> 46) cannot overwrite the UI with the older job.
    expect(src).toContain('const openSeqRef = useRef(0)');
    expect(src).toContain('if (openSeqRef.current !== seq) return');

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
