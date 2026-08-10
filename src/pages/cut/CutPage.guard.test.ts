import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-text guards (vitest env=node, no jsdom): assert the /cut page stays a
// backend-owned, no-Hasura-write surface (CLAUDE.md principle 2/3) and keeps the
// no_sheet_spec onboarding signal (plan §5).
const source = readFileSync(fileURLToPath(new URL('./CutPage.tsx', import.meta.url)), 'utf8');
const pdfPreviewSource = readFileSync(fileURLToPath(new URL('./CutPdfPreview.tsx', import.meta.url)), 'utf8');
const sheetLabelSource = readFileSync(fileURLToPath(new URL('./CutSheetLabelGenerateAction.tsx', import.meta.url)), 'utf8');
const appCss = readFileSync(fileURLToPath(new URL('../../styles/app.css', import.meta.url)), 'utf8');
const pdfTemplateEventsSource = readFileSync(fileURLToPath(new URL('../../api/cutPdfTemplateEvents.ts', import.meta.url)), 'utf8');

describe('CutPage source guards', () => {
  it('keeps manual-editor zoom controls in the sticky group navbar', () => {
    expect(source).toMatch(/sticky-editor-zoom-controls/);
    expect(source).toMatch(/MinusOutlined/);
    expect(source).toMatch(/PlusOutlined/);
    expect(source).toMatch(/viewZoom=\{editorViewZoom\}/);
  });
  it('drives every command/read through cutApi, never Hasura', () => {
    expect(source).toContain("from '../../api/cutApi'");
    expect(source).not.toMatch(/hasura/i);
    expect(source).not.toMatch(/graphql/i);
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('renders PDF preview through PDF.js instead of Chrome PDF Viewer iframe', () => {
    expect(source).toContain("import { CutPdfPreview } from './CutPdfPreview'");
    expect(source).toContain('<CutPdfPreview blob={pdfPreview.blob} loading={pdfPreview.loading} />');
    expect(source).not.toContain('<iframe');
    expect(pdfPreviewSource).toContain("import('pdfjs-dist')");
    expect(pdfPreviewSource).toContain('pdf.worker.min.mjs');
    expect(pdfPreviewSource).toContain('cut-pdf-preview-pages');
    expect(pdfPreviewSource).not.toContain('<iframe');
    expect(pdfPreviewSource).not.toContain('<object');
    expect(pdfPreviewSource).not.toContain('<embed');
  });

  it('keeps a direct print action in the PDF preview modal', () => {
    expect(source).toContain('const printPreviewPdf = useCallback');
    expect(source).toContain("window.open('', '_blank')");
    expect(source).toContain('URL.createObjectURL(pdfPreview.blob)');
    expect(source).toContain('data-testid="print-preview-pdf-btn"');
    expect(source).toContain('onClick={printPreviewPdf}');
    expect(source).toContain('<PrinterOutlined />');
  });

  it('keeps zoom controls in the PDF.js preview', () => {
    expect(pdfPreviewSource).toContain('CUT_PDF_PREVIEW_MIN_ZOOM = 50');
    expect(pdfPreviewSource).toContain('CUT_PDF_PREVIEW_MAX_ZOOM = 250');
    expect(pdfPreviewSource).toContain('CUT_PDF_PREVIEW_ZOOM_STEP = 25');
    expect(pdfPreviewSource).toContain('const [zoomPercent, setZoomPercent] = useState(CUT_PDF_PREVIEW_DEFAULT_ZOOM)');
    expect(pdfPreviewSource).toContain('data-testid="cut-pdf-preview-zoom-out"');
    expect(pdfPreviewSource).toContain('data-testid="cut-pdf-preview-zoom-reset"');
    expect(pdfPreviewSource).toContain('data-testid="cut-pdf-preview-zoom-in"');
    expect(pdfPreviewSource).toContain('width: `${zoomPercent}%`');
  });

  it('surfaces the no_sheet_spec count to the operator', () => {
    expect(source).toContain('noSheetSpecMessage');
    expect(source).toContain('noSheetSpecCount');
  });

  it('gates mutations behind cut.manage', () => {
    expect(source).toContain("can('cut.manage')");
    expect(source).toContain("can('cut.view')");
  });

  it('uses a stable React element key for sheet previews (decoupled from the cache key) to avoid scroll-jump on re-render', () => {
    // elemKey is per (group, sheet) — NOT the renderVersion-bearing cache key — so a
    // version bump (profile/material change) refreshes in place instead of remounting.
    expect(source).toContain('const elemKey = `${group.cutGroupId}:${sheet.sheetIndex}`');
    expect(source).toContain('key={elemKey}');
    // Thumbnail container reserves height so a reload does not collapse the row.
    expect(source).toMatch(/minHeight:\s*Math\.round\(basis/);
  });

  it('per-sheet button toggles Развернуть/Свернуть and collapses an opened sheet', () => {
    expect(source).toContain("'Свернуть' : 'Развернуть'");
    expect(source).toMatch(/sheetImages\[key\]\s*\?\s*collapseSheet\(key\)/);
  });

  it('editor sheet orientation matches the preview (per-sheet sheetPreviewRotate90, not raw !sheetPortrait)', () => {
    // The SheetEditor landscape prop derives from the working sheet dims via the
    // same helper the preview uses, so a landscape sheet opens landscape in the editor.
    expect(source).toMatch(/landscape=\{\(\(\) => \{[\s\S]*sheetPreviewRotate90\(\s*p\.sheet_width_mm/);
  });

  it('enables vacuum-bath meter guides from the shared eligibility contract', () => {
    expect(source).toMatch(/shouldShowBathMeterGuides\(\{/);
    expect(source).toMatch(/engineUsed:\s*group\.summary\?\.engine_used/);
    expect(source).toMatch(/materialName:\s*sheetOption\?\.name/);
    expect(source).toMatch(/materialWidthMm:\s*sheetOption\?\.widthMm/);
    expect(source).toMatch(/materialHeightMm:\s*sheetOption\?\.heightMm/);
    expect(source).toMatch(/showBathMeterGuides=\{showBathMeterGuides\}/);
  });

  it('group header is sticky, offset below the workspace tab-bar, opaque in both themes', () => {
    expect(source).toMatch(/headStyle=\{\{[\s\S]*position:\s*'sticky'[\s\S]*top:\s*stickyHeaderTop/);
    // theme-aware background so the sticky header is opaque in light and dark.
    expect(source).toContain('background: token.colorBgContainer');
    // offset is measured from the global sticky workspace tab-bar (not hard-coded 0).
    expect(source).toContain(".querySelector('.workspace-tabs')");
    expect(source).toMatch(/ResizeObserver/);
    // handles the LATE mount of the tab-bar (WorkspaceTabs renders null until the
    // tab opens) so the offset is not stuck at 0 on a cold load.
    expect(source).toMatch(/MutationObserver/);
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
    expect(source).toContain('OrderDeletedTag');
    expect(source).toContain('orderDeleted={r.orderDeleted}');
    expect(source).toContain('orderDeletedReferenceClassName');
    expect(appCss).toContain('.ant-table-tbody > tr.order-deleted-reference-row > td');
    expect(source).not.toContain('react-router-dom');
  });

  it('fail-closes detail file links against javascript:/data: stored-link XSS', () => {
    // Operator-clickable detail links must be sanitized; a raw href is never
    // rendered directly into an anchor on this cut.view surface.
    expect(source).toContain('safeHttpHref');
    expect(source).not.toMatch(/href=\{href as string\}/);
  });

  it('prefills the criteria fields from reserved job details when opening a job', () => {
    // Opening a job must show the operator the job's own order numbers, films,
    // and sheet materials, even when the date-filter option lists are empty.
    expect(source).toContain('cutJobOrderOptions');
    expect(source).toContain('cutJobFilmOptions');
    expect(source).toContain('cutJobSheetTypeOptions');
    expect(source).toContain('visibleOrderOptions');
    expect(source).toContain('visibleFilmOptions');
    expect(source).toContain('visibleSheetTypeOptions');
    expect(source).toContain('openedJob.name');
    expect(source).toContain('form.setFieldsValue');
  });

  it('filters cut creation orders by the current-date range by default', () => {
    expect(source).toContain('defaultCutOrderDateRange');
    expect(source).toContain('return [now, now]');
    expect(source).toContain('orderDateRange');
    expect(source).toContain('cutDateRangeToCriteria');
    expect(source).toContain('ordersApi.list');
    expect(source).toContain('dateFrom');
    expect(source).toContain('dateTo');
    expect(source).toContain('data-testid="cut-order-date-range"');
    expect(source).toContain('data-testid="cut-order-select"');
  });

  it('refreshes PDF template options when the job or group template selector opens', () => {
    expect(source).toContain('refreshCutConfigOnPdfTemplateOpen');
    expect(source).toContain('subscribeCutPdfTemplatesChanged');
    expect(source.match(/onDropdownVisibleChange=\{refreshCutConfigOnPdfTemplateOpen\}/g)).toHaveLength(2);
    expect(source).toContain('data-testid="pdf-template-select-job"');
    expect(source).toContain('data-testid={`pdf-template-select-${group.cutGroupId}`}');
    expect(pdfTemplateEventsSource).toContain('notifyCutPdfTemplatesChanged');
    expect(pdfTemplateEventsSource).toContain('CustomEvent');
    expect(pdfTemplateEventsSource).toContain('BroadcastChannel');
    expect(pdfTemplateEventsSource).toContain('CUT_PDF_TEMPLATE_CHANGED_STORAGE_KEY');
  });

  it('loads the cut film filter as unique Select options under the current date criteria', () => {
    expect(source).toContain('cutApi.listFilmOptions');
    expect(source).toContain('filmOptions');
    expect(source).toContain('buildCutFilmOption');
    expect(source).toContain('data-testid="cut-film-select"');
    expect(source).toContain('form.setFieldsValue({ filmIds: undefined })');
    expect(source).not.toContain('<Input placeholder="Плёнки"');
  });

  it('previews selected cut details before creating the job', () => {
    expect(source).toContain('listEligibleDetailsPreview');
    expect(source).toContain('isCreationPreview');
    expect(source).toContain('Проверка деталей перед созданием');
    expect(source).toContain('Подбор деталей на раскрой');
    expect(source).toContain('data-testid="cut-create-preview-details"');
    expect(source).toContain('createJobFromPreview');
    expect(source).toContain('detailIds: selected');
  });

  it('keeps the create-preview detail table compact and shows grouped plus total summaries', () => {
    expect(source).toContain('CUT_DETAIL_PREVIEW_VISIBLE_ROWS = 20');
    expect(source).toContain('CUT_DETAIL_PREVIEW_ROW_HEIGHT = 20');
    expect(source).toContain('CUT_DETAIL_PREVIEW_TABLE_BODY_HEIGHT');
    expect(source).toContain('eligibleTableScrollX');
    expect(source).toContain('cutDetailColumnWidth(rows');
    expect(source).toContain('buildCutPreviewSummary(eligible ?? [])');
    expect(source).toContain('buildCutPreviewSummary');
    expect(source).toContain('data-testid="cut-create-preview-summary"');
    expect(source).not.toContain('Table.Summary');
    expect(source).toContain('cut-create-preview-order-tint-${tint}');
    expect(source).toContain('cut-create-preview-row-ineligible');
    expect(source).toContain('cutDetailExistingJobsText');
    expect(source).toContain('cutJobRefProfileLabel');
    expect(source).toContain("title: 'Уже в раскроях'");
    expect(source).toContain('Итого по плёнкам и материалам');
    expect(source).toContain('Итого по всем деталям в выборке');
    expect(source).toContain('formatCutPreviewSummaryMetrics');
    expect(source).toContain('area * quantity');
    expect(appCss).toContain('.cut-create-preview-summary');
    expect(appCss).toContain('.cut-create-preview-details-table .ant-table-tbody > tr > td');
    expect(appCss).toContain('height: 20px');
    expect(appCss).toContain('.cut-create-preview-row-ineligible');
    expect(appCss).toContain('.cut-create-preview-details-table .ant-table-tbody > tr.cut-create-preview-order-tint-0 > td');
  });

  it('orders create-preview detail columns for fast scanning', () => {
    const eligibleColumnsSource = source.slice(
      source.indexOf('const eligibleColumns'),
      source.indexOf('const jobItemColumns'),
    );
    const areaIndex = eligibleColumnsSource.indexOf("title: 'Площадь'");
    const filmIndex = eligibleColumnsSource.indexOf("title: 'Плёнка'");
    const materialIndex = eligibleColumnsSource.indexOf("title: 'Материал'");
    const millingIndex = eligibleColumnsSource.indexOf("title: 'Фрезеровка'");
    const nameIndex = eligibleColumnsSource.indexOf("title: 'Наименование'");

    expect(areaIndex).toBeGreaterThanOrEqual(0);
    expect(filmIndex).toBeGreaterThan(areaIndex);
    expect(materialIndex).toBeGreaterThan(filmIndex);
    expect(millingIndex).toBeGreaterThan(materialIndex);
    expect(nameIndex).toBeGreaterThan(millingIndex);
  });

  it('keeps reopened job details under the spoiler compact with a 15-row internal scroll', () => {
    expect(source).toContain('CUT_JOB_DETAILS_VISIBLE_ROWS = 15');
    expect(source).toContain('CUT_JOB_DETAILS_TABLE_BODY_HEIGHT');
    expect(source).toContain('scroll={{ x: 1900, y: CUT_JOB_DETAILS_TABLE_BODY_HEIGHT }}');
    expect(source).toContain('cutJobItemOrderTintByOrderId(job?.items ?? [])');
    expect(source).toContain('className="cut-job-details-table details-grouped"');
    expect(source).toContain('detail-group-tint-${jobItemOrderTintByOrderId.get(row.orderId) ?? 0}');
  });

  it('shows the acting non-archived cut result first and hides full history under a spoiler', () => {
    expect(source).toContain('const primaryCutResult = job?.currentCutResult');
    expect(source).toContain('?? jobCutResults.find((result) => !result.isArchived)');
    expect(source).toContain('className="cut-results-latest-table"');
    expect(source).toContain('dataSource={primaryCutResult ? [primaryCutResult] : []}');
    expect(source).toContain('className="cut-results-history-collapse"');
    expect(source).toContain('Все сохранённые раскрои (${jobCutResults.length})');
    expect(source).toContain('Сделать действующим');
    expect(source).toContain('В архив');
    expect(source).toContain('Вернуть');
    expect(source).toContain('Действующий');
    expect(source).not.toContain('<Card size="small" title="Выполненные раскрои"');
  });

  it('allows renaming the opened cut job from the job card title', () => {
    expect(source).toContain('data-testid="cut-job-name-edit"');
    expect(source).toContain('data-testid="cut-job-name-input"');
    expect(source).toContain('data-testid="cut-job-name-save"');
    expect(source).toContain('cutApi.setName(job.cutJobId, name, job.version)');
    expect(source).toContain("message.warning('Введите название задания на раскрой')");
    expect(appCss).toContain('.cut-job-card-name');
    expect(appCss).toContain('.cut-job-name-editor');
    expect(appCss).toContain('.cut-results-block');
  });

  it('suggests the cut job name from unique orders, films, and current date', () => {
    expect(source).toContain('buildSuggestedCutName');
    expect(source).toContain('раскрой ${orders.length');
    expect(source).toContain('films.length > 0 ? films.join');
    expect(source).toContain("now.format('DD.MM.YYYY')");
    expect(source).toContain('data-testid="cut-preview-name"');
  });

  it('supports embedded order mode: hard-scopes criteria and job list to one order', () => {
    expect(source).toContain('embeddedOrderId');
    expect(source).toContain('isEmbeddedOrder ? [embeddedOrderId!] : parseOrderIdsValue(values.orderIds)');
    expect(source).toContain("cutApi.listPlacements({ orderIds: [embeddedOrderId!] })");
    expect(source).toContain('embeddedJobIds?.has(candidate.cutJobId)');
    expect(source).toContain('candidate.items?.some((item) => item.orderId === embeddedOrderId)');
    expect(source).toContain('<Form.Item name="orderIds" hidden>');
    expect(source).toContain('{!isEmbeddedOrder && !isOperational && <Title level={3}>Раскрой</Title>}');
    expect(source).toContain('isOperational && !isEmbeddedOrder');
  });

  it('refreshes the job list when the kept-alive /cut tab path changes or deep-link opens a job', () => {
    // A cut job can be created from an order while /cut is mounted but hidden.
    // When the user opens /cut later, the list must refetch; otherwise the new
    // job is visible only after browser refresh.
    expect(source).toContain('lastListRefreshPathRef');
    expect(source).toMatch(/if \(cutTabPath === lastListRefreshPathRef\.current\) return/);
    expect(source).toMatch(/lastListRefreshPathRef\.current = cutTabPath/);
    expect(source).toMatch(/void loadJobs\(\)/);

    const openJob = source.slice(source.indexOf('const openJob = useCallback'));
    const openJobBody = openJob.slice(0, openJob.indexOf('}, [form'));
    expect(openJobBody).toContain('void loadJobs()');
  });

  it('auto-loads small per-sheet layout previews for a ready job', () => {
    // Ready jobs show an inline thumbnail per sheet (light 'thumb' preset),
    // fetched automatically, click-to-enlarge.
    expect(source).toContain("job.status !== 'ready'");
    expect(source).toContain('loadThumb');
    expect(source).toContain("'thumb'");
    expect(source).toContain('sheetThumbs');
  });

  it('mounts per-sheet label generation actions on the common preview path for every cut profile', () => {
    const previewLoopStart = source.indexOf('{previewSheets.map((sheet, sheetPos) => {');
    expect(previewLoopStart).toBeGreaterThan(-1);
    const labelActionStart = source.indexOf('<CutSheetLabelGenerateAction', previewLoopStart);
    expect(labelActionStart).toBeGreaterThan(previewLoopStart);
    const labelActionSource = source.slice(previewLoopStart, source.indexOf('{sheetThumbs[key]', labelActionStart));

    expect(source).toContain('CutSheetLabelGenerateAction');
    expect(source).toContain('detailIdsForSheet');
    expect(source).toContain('sheet.placements.pieces');
    expect(labelActionSource).toContain('const sheetDetailIds = detailIdsForSheet(sheet)');
    expect(labelActionSource).toContain('<CutSheetLabelGenerateAction');
    expect(labelActionSource).toContain('detailIds={sheetDetailIds}');
    expect(labelActionSource).toContain('cutGroupId={group.cutGroupId}');
    expect(labelActionSource).toContain('sheetIndex={sheet.sheetIndex}');
    expect(labelActionSource).not.toMatch(/layout_mode\s*===\s*'vacuum_table'|engine_used\s*===\s*'vacuum_table'/);
    expect(sheetLabelSource).toContain('Бирки');
    expect(sheetLabelSource).toContain('labelsApi.previewDetailLabels');
    expect(sheetLabelSource).toContain('labelsApi.generateDetailLabels');
    expect(sheetLabelSource).toContain('printLabelSvgPages');
    expect(sheetLabelSource).toContain('const runPrint = async () =>');
    expect(sheetLabelSource).toContain('Скачать ZIP');
    // Operator picks the export file formats via checkboxes (bmp/png/emf).
    expect(sheetLabelSource).toContain('Форматы файлов бирок');
    expect(sheetLabelSource).toContain('Checkbox.Group');
    expect(sheetLabelSource).toContain('EXPORT_FORMAT_OPTIONS');
  });

  it('stacks portrait sheet preview title and actions into full-width blocks', () => {
    expect(source).toContain('isPortraitPreview');
    expect(source).toContain('cut-sheet-preview-header--portrait');
    expect(source).toContain('displayHeightMm > displayWidthMm');
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

  it('axis-origin radio: defaults bottom-left, resets previews, and threads the option everywhere', () => {
    const toggle = source.slice(source.indexOf('const changeSheetAxisOrigin'));
    const body = toggle.slice(0, toggle.indexOf('],'));
    expect(body).toContain('saveSheetAxisOrigin');
    expect(body).toContain('resetSheetViews()');
    expect(source).toContain("useState<CutAxisOrigin>('bottom-left')");
    expect(source).toContain('<Radio.Button value="bottom-left" aria-label="Точка отсчёта слева снизу">');
    expect(source).toContain('<Radio.Button value="top-left" aria-label="Точка отсчёта слева сверху">');
    expect(source).toContain('<SheetOriginIcon axisOrigin="bottom-left" />');
    expect(source).toContain('<SheetOriginIcon axisOrigin="top-left" />');
    expect(source).toContain('<Radio.Button value={true} aria-label="Книжная ориентация">');
    expect(source).toContain('<Radio.Button value={false} aria-label="Альбомная ориентация">');
    expect(source).toContain('axisOrigin={sheetAxisOrigin}');
    expect(source).toContain('buildSheetPieceOverlays(sheet.placements, job.items, rotate90, originTopLeft, sheetAxisOrigin)');
    expect(source).toContain('renderVersion, originTopLeft, sheetAxisOrigin');
    // Legacy layout transform remains independent from the new display-axis option.
    expect(source).toContain("placements?.coordinate_contract === 'native_portrait_v1' ? false : legacyOriginTopLeft");
    // Editor rotate decision aligned with the preview (sheetPreviewRotate90), not bare !sheetPortrait.
    expect(source).not.toContain('landscape={!sheetPortrait}');
    // Both independent origin dimensions participate in local blob cache keys.
    expect(source).toContain("${sheetOriginTopLeft ? 'tl' : 'raw'}");
    expect(source).toContain('${sheetAxisOrigin}');
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

describe('CutPage profile + totals columns (source guard)', () => {
  it('renames the positions column and adds totals/profile/sheets columns', () => {
    expect(source).toContain("title: 'Позиции'");
    expect(source).toContain("title: 'Заказы'");
    expect(source).toContain('distinctOrderIdsFromItems(row.items).length');
    expect(source).toContain('<span>Заказы: <b>{distinctOrderIdsFromItems(job.items).length}</b></span>');
    expect(source).toContain("title: 'Деталей'");
    expect(source).toContain("title: isOperational ? 'Площадь, м²' : 'Площадь, итого'");
    expect(source).toContain("title: isOperational ? 'Листы' : 'Кол-во листов раскроя'");
    expect(source).toContain("className: 'cut-jobs-name-cell'");
    expect(appCss).toContain('td.cut-jobs-name-cell');
    expect(appCss).toContain('text-align: left !important');
    expect(source).toContain('width: 63');
    expect(source).toContain('width: 56');
    expect(source).toContain('width: 84');
    expect(source).toContain("title: 'Профиль'");
    expect(source).toContain("title: isOperational ? 'Материал' : 'Материал деталей'");
    expect(source).toContain('formatJobMaterialNames(row.materialNames)');
    expect(source).toContain("width: '20ch'");
    expect(source).toContain('CUT_JOBS_TABLE_CONTAINER_HEIGHT');
    expect(source).toContain('const CUT_JOBS_TABLE_CONTAINER_HEIGHT = 317');
    expect(source).toContain('className="cut-jobs-table-container"');
    expect(source).toContain('maxHeight: CUT_JOBS_TABLE_CONTAINER_HEIGHT');
    expect(source).not.toContain('scroll={{ y: CUT_JOBS_TABLE_SCROLL_Y }}');
    expect(source).toContain('pagination={false}');
    expect(source).toContain('className="cut-jobs-table"');
    expect(source).toContain('className="cut-job-materials-cell"');
    expect(source).not.toContain("title: 'Детали'");
  });
  it('wires the profile selector to setProfile', () => {
    expect(source).toContain('cutApi.setProfile');
  });
});

describe('CutPage per-job profile selector tooltip wiring (source guard)', () => {
  it('imports describeCutProfile from cutProfileHelpers', () => {
    expect(source).toMatch(/import.*describeCutProfile.*from.*cutProfileHelpers/);
  });

  it('wraps each option label in a Tooltip with describeCutProfile as title', () => {
    // The Select options must use describeCutProfile inside a Tooltip for hover explanation.
    expect(source).toContain('describeCutProfile');
    // Each option label must be a Tooltip node (not a plain string).
    // The pattern: label: (<Tooltip title={describeCutProfile(...)}>
    expect(source).toMatch(/label:\s*\(<Tooltip\s+title=\{describeCutProfile\(/);
  });

  it('tooltip title uses p.params (the profile params object)', () => {
    // describeCutProfile must receive the profile params, not an arbitrary string.
    expect(source).toMatch(/describeCutProfile\(p\.params\)/);
  });

  it('chosenInactive option also gets a Tooltip via describeCutProfile', () => {
    // The disabled inactive option must also show a tooltip (not just active options).
    // Source must contain describeCutProfile for the chosenInactive branch — either via
    // a shared helper or explicit call. The simplest check: describeCutProfile appears
    // more than once, OR the inactive profile lookup feeds into describeCutProfile.
    // We check that the profile params are looked up for the inactive case.
    expect(source).toMatch(/chosenProfile\.params|chosenInactiveProfile\.params|\.find\(.*params/s);
  });
});
