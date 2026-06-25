import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const formSrc = readFileSync(new URL('../OrderForm.tsx', import.meta.url), 'utf8');
const showSrc = readFileSync(new URL('../../show.tsx', import.meta.url), 'utf8');
const dataEditorSrc = readFileSync(new URL('./OrderLabelDataEditor.tsx', import.meta.url), 'utf8');
const generateSrc = readFileSync(new URL('./OrderLabelGenerateAction.tsx', import.meta.url), 'utf8');
const latestSrc = readFileSync(new URL('./OrderLatestLabelsPreview.tsx', import.meta.url), 'utf8');

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
    expect(generateSrc).toMatch(/slice\(0,\s*1\)/);
    expect(generateSrc).toMatch(/order-label-preview-fit/);
    expect(generateSrc).not.toMatch(/maxHeight: 220, overflow: 'auto'/);
  });

  it('lets order label generation choose whether Basis project/data columns feed the preview', () => {
    expect(generateSrc).toMatch(/Использовать поля базис проекта/);
    expect(generateSrc).toMatch(/useBasisFields/);
    expect(generateSrc).toMatch(/setUseBasisFields\(event\.target\.checked\)/);
    expect(generateSrc).toMatch(/labelsApi\.previewOrderLabels[\s\S]*useBasisFields/);
    expect(generateSrc).toMatch(/labelsApi\.generateOrderLabels[\s\S]*useBasisFields/);
  });
});
