import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const formSrc = readFileSync(new URL('../OrderForm.tsx', import.meta.url), 'utf8');
const showSrc = readFileSync(new URL('../../show.tsx', import.meta.url), 'utf8');
const dataEditorSrc = readFileSync(new URL('./OrderLabelDataEditor.tsx', import.meta.url), 'utf8');
const generateSrc = readFileSync(new URL('./OrderLabelGenerateAction.tsx', import.meta.url), 'utf8');
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

  it('order-side template selectors include inactive templates so saved label data remains reachable', () => {
    expect(dataEditorSrc).toMatch(/labelsApi\.listTemplates\(true\)/);
    expect(generateSrc).toMatch(/labelsApi\.listTemplates\(true\)/);
    expect(dataEditorSrc).toMatch(/next\.find\(\(template\) => template\.isActive\)\?\.labelTemplateId/);
    expect(generateSrc).toMatch(/next\.find\(\(template\) => template\.isActive\)\?\.labelTemplateId/);
    expect(dataEditorSrc).toMatch(/\(архив\)/);
    expect(generateSrc).toMatch(/\(архив\)/);
  });

  it('shows the effective generated comment fallback before writing explicit overrides', () => {
    expect(dataEditorSrc).toMatch(/detail\.bazisFields\['bazis\.comment'\] \?\? detail\.note \?\? ''/);
  });

  it('previews one fitted label and can filter preview by clicked order detail', () => {
    expect(dataEditorSrc).toMatch(/selectedDetailId/);
    expect(dataEditorSrc).toMatch(/onRow=\{\(detail\) => \(\{/);
    expect(dataEditorSrc).toMatch(/initialDetailId=\{selectedDetailId\}/);
    expect(dataEditorSrc).toMatch(/detailOptions=\{detailPreviewOptions\}/);
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

  it('updates modal preview automatically when preview inputs change', () => {
    expect(generateSrc).toMatch(/useCallback/);
    expect(generateSrc).toMatch(/void runPreview\(\)/);
    expect(generateSrc).toMatch(/previewDetailId/);
    expect(generateSrc).toMatch(/useBasisFields/);
    expect(generateSrc).not.toMatch(/setPreview\(null\);\s*\n\s*}\s*}\s*options/s);
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

  it('outlines every order-card label preview with the shared neutral frame', () => {
    expect(pagesViewerSrc).toMatch(/LabelSvgPreviewFrame/);
    expect(latestSrc).toMatch(/LabelSvgPreviewFrame/);
    expect(dataEditorSrc).toMatch(/LabelSvgPreviewFrame/);
    expect(previewFrameSrc).toMatch(/outline: '1px solid var\(--label-preview-outline, rgba\(0,0,0,0\.1\)\)'/);
    expect(previewFrameSrc).toMatch(/outlineOffset: -1/);
  });
});
