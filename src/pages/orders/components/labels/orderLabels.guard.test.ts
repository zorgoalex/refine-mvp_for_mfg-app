import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const formSrc = readFileSync(new URL('../OrderForm.tsx', import.meta.url), 'utf8');
const showSrc = readFileSync(new URL('../../show.tsx', import.meta.url), 'utf8');
const dataEditorSrc = readFileSync(new URL('./OrderLabelDataEditor.tsx', import.meta.url), 'utf8');
const generateSrc = readFileSync(new URL('./OrderLabelGenerateAction.tsx', import.meta.url), 'utf8');
const configSrc = readFileSync(new URL('../../../configuration/components/LabelsConfigTab.tsx', import.meta.url), 'utf8');
const templateEventsSrc = readFileSync(new URL('../../../../api/labelTemplateEvents.ts', import.meta.url), 'utf8');
const latestSrc = readFileSync(new URL('./OrderLatestLabelsPreview.tsx', import.meta.url), 'utf8');
const previewFrameSrc = readFileSync(new URL('./LabelSvgPreviewFrame.tsx', import.meta.url), 'utf8');
const pagesViewerSrc = readFileSync(new URL('./OrderLabelPagesViewer.tsx', import.meta.url), 'utf8');
const printSrc = readFileSync(new URL('./labelPrint.ts', import.meta.url), 'utf8');

describe('order labels UI wiring', () => {
  it('mounts the edit label-data editor in Дополнительно behind labels flag and labels.view', () => {
    expect(formSrc).toMatch(/featureFlags\.labels/);
    expect(formSrc).toMatch(/can\('labels\.view'\)/);
    expect(formSrc).toMatch(/OrderLabelDataEditor/);
    expect(formSrc).toMatch(/isOrderDirty=\{isDirty/);
  });

  it('blocks preview, generation, and label-data save while the order draft is dirty', () => {
    expect(dataEditorSrc).toMatch(/isOrderDirty/);
    expect(dataEditorSrc).toMatch(/labelDataDirty/);
    expect(dataEditorSrc).toMatch(/dirtyDetailIds/);
    expect(dataEditorSrc).toMatch(/Сначала сохраните заказ/);
    expect(dataEditorSrc).toMatch(/Сначала сохраните данные бирок/);
    expect(dataEditorSrc).toMatch(/filter\(\(detail\) => dirtyDetailIds\.has\(detail\.detailId\)\)/);
    expect(generateSrc).toMatch(/isOrderDirty/);
    expect(dataEditorSrc).toMatch(/isOrderDirty \|\| labelDataDirty/);
    expect(generateSrc).toMatch(/disabled=\{[^}]*isOrderDirty/s);
  });

  it('mounts latest preview and generate action in order show additional panel with label permissions', () => {
    expect(showSrc).toMatch(/featureFlags\.labels/);
    expect(showSrc).toMatch(/canAny\(\['labels\.view', 'labels\.generate'\]\)/);
    expect(showSrc).toMatch(/OrderLatestLabelsPreview/);
    expect(latestSrc).toMatch(/OrderLabelGenerateAction/);
  });

  it('downloads a newly generated ZIP by generation id, not by latest export', () => {
    expect(generateSrc).toMatch(/labelsApi\.generateOrderLabels/);
    expect(generateSrc).toMatch(/labelsApi\.downloadGeneration\(orderId,\s*generation\.generationId\)/);
    expect(generateSrc).not.toMatch(/downloadLatest/);
    expect(generateSrc).toContain('useOrderAsyncReadGuard(`label-generate-write:${orderId}`)');
    expect(generateSrc).toContain('writeGuard.isSameResource(writeToken)');
    expect(latestSrc).toContain('readGuard.isSameResource(downloadToken)');
    expect(dataEditorSrc).toContain('readGuard.isSameResource(writeToken)');
  });

  it('generates the whole order even when modal preview is focused on one detail', () => {
    const generateStart = generateSrc.indexOf('const generation = await labelsApi.generateOrderLabels');
    const generateEnd = generateSrc.indexOf('const blob = await labelsApi.downloadGeneration', generateStart);
    const generateBlock = generateSrc.slice(generateStart, generateEnd);

    expect(generateBlock).toMatch(/previewToken: generationPreview\.previewToken/);
    expect(generateBlock).not.toMatch(/detailFilters/);
    expect(generateSrc).toMatch(/const generationPreview = await labelsApi\.previewOrderLabels\(orderId,\s*\{/);
  });

  it('latest block uses latest export only for show-page latest download', () => {
    expect(latestSrc).toMatch(/labelsApi\.downloadLatest\(orderId\)/);
    expect(latestSrc).toMatch(/onGenerated=\{loadLatest\}/);
  });

  it('keeps inactive templates reachable for saved label data but hidden from generation modals', () => {
    const generateTemplateOptions = generateSrc.slice(
      generateSrc.indexOf('options={templates.map((template) => ({'),
      generateSrc.indexOf('placeholder="Шаблон"', generateSrc.indexOf('options={templates.map((template) => ({')),
    );

    expect(dataEditorSrc).toMatch(/labelsApi\.listTemplates\(true\)/);
    expect(generateSrc).toMatch(/labelsApi\.listTemplates\(\)/);
    expect(generateSrc).toMatch(/next\.filter\(\(template\) => template\.isActive\)/);
    expect(dataEditorSrc).toMatch(/next\.find\(\(template\) => template\.isActive\)\?\.labelTemplateId/);
    expect(generateSrc).toMatch(/resolvePreferredLabelTemplateId/);
    expect(dataEditorSrc).toMatch(/\(архив\)/);
    expect(generateTemplateOptions).not.toMatch(/\(архив\)/);
  });

  it('remembers the last generated-label template per user', () => {
    expect(generateSrc).toMatch(/authSession\.getUser\(\)\?\.id \?\? 'anon'/);
    expect(generateSrc).toMatch(/resolvePreferredLabelTemplateId\(labelTemplatePreferenceUserId, activeTemplates\)/);
    expect(generateSrc).toMatch(/saveLabelTemplatePreference\(labelTemplatePreferenceUserId, value\)/);
  });

  it('shows the effective generated comment fallback before writing explicit overrides', () => {
    expect(dataEditorSrc).toMatch(/detail\.bazisFields\['bazis\.comment'\] \?\? detail\.note \?\? ''/);
  });

  it('previews one fitted label and can filter preview by clicked order detail', () => {
    expect(dataEditorSrc).toMatch(/selectedDetailId/);
    expect(dataEditorSrc).toMatch(/onRow=\{\(detail\) => \(\{/);
    expect(dataEditorSrc).toMatch(/initialDetailId=\{selectedDetailId\}/);
    expect(dataEditorSrc).toMatch(/detailOptions=\{detailPreviewOptions\}/);
    expect(dataEditorSrc).toMatch(/firstLabelPageIndexForDetail/);
    expect(dataEditorSrc).toMatch(/selectedIndex=\{selectedLatestPageIndex \?\? selectedDetailFirstPageIndex\}/);
    expect(dataEditorSrc).toMatch(/onSelectedIndexChange=\{setSelectedLatestPageIndex\}/);
    expect(generateSrc).toMatch(/detailFilters/);
    expect(generateSrc).toMatch(/OrderLabelPagesViewer/);
    expect(pagesViewerSrc).toMatch(/Список бирок/);
    expect(pagesViewerSrc).toMatch(/labelPageTitle/);
    expect(generateSrc).not.toMatch(/maxHeight: 220, overflow: 'auto'/);
  });

  it('renders generated labels as a full list and uses print pages for range printing', () => {
    expect(generateSrc).toMatch(/generatedPreview/);
    expect(generateSrc).toMatch(/Сформированные бирки/);
    expect(generateSrc).toMatch(/setOpen\(false\)/);
    expect(generateSrc).not.toMatch(/setOpen\(false\);\s*\n\s*}\s*catch/);
    expect(latestSrc).toMatch(/OrderLabelPagesViewer/);
    expect(dataEditorSrc).toMatch(/OrderLabelPagesViewer/);
    expect(pagesViewerSrc).toMatch(/printLabelSvgPages/);
    expect(pagesViewerSrc).toMatch(/диапазон страниц/);
    expect(printSrc).toMatch(/page-break-after: always/);
    expect(printSrc).toMatch(/frameWindow\.print\(\)/);
    expect(generateSrc).not.toMatch(/minHeight: 260/);
  });

  it('uses a responsive two-column generation modal and permits labels without cut maps', () => {
    expect(generateSrc).toMatch(/order-label-generate-layout/);
    expect(generateSrc).toMatch(/grid-template-columns:\s*minmax\(380px, 1fr\) minmax\(360px, 0\.9fr\)/);
    expect(generateSrc).toMatch(/overflow-x:\s*auto/);
    expect(generateSrc).not.toMatch(/\.order-label-generate-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(generateSrc).toMatch(/@media \(max-width: 680px\)/);
    expect(generateSrc).toMatch(/row\.options\.length > 0/);
    expect(generateSrc).toMatch(/row\.options\.length === 0 && staleCandidates\.has\(row\.key\)/);
    expect(generateSrc).toMatch(/Нет раскроя — бирка будет без миниатюры/);
    expect(generateSrc).toMatch(/Деталь изменена — выполните новый раскрой/);
  });

  it('updates modal preview automatically when preview inputs change', () => {
    expect(generateSrc).toMatch(/useCallback/);
    expect(generateSrc).toMatch(/void runPreview\(\)/);
    expect(generateSrc).toMatch(/previewDetailId/);
    expect(generateSrc).toMatch(/useBasisFields/);
    expect(generateSrc).not.toMatch(/setPreview\(null\);\s*\n\s*}\s*}\s*options/s);
  });

  it('reloads an open generation modal when a label template is saved', () => {
    expect(configSrc).toMatch(/notifyLabelTemplateChanged\(saved\)/);
    expect(configSrc).toMatch(/notifyLabelTemplateChanged\(created\)/);
    expect(generateSrc).toMatch(/subscribeLabelTemplateChanged/);
    expect(generateSrc).toMatch(/previewRequestRef\.current \+= 1/);
    expect(generateSrc).toMatch(/window\.addEventListener\('focus', onFocus\)/);
    expect(templateEventsSrc).toMatch(/CustomEvent/);
    expect(templateEventsSrc).toMatch(/localStorage\.setItem/);
    expect(templateEventsSrc).toMatch(/BroadcastChannel/);
  });

  it('clears the previous template SVG before loading a fresh preview', () => {
    expect(generateSrc).toMatch(/previewRequestRef\.current = requestId;[\s\S]*setPreview\(null\);[\s\S]*setLoading\(true\)/);
  });

  it('lets order label generation choose whether Basis project/data columns feed the preview', () => {
    expect(generateSrc).toMatch(/Использовать поля базис проекта/);
    expect(generateSrc).toMatch(/useBasisFields/);
    expect(generateSrc).toMatch(/setUseBasisFields\(event\.target\.checked\)/);
    expect(generateSrc).toMatch(/labelsApi\.previewOrderLabels[\s\S]*useBasisFields/);
    expect(generateSrc).toMatch(/labelsApi\.generateOrderLabels[\s\S]*useBasisFields/);
  });

  it('shows latest generated label template preview inside the order edit labels block', () => {
    expect(dataEditorSrc).toMatch(/labelsApi\.getLatest\(orderId\)/);
    expect(dataEditorSrc).toMatch(/setLatestPreview\(latest\)/);
    expect(dataEditorSrc).toMatch(/Последняя генерация/);
    expect(dataEditorSrc).toMatch(/latestPreview\.svgPages/);
    expect(dataEditorSrc).not.toMatch(/data\?\.details\[0\]\?\.detailId/);
  });

  it('gates automatic label reads and rejects stale lifecycle/resource publication', () => {
    expect(dataEditorSrc).toMatch(/useOrderAsyncReadGuard/);
    expect(dataEditorSrc).toMatch(/!orderId \|\| !readGuard\.active/);
    expect(dataEditorSrc).toMatch(/readGuard\.capture\(\)/);
    expect(dataEditorSrc).toMatch(/readGuard\.isCurrent\(token\)/);
    expect(dataEditorSrc).toMatch(/readGuard\.isSameResource\(writeToken\)/);
    expect(dataEditorSrc).toMatch(/stateScopeKey === readScopeKey/);
    expect(generateSrc).toMatch(/useOrderAsyncReadGuard/);
    expect(generateSrc).toMatch(/readGuard\.capture\(\)/);
    expect(generateSrc).toMatch(/readGuard\.isCurrent\(token\)/);
    expect(generateSrc).toMatch(/writeGuard\.isSameResource\(writeToken\)/);
    expect(latestSrc).toMatch(/useOrderAsyncReadGuard/);
    expect(latestSrc).toMatch(/readGuard\.isCurrent\(token\)/);
    expect(latestSrc).toMatch(/latestState\?\.scopeKey === latestScopeKey/);
  });

  it('outlines every order-card label preview with the shared neutral frame', () => {
    expect(pagesViewerSrc).toMatch(/LabelSvgPreviewFrame/);
    expect(latestSrc).toMatch(/LabelSvgPreviewFrame/);
    expect(dataEditorSrc).toMatch(/LabelSvgPreviewFrame/);
    expect(previewFrameSrc).toMatch(/outline: '1px solid var\(--label-preview-outline, rgba\(0,0,0,0\.1\)\)'/);
    expect(previewFrameSrc).toMatch(/outlineOffset: -1/);
  });
});
