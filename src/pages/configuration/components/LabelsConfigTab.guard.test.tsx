import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabSrc = readFileSync(new URL('./LabelsConfigTab.tsx', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../../api/labelsApi.ts', import.meta.url), 'utf8');

describe('LabelsConfigTab wiring', () => {
  it('is registered only behind labels runtime flag and labels.view permission', () => {
    expect(indexSrc).toMatch(/featureFlags\.labels[\s\S]*can\('labels\.view'\)[\s\S]*LabelsConfigTab/);
  });

  it('reads and writes only through labelsApi backend endpoints', () => {
    expect(tabSrc).toMatch(/labelsApi\.listTemplates/);
    expect(tabSrc).toMatch(/labelsApi\.listFields/);
    expect(tabSrc).toMatch(/labelsApi\.createTemplate/);
    expect(tabSrc).toMatch(/labelsApi\.updateTemplate/);
    expect(tabSrc).not.toMatch(/dataProvider|gql`|mutation\s/);
    expect(apiSrc).toMatch(/createTemplate/);
    expect(apiSrc).toMatch(/updateTemplate/);
    expect(apiSrc).toMatch(/deleteTemplate/);
  });

  it('requires labels.manage_templates for create and edit controls', () => {
    expect(tabSrc).toMatch(/can\('labels\.manage_templates'\)/);
    expect(tabSrc).toMatch(/disabled=\{!canManage/);
    expect(tabSrc).toMatch(/Новый шаблон/);
    expect(tabSrc).toMatch(/Сохранить шаблон/);
  });

  it('exposes editable template elements and custom schema so created templates are not blank-only', () => {
    expect(tabSrc).toMatch(/Элементы/);
    expect(tabSrc).toMatch(/addElement\('text'\)/);
    expect(tabSrc).toMatch(/addElement\('line'\)/);
    expect(tabSrc).toMatch(/addElement\('rect'\)/);
    expect(tabSrc).toMatch(/customFieldSchema/);
    expect(tabSrc).toMatch(/Кастомные поля/);
    expect(tabSrc).toMatch(/sourceField/);
    expect(tabSrc).toMatch(/detail\.detail_name/);
    expect(tabSrc).toMatch(/elements,/);
  });

  it('offers Bazis .xbir import variants that can be applied to the template form', () => {
    expect(tabSrc).toMatch(/Импорт из Bazis \.xbir/);
    expect(tabSrc).toMatch(/parseBazisTemplateVariants/);
    expect(tabSrc).toMatch(/Шаблон бирки/);
    expect(tabSrc).toMatch(/applyImportVariant/);
    expect(tabSrc).toMatch(/buildStandardBazisElements/);
  });

  it('shows an active Konva label preview for the selected or edited template', () => {
    expect(tabSrc).toMatch(/Визуал бирки/);
    expect(tabSrc).toMatch(/LabelTemplatePreview/);
    expect(tabSrc).toMatch(/Form\.useWatch\('canvasWidthMm'/);
    expect(tabSrc).toMatch(/rowClassName=.*ant-table-row-selected/);
    expect(tabSrc).toMatch(/renderKonvaPreviewElement/);
    expect(tabSrc).toMatch(/react-konva/);
    expect(tabSrc).toMatch(/PREVIEW_FIELD_VALUES/);
  });

  it('keeps the template list full-width with scroll and supports visual drag editing', () => {
    expect(tabSrc).toMatch(/title="Шаблоны"/);
    expect(tabSrc).toMatch(/scroll=\{\{ y: 430 \}\}/);
    expect(tabSrc).toMatch(/title="Просмотр текущего шаблона"/);
    expect(tabSrc).toMatch(/onMoveElement/);
    expect(tabSrc).toMatch(/<Stage/);
    expect(tabSrc).toMatch(/<Layer/);
    expect(tabSrc).toMatch(/KonvaText/);
    expect(tabSrc).toMatch(/onDragEnd/);
    expect(tabSrc).toMatch(/clamp\(event\.target\.x\(\)/);
  });

  it('supports advanced Konva editing controls for transform, grid, zoom and keyboard', () => {
    expect(tabSrc).toMatch(/Transformer/);
    expect(tabSrc).toMatch(/renderGrid/);
    expect(tabSrc).toMatch(/Сетка/);
    expect(tabSrc).toMatch(/Привязка/);
    expect(tabSrc).toMatch(/Tooltip/);
    expect(tabSrc).toMatch(/setZoom/);
    expect(tabSrc).toMatch(/onWheel/);
    expect(tabSrc).toMatch(/onKeyDown=\{handleKeyDown\}/);
    expect(tabSrc).toMatch(/Delete' \|\| event\.key === 'Backspace/);
    expect(tabSrc).toMatch(/ArrowLeft/);
    expect(tabSrc).toMatch(/onTransformEnd/);
    expect(tabSrc).toMatch(/boundBoxFunc/);
  });

  it('exposes a draggable field palette that can drop fields onto the label visual', () => {
    expect(tabSrc).toMatch(/Поля бирки/);
    expect(tabSrc).toMatch(/FieldPalette/);
    expect(tabSrc).toMatch(/draggable=\{!disabled\}/);
    expect(tabSrc).toMatch(/application\/x-label-field/);
    expect(tabSrc).toMatch(/onDropField/);
    expect(tabSrc).toMatch(/addFieldElement/);
  });

  it('strips read-only element ids before create or update payloads', () => {
    expect(tabSrc).toMatch(/toTemplateElementInput\(elements\)/);
    expect(tabSrc).toMatch(/labelTemplateElementId: _labelTemplateElementId/);
  });

  it('can create a copy from the current edited template through Save As', () => {
    expect(tabSrc).toMatch(/Сохранить как/);
    expect(tabSrc).toMatch(/Сохранить шаблон как/);
    expect(tabSrc).toMatch(/saveTemplateAs/);
    expect(tabSrc).toMatch(/labelsApi\.createTemplate\(buildTemplatePayload\(values, name\)\)/);
    expect(tabSrc).toMatch(/Создать копию/);
  });
});
