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
    expect(show).toContain('pollIntervalMs: ORDER_DETAIL_STATUS_REFRESH_MS');
    expect(show).toContain("column.key === 'cut_job'");
    expect(show).toContain("column.key === 'bath_cut_job'");
    expect(show).toContain('return row?.[liveVersionKey] !== previousRow?.[liveVersionKey]');
    expect(show).toContain('const orderShowDetailsDataSource = useMemo(() => {');
    expect(show).toContain("useStableOrderShowColumns(\n    renderedDetailColumns,\n    'order-show-live-cells-v2',");
    expect(show).toContain('}), [runtime, runtimeVersion, structureKey]);');

    const hook = readFileSync('src/pages/orders/useCutDetailLastReady.ts', 'utf8');
    expect(hook).toContain('window.setInterval(refreshWhenVisible, pollIntervalMs)');
    expect(hook).toContain("useAuthCacheNamespace('cut-detail-last-ready')");
    expect(hook).toContain('readScopeKeyRef.current !== requestKey');
    expect(hook).toContain('cutJobMaps.scopeKey === readScopeKey');
    expect(hook).toContain('current.scopeKey === requestKey');
    expect(hook).toContain('areCutJobLinkMapsEqual(current, nextMaps)');
    expect(hook).toContain('Keep last ready versions visible; focus/event/poll can recover.');
  });

  it('auth-scopes show cut and CNC automatic reads', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    expect(show).toContain('useOrderAsyncReadGuard(`order-show:');
    expect(show).toContain('useOrderAsyncReadGuard(\n    `order-show-bath-jobs:');
    expect(show).toContain('bathCutJobsState?.scopeKey === bathCutJobsScopeKey');
    expect(show).toContain('bathCutJobsReadGuard.isCurrent(token)');
    expect(show).toContain('cutOrderJobsState?.scopeKey === showAsyncReadScopeKey');
    expect(show).toContain('cncOrderCuttingSequencesState?.scopeKey === showAsyncReadScopeKey');
    expect(show).toMatch(/cutApi\.listPlacements[\s\S]*showAsyncReadGuard\.isCurrent\(token\)/);
    expect(show).toMatch(/cncTelegramApi\.orderCuttingSequences[\s\S]*showAsyncReadGuard\.isCurrent\(token\)/);
    expect(show).toContain('legacyBazisMembershipState?.scopeKey === showAsyncReadScopeKey');
    expect(show).toMatch(/bazisCutApi\.orderMemberships[\s\S]*showAsyncReadGuard\.isCurrent\(token\)/);
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
    expect(show).toContain('setLiveDetailProductionStatusState({');
    expect(show).toContain('value: nextLiveStatuses');
    expect(show).toContain("document.addEventListener('visibilitychange'");
    expect(show).toContain("resource: \"production_statuses\"");
    expect(show).toContain('canViewProductionReferences');
    expect(show).not.toContain('refetch: refetchDetails');

    const statusCellStart = show.indexOf('const OrderDetailProductionStatusTag');
    const statusCellEnd = show.indexOf('function createProjectMoveIdempotencyKey');
    const statusCell = show.slice(statusCellStart, statusCellEnd);
    expect(statusCell).toContain('title={text}');
    expect(statusCell).not.toContain('<Tooltip');
    expect(statusCell).not.toContain('<Tag');
  });

  it('keeps the order show detail production status column narrow', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    const columnStart = show.indexOf("title: 'Статус',\n      dataIndex: 'production_status_id'");
    const columnEnd = show.indexOf("...(cutColumnEnabled", columnStart);
    const statusColumn = show.slice(columnStart, columnEnd);

    expect(statusColumn).toContain('width: 60');
    expect(statusColumn).toContain("align: 'center'");
    expect(show).toContain('const ORDER_DETAIL_STATUS_BADGE_STYLE');
    expect(show).toContain('fitOrderDetailStatusFontSize');
    expect(show).toContain('getOrderDetailStatusBadgeStyle');
    expect(show).toContain("whiteSpace: 'nowrap'");
    expect(show).toContain("overflowWrap: 'normal'");
    expect(show).toContain("wordBreak: 'normal'");
  });

  it('keeps requested order show detail columns compact', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    expect(show).toContain('const ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH = 48.6');
    expect(show).toContain('const ORDER_DETAIL_SHOW_QUANTITY_COLUMN_WIDTH = 42.525');
    expect(show).toContain('const ORDER_DETAIL_SHOW_EDGE_COLUMN_WIDTH = 45.9');
    expect(show).toContain('const ORDER_DETAIL_SHOW_NOTE_COLUMN_WIDTH = 96');
    expect(show).toContain('const ORDER_DETAIL_SHOW_DETAIL_COST_COLUMN_WIDTH = 81.25');
    expect(show).toContain('const ORDER_DETAIL_SHOW_BASIS_PROJECT_COLUMN_WIDTH = 96');
    expect(show).toContain('width: ORDER_DETAIL_SHOW_DIMENSION_COLUMN_WIDTH');
    expect(show).toContain('width: ORDER_DETAIL_SHOW_QUANTITY_COLUMN_WIDTH');
    expect(show).toContain('width: ORDER_DETAIL_SHOW_EDGE_COLUMN_WIDTH');
    expect(show).toContain('width: ORDER_DETAIL_SHOW_NOTE_COLUMN_WIDTH');
    expect(show).toContain('width: ORDER_DETAIL_SHOW_DETAIL_COST_COLUMN_WIDTH');
    expect(show).toContain('width: ORDER_DETAIL_SHOW_BASIS_PROJECT_COLUMN_WIDTH');
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
