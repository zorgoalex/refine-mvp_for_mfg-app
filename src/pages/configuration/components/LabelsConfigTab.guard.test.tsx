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
    expect(tabSrc).toMatch(/addElement\('qr'\)/);
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
    expect(tabSrc).toMatch(/header="Просмотр текущего шаблона"/);
    expect(tabSrc).toMatch(/defaultActiveKey=\{\['current-template-preview'\]\}/);
    expect(tabSrc).toMatch(/Collapse/);
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

  it('keeps text and rectangle content stable while resizing transform handles', () => {
    expect(tabSrc).toMatch(/onTransform: \(node, event\) => handleTransform/);
    expect(tabSrc).toMatch(/normalizeTransformedNode/);
    expect(tabSrc).toMatch(/sizedNode\.scaleX\(1\)/);
    expect(tabSrc).toMatch(/sizedNode\.width\(widthMm\)/);
  });

  it('defaults the edit visual to compact mode and can expand it', () => {
    expect(tabSrc).toMatch(/visualExpanded/);
    expect(tabSrc).toMatch(/initialZoom=\{visualExpanded \? 1\.3 : 0\.6\}/);
    expect(tabSrc).toMatch(/Увеличить визуал/);
    expect(tabSrc).toMatch(/leftColumnSpan = visualExpanded \? 10 : 14/);
    expect(tabSrc).toMatch(/rightColumnSpan = visualExpanded \? 14 : 10/);
  });

  it('places field palette and template settings in the requested editor layout', () => {
    expect(tabSrc).toMatch(/<Text strong>Поля бирки<\/Text>/);
    expect(tabSrc).toMatch(/title="Параметры шаблона"/);
    expect(tabSrc).toMatch(/title="Визуал бирки"/);
    expect(tabSrc).toMatch(/<Panel header="Пользовательские поля" key="custom-fields">/);
  });

  it('keeps template dimensions, resolution and formats on one settings row', () => {
    expect(tabSrc).toMatch(/<Row gutter=\{8\} align="top" wrap=\{false\}>/);
    expect(tabSrc).toMatch(/name="canvasWidthMm" label=\{<span style=\{\{ fontSize: 11 \}\}>Ширина<\/span>\}/);
    expect(tabSrc).toMatch(/name="canvasHeightMm" label=\{<span style=\{\{ fontSize: 11 \}\}>Высота<\/span>\}/);
    expect(tabSrc).toMatch(/name="dpi" label=\{<span style=\{\{ fontSize: 11 \}\}>Разрешение<\/span>\}/);
    expect(tabSrc).toMatch(/name="defaultExportFormats" label=\{<span style=\{\{ fontSize: 11 \}\}>Форматы<\/span>\}/);
    expect(tabSrc).toMatch(/<Col flex="47px">[\s\S]*name="canvasWidthMm"/);
    expect(tabSrc).toMatch(/<Col flex="67px">[\s\S]*name="dpi"/);
  });

  it('shows a hover tooltip that identifies the label element field', () => {
    expect(tabSrc).toMatch(/hoveredElement/);
    expect(tabSrc).toMatch(/describeLabelElement/);
    expect(tabSrc).toMatch(/В списке полей/);
    expect(tabSrc).toMatch(/onHoverElement/);
    expect(tabSrc).toMatch(/onMouseEnter/);
  });

  it('exposes a draggable field palette that can drop fields onto the label visual', () => {
    expect(tabSrc).toMatch(/Поля бирки/);
    expect(tabSrc).toMatch(/FieldPalette/);
    expect(tabSrc).toMatch(/draggable=\{!disabled\}/);
    expect(tabSrc).toMatch(/application\/x-label-field/);
    expect(tabSrc).toMatch(/onDropField/);
    expect(tabSrc).toMatch(/addFieldElement/);
    expect(tabSrc).toMatch(/dragPreview/);
    expect(tabSrc).toMatch(/dragCursor/);
    expect(tabSrc).toMatch(/data-label-global-drag-preview/);
    expect(tabSrc).toMatch(/updateDragPreview/);
    expect(tabSrc).toMatch(/text=\{dragPreview\.field\.label\}/);
    expect(tabSrc).toMatch(/interactive: Boolean\(canDrag && !externalDragActive\)/);
    expect(tabSrc).toMatch(/window\.addEventListener\('pointerup', handleGlobalDrop, true\)/);
  });

  it('highlights fields already placed on the label and supports element context actions', () => {
    expect(tabSrc).toMatch(/usedFieldIds/);
    expect(tabSrc).toMatch(/color=\{used \? 'processing' : undefined\}/);
    expect(tabSrc).toMatch(/isLabelElementLocked/);
    expect(tabSrc).toMatch(/Заблокировать/);
    expect(tabSrc).toMatch(/Разблокировать/);
    expect(tabSrc).toMatch(/Сделать копию/);
    expect(tabSrc).toMatch(/duplicateElementByKey/);
    expect(tabSrc).toMatch(/onContextMenu/);
    expect(tabSrc).toMatch(/data-label-context-menu/);
  });

  it('supports text value alignment from the element context menu', () => {
    expect(tabSrc).toMatch(/Выравнивание значения/);
    expect(tabSrc).toMatch(/AlignLeftOutlined/);
    expect(tabSrc).toMatch(/AlignCenterOutlined/);
    expect(tabSrc).toMatch(/AlignRightOutlined/);
    expect(tabSrc).toMatch(/setElementTextAlign/);
    expect(tabSrc).toMatch(/getLabelTextAlign/);
    expect(tabSrc).toMatch(/textAlign === 'center'/);
    expect(tabSrc).toMatch(/align=\{textAlign\}/);
  });

  it('supports QR-code elements with template payloads and a non-blocking overlap warning', () => {
    expect(tabSrc).toMatch(/QR-код/);
    expect(tabSrc).toMatch(/QrcodeOutlined/);
    expect(tabSrc).toMatch(/value: 'qr', label: 'QR-код'/);
    expect(tabSrc).toMatch(/qrTemplate/);
    expect(tabSrc).toMatch(/qrErrorCorrection/);
    expect(tabSrc).toMatch(/autoShiftForQr/);
    expect(tabSrc).toMatch(/applyQrGeometryPatch/);
    expect(tabSrc).toMatch(/collectQrConflicts/);
    expect(tabSrc).toMatch(/qrProtectedRect/);
    expect(tabSrc).toMatch(/data-label-qr-conflict/);
    expect(tabSrc).toMatch(/kind === 'qr'/);
  });

  it('never blocks saving on a QR overlap/out-of-bounds conflict (warning-only, option A)', () => {
    // buildTemplatePayload must not throw for collectQrConflicts results — only
    // the duplicate-name and empty-name QR checks are allowed to block a save.
    expect(tabSrc).not.toMatch(/QR_CONFLICT/);
    expect(tabSrc).not.toMatch(/throw new Error\(QR_CONFLICT_ERROR\)/);
    const buildPayloadBody = tabSrc.slice(
      tabSrc.indexOf('const buildTemplatePayload ='),
      tabSrc.indexOf('const describeSaveError ='),
    );
    expect(buildPayloadBody).not.toMatch(/collectQrConflicts/);
    expect(buildPayloadBody).toMatch(/throw new Error\(`\$\{QR_NAME_DUP_ERROR_PREFIX\}/);
    expect(buildPayloadBody).toMatch(/throw new Error\(`\$\{QR_NAME_EMPTY_ERROR_PREFIX\}/);
    expect(buildPayloadBody).toMatch(/collectDuplicateQrNames/);
    expect(buildPayloadBody).toMatch(/collectEmptyQrNames/);
    expect(tabSrc).toMatch(/QR_NAME_DUP_ERROR_PREFIX/);
    expect(tabSrc).toMatch(/QR_NAME_EMPTY_ERROR_PREFIX/);
  });

  it('does not auto-shift neighbouring elements when a QR is moved/resized manually, only on initial library drop', () => {
    const applyPatchBody = tabSrc.slice(
      tabSrc.indexOf('const applyQrGeometryPatch = '),
      tabSrc.indexOf('const patchQrStyle ='),
    );
    expect(applyPatchBody).not.toMatch(/autoShiftForQr\(/);
    expect(applyPatchBody).toMatch(/collectQrConflicts/);
    const addElementBody = tabSrc.slice(
      tabSrc.indexOf('const addElement = '),
      tabSrc.indexOf('const patchElement = '),
    );
    expect(addElementBody).not.toMatch(/autoShiftForQr\(/);
    const dropBody = tabSrc.slice(
      tabSrc.indexOf('const onDropDraggingQr = '),
      tabSrc.indexOf('const handleBazisImportFile ='),
    );
    expect(dropBody).toMatch(/autoShiftForQr/);
  });

  it('lets elements be reordered to the front or back of the draw stack via the context menu', () => {
    expect(tabSrc).toMatch(/На передний план/);
    expect(tabSrc).toMatch(/На задний план/);
    expect(tabSrc).toMatch(/bringElementToFront/);
    expect(tabSrc).toMatch(/sendElementToBack/);
    expect(tabSrc).toMatch(/onBringElementToFront\?\.\(contextMenu\.element\.elementKey\)/);
    expect(tabSrc).toMatch(/onSendElementToBack\?\.\(contextMenu\.element\.elementKey\)/);
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

  it('renders a collapsible QR-код library block under custom fields', () => {
    expect(tabSrc).toContain('QR-коды');
    expect(tabSrc).toMatch(/labelsApi\.listQrTemplates/);
    expect(tabSrc).toMatch(/labelsApi\.createQrTemplate/);
    expect(tabSrc).toMatch(/labelsApi\.deleteQrTemplate/);
  });

  it('loads the QR library through its own soft-fail effect, not the all-or-nothing load() Promise.all', () => {
    expect(tabSrc).toMatch(/loadQrTemplates/);
    expect(tabSrc).toMatch(/setQrTemplates\(\[\]\)/);
    expect(tabSrc).not.toMatch(/Promise\.all\(\[\s*labelsApi\.listTemplates\(true\),\s*labelsApi\.listFields\(\),\s*labelsApi\.listQrTemplates/);
  });

  it('builds QR templates from field-drop chips and excludes label-scoped custom fields from its palette', () => {
    expect(tabSrc).toMatch(/rowsToTemplate/);
    expect(tabSrc).toMatch(/templateToRows/);
    expect(tabSrc).toMatch(/sanitizeQrText/);
    expect(tabSrc).toMatch(/qrPaletteFields/);
    expect(tabSrc).toMatch(/field\.category !== 'Кастомные'/);
    expect(tabSrc).toMatch(/labelsApi\.updateQrTemplate/);
    expect(tabSrc).toMatch(/draggingQr/);
  });

  it('supports multiple independent QR content rows, each with its own field-drop zone and free-text input', () => {
    expect(tabSrc).toMatch(/rows: QrRow\[\]/);
    expect(tabSrc).toMatch(/addQrRow/);
    expect(tabSrc).toMatch(/removeQrRow/);
    expect(tabSrc).toMatch(/\+ строка/);
    expect(tabSrc).toMatch(/qrRowDropRefs/);
  });

  it('lets an ad-hoc QR element be promoted into the global library', () => {
    expect(tabSrc).toContain('Сохранить в библиотеку');
    expect(tabSrc).toMatch(/qrDraftFromElement/);
    expect(tabSrc).toMatch(/promoteAdHocQrToLibrary/);
    expect(tabSrc).toMatch(/qrSourceTemplateId/);
  });

  it('drops a dragged library QR onto the canvas at the pointer position with auto-shift', () => {
    expect(tabSrc).toMatch(/qrElementFromLibrary/);
    expect(tabSrc).toMatch(/onDropDraggingQr/);
    expect(tabSrc).toMatch(/sourceTemplateId: payload\.labelQrTemplateId/);
    expect(tabSrc).toMatch(/el\.elementKey = `qr-\$\{Date\.now\(\)\}`/);
    expect(tabSrc).toMatch(/externalDragActive = Boolean\(draggingField \|\| draggingQr\)/);
    expect(tabSrc).toMatch(/data-label-global-drag-preview-qr/);
    expect(tabSrc).toMatch(/qrDragCursor/);
  });

  it('maps backend LABEL_QR_NAME_REQUIRED/DUPLICATE save errors and pre-checks empty qr names before saving', () => {
    expect(tabSrc).toMatch(/collectEmptyQrNames/);
    expect(tabSrc).toMatch(/QR_NAME_EMPTY_ERROR_PREFIX/);
    expect(tabSrc).toMatch(/error\.code === 'LABEL_QR_NAME_REQUIRED'/);
    expect(tabSrc).toMatch(/error\.code === 'LABEL_QR_NAME_DUPLICATE'/);
  });

  it('distinguishes QR-library name-taken 409s from stale-version 409s', () => {
    expect(tabSrc).toMatch(/error\.code === 'LABEL_QR_TEMPLATE_NAME_TAKEN'/);
    expect(tabSrc).toMatch(/QR-шаблон с таким именем уже существует/);
  });

  it('shows a floating drag badge for a QR-builder field pick-up, following the cursor', () => {
    expect(tabSrc).toMatch(/qrFieldDragCursor/);
    expect(tabSrc).toMatch(/data-label-global-drag-preview-qr-field/);
    expect(tabSrc).toMatch(/draggingQrField\.label/);
  });

  it('can toggle bounding-box borders for every label element in the visual preview', () => {
    expect(tabSrc).toMatch(/showAllBorders/);
    expect(tabSrc).toMatch(/showAllBounds/);
    expect(tabSrc).toMatch(/Показать границы всех элементов/);
    expect(tabSrc).toMatch(/allBoundsBox/);
  });

  it('preserves boundary spaces in QR text chips by NOT calling .trim() on the sanitized text', () => {
    // Ensure addQrTextChip does not call .trim() which would strip intentional boundary spaces.
    // Users must be able to put boundary spaces between fields (e.g. build '{a} {b}' with a space).
    const addChipBody = tabSrc.slice(
      tabSrc.indexOf('const addQrTextChip ='),
      tabSrc.indexOf('const removeQrChip ='),
    );
    expect(addChipBody).toMatch(/sanitizeQrText\(qrTextDraftsByRow/);
    // Confirm .trim() is NOT called on the sanitized text
    expect(addChipBody).not.toMatch(/sanitizeQrText\([^)]+\)\.trim\(\)/);
    // Confirm only empty string (not truthy check) skips adding the chip
    expect(addChipBody).toMatch(/if \(!text\) return;/);
  });
});
