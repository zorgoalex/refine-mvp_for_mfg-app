import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabSrc = readFileSync(new URL('./LabelsConfigTab.tsx', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../../api/labelsApi.ts', import.meta.url), 'utf8');
const expressionEditorSrc = readFileSync(new URL('./CustomFieldExpressionEditor.tsx', import.meta.url), 'utf8');

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

  it('exposes editable template elements and a user-facing custom-field editor without JSON', () => {
    expect(tabSrc).toMatch(/Элементы/);
    expect(tabSrc).toMatch(/addElement\('text'\)/);
    expect(tabSrc).toMatch(/addElement\('line'\)/);
    expect(tabSrc).toMatch(/addElement\('rect'\)/);
    expect(tabSrc).toMatch(/addElement\('qr'\)/);
    expect(tabSrc).toMatch(/customFieldSchema/);
    expect(tabSrc).toMatch(/Пользовательские поля/);
    expect(tabSrc).toMatch(/Добавить поле/);
    expect(tabSrc).toMatch(/Редактировать пользовательское поле/);
    expect(tabSrc).toMatch(/Постоянный текст/);
    expect(tabSrc).not.toMatch(/Заполняется вручную для заказа/);
    expect(tabSrc).toMatch(/staticText: kind === 'text' \? 'Новый текст' : null/);
    expect(tabSrc).not.toMatch(/Пользовательские поля JSON/);
    expect(tabSrc).not.toMatch(/JSON некорректен/);
    expect(tabSrc).toMatch(/sourceField/);
    expect(tabSrc).toMatch(/Данные ERP \/ Базис/);
    expect(tabSrc).toMatch(/elements,/);
  });

  it('gates custom formulas with a global capability handshake and exposes every expression node', () => {
    expect(tabSrc).toMatch(/labelsApi\.getRendererCapabilities/);
    expect(apiSrc).toMatch(/rendererCapabilities/);
    expect(tabSrc).toMatch(/custom_expression_v1/);
    expect(tabSrc).toMatch(/CustomFieldExpressionEditor/);
    expect(tabSrc).toMatch(/findCustomFieldDependencyCycle/);
    expect(expressionEditorSrc).toMatch(/Склейка значений/);
    expect(expressionEditorSrc).toMatch(/IF \/ ELSE/);
    expect(expressionEditorSrc).toMatch(/Фиксированный текст/);
    expect(expressionEditorSrc).toMatch(/Пропустить/);
    expect(expressionEditorSrc).toMatch(/ArrowUpOutlined/);
    expect(expressionEditorSrc).toMatch(/ArrowDownOutlined/);
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

  it('snaps nearby element centers and renders live horizontal or vertical guide lines', () => {
    expect(tabSrc).toMatch(/snapElementCenters/);
    expect(tabSrc).toMatch(/alignmentGuides/);
    expect(tabSrc).toMatch(/onDragMove/);
    expect(tabSrc).toMatch(/renderAlignmentGuides/);
    expect(tabSrc).toMatch(/Линии центрирования/);
  });

  it('keeps text and rectangle content stable while resizing transform handles', () => {
    expect(tabSrc).toMatch(/onTransform=\{handleTransform\}/);
    expect(tabSrc).toMatch(/onTransformEnd=\{handleTransformEnd\}/);
    expect(tabSrc).toMatch(/readAndNormalizeLabelTransformedNodes/);
    expect(tabSrc).toMatch(/claimLabelGestureCommit/);
    expect(tabSrc).toMatch(/commitGeometry\(patches\)/);
  });

  it('remembers normal or large-preview column proportions and auto-fits the canvas', () => {
    expect(tabSrc).toMatch(/loadLabelEditorLayoutMode\(layoutPreferenceUserId\)/);
    expect(tabSrc).toMatch(/saveLabelEditorLayoutMode\(layoutPreferenceUserId, mode\)/);
    expect(tabSrc).toMatch(/labelEditorLayoutGeometry\(editorLayoutMode\)/);
    expect(tabSrc).toMatch(/initialZoom=\{layoutGeometry\.initialZoom\}/);
    expect(tabSrc).toMatch(/fitToContainer=\{layoutGeometry\.fitPreviewToColumn\}/);
    expect(tabSrc).toMatch(/Крупный визуал/);
    expect(tabSrc).toMatch(/\{ leftColumnSpan, rightColumnSpan \} = layoutGeometry/);
    expect(tabSrc).toMatch(/new ResizeObserver\(updateAvailableWidth\)/);
    expect(tabSrc).toMatch(/data-label-preview-fit=\{fitToContainer \? 'container' : 'intrinsic'\}/);
  });

  it('places field palette and template settings in the requested editor layout', () => {
    expect(tabSrc).toMatch(/<Text strong>Поля бирки<\/Text>/);
    expect(tabSrc).toMatch(/title="Параметры шаблона"/);
    expect(tabSrc).toMatch(/title="Визуал бирки"/);
    expect(tabSrc).toMatch(/<Panel header="Пользовательские поля" key="custom-fields">/);
  });

  it('highlights changed and missing schema fields in label and QR editors', () => {
    expect(tabSrc).toMatch(/compareFieldSnapshot/);
    expect(tabSrc).toMatch(/fieldCatalogSnapshot/);
    expect(tabSrc).toContain('Изменено в схеме');
    expect(tabSrc).toContain('Отсутствует в схеме');
    expect(tabSrc).toMatch(/fieldHealthColor\(qrFieldHealth\.get\(chip\.fieldId\)\)/);
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

  it('keeps conditionally hidden field text visible on the editable canvas only', () => {
    expect(tabSrc).toMatch(/keepConditionallyHiddenTextVisible/);
    expect(tabSrc).toMatch(/resolveLabelCanvasText\(element, fieldValues, fieldLabels/);
    expect(tabSrc).toMatch(/keepSourceVisible: keepConditionallyHiddenTextVisible/);
  });

  it('exposes a draggable field palette that can drop fields onto the label visual', () => {
    expect(tabSrc).toMatch(/Поля бирки/);
    expect(tabSrc).toMatch(/FieldPalette/);
    expect(tabSrc).toMatch(/draggable=\{!disabled && !unavailable\}/);
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
    expect(tabSrc).toMatch(/fieldHealthColor\(health\) \?\? \(used \? 'processing' : undefined\)/);
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

  it('treats QR as a first-class free-overlap element (no conflict system at all)', () => {
    expect(tabSrc).toMatch(/QR-код/);
    expect(tabSrc).toMatch(/QrcodeOutlined/);
    expect(tabSrc).toMatch(/value: 'qr', label: 'QR-код'/);
    expect(tabSrc).toMatch(/qrTemplate/);
    expect(tabSrc).toMatch(/qrErrorCorrection/);
    expect(tabSrc).toMatch(/applyQrGeometryPatch/);
    expect(tabSrc).toMatch(/qrProtectedRect/);
    expect(tabSrc).toMatch(/kind === 'qr'/);
    // QR overlap/out-of-bounds is no longer a concept: no auto-shift, no conflict
    // collection, no conflict state, no conflict banner. QR may freely overlap.
    expect(tabSrc).not.toMatch(/autoShiftForQr/);
    expect(tabSrc).not.toMatch(/collectQrConflicts/);
    expect(tabSrc).not.toMatch(/qrConflicts/);
    expect(tabSrc).not.toMatch(/data-label-qr-conflict/);
    expect(tabSrc).not.toMatch(/пересекается/);
  });

  it('never blocks saving on a QR overlap/out-of-bounds or a missing QR name (auto-filled)', () => {
    expect(tabSrc).not.toMatch(/QR_CONFLICT/);
    const buildPayloadBody = tabSrc.slice(
      tabSrc.indexOf('const buildTemplatePayload ='),
      tabSrc.indexOf('const describeSaveError ='),
    );
    // no overlap conflict, and an empty QR name is AUTO-FILLED (uniqueQrName), not thrown
    expect(buildPayloadBody).not.toMatch(/collectQrConflicts/);
    expect(buildPayloadBody).not.toMatch(/QR_NAME_EMPTY_ERROR_PREFIX/);
    expect(buildPayloadBody).toMatch(/uniqueQrName/);
    expect(buildPayloadBody).toMatch(/throw new Error\(`\$\{QR_NAME_DUP_ERROR_PREFIX\}/);
    expect(buildPayloadBody).toMatch(/collectDuplicateQrNames/);
  });

  it('auto-names a newly added QR and never auto-shifts / never places a conflict', () => {
    const addElementBody = tabSrc.slice(
      tabSrc.indexOf('const addElement = '),
      tabSrc.indexOf('const patchElement = '),
    );
    // toolbar-added QR gets a default unique name so the save-time name contract
    // is never tripped for a freshly-added QR (this was the real save-blocker).
    expect(addElementBody).toMatch(/uniqueQrName/);
    expect(addElementBody).toMatch(/qrName/);
    const dropBody = tabSrc.slice(
      tabSrc.indexOf('const onDropDraggingQr = '),
      tabSrc.indexOf('const handleBazisImportFile ='),
    );
    expect(dropBody).not.toMatch(/autoShiftForQr/);
  });

  it('lets elements be reordered to the front or back of the draw stack via the context menu', () => {
    expect(tabSrc).toMatch(/На передний план/);
    expect(tabSrc).toMatch(/На задний план/);
    expect(tabSrc).toMatch(/bringElementToFront/);
    expect(tabSrc).toMatch(/sendElementToBack/);
    expect(tabSrc).toMatch(/onBringElementToFront\?\.\(contextElement\.elementKey\)/);
    expect(tabSrc).toMatch(/onSendElementToBack\?\.\(contextElement\.elementKey\)/);
  });

  it('supports sample preview, default editor guides and persistent multi-element groups', () => {
    expect(tabSrc).toMatch(/useState\(Boolean\(canDrag\)\)/);
    expect(tabSrc).toMatch(/setShowAllBorders\] = useState\(true\)/);
    expect(tabSrc).toMatch(/Пример с данными/);
    expect(tabSrc).toMatch(/event\.shiftKey/);
    expect(tabSrc).toMatch(/Сгруппировать/);
    expect(tabSrc).toMatch(/Разгруппировать/);
    expect(tabSrc).toMatch(/По горизонтальному центру канваса/);
    expect(tabSrc).toMatch(/По вертикальному центру канваса/);
    expect(tabSrc).toMatch(/data-label-measurement/);
    expect(tabSrc).toMatch(/Выровнять высоту/);
  });

  it('strips read-only element ids before create or update payloads', () => {
    expect(tabSrc).toMatch(/toTemplateElementInput\(namedElements\)/);
    expect(tabSrc).toMatch(/labelTemplateElementId: _labelTemplateElementId/);
  });

  it('keeps the just-saved template selected after save instead of resetting to a blank new template', () => {
    const saveBody = tabSrc.slice(
      tabSrc.indexOf('const saveTemplate ='),
      tabSrc.indexOf('const openSaveAs ='),
    );
    // After a successful save the editor must re-select the saved template
    // (update and create both return the saved LabelTemplate), not reset the
    // form to the blank "new template" scaffold via startNew().
    expect(saveBody).not.toMatch(/startNew\(\)/);
    expect(saveBody).toMatch(/setSelectedTemplate\(saved\)/);
    expect(saveBody).toMatch(/setEditorElements\(saved\.elements, false\)/);
    expect(saveBody).toMatch(/saved = await labelsApi\.updateTemplate/);
    expect(saveBody).toMatch(/saved = await labelsApi\.createTemplate/);
  });

  it('serializes the latest editor snapshot and blocks every template mutation while save is running', () => {
    const payloadBody = tabSrc.slice(
      tabSrc.indexOf('const buildTemplatePayload ='),
      tabSrc.indexOf('const describeSaveError ='),
    );
    expect(payloadBody).toMatch(/elementsRef\.current/);
    expect(payloadBody).toMatch(/customFieldsRef\.current/);
    expect(tabSrc).toMatch(/savingRef\.current = next/);
    expect(tabSrc).toMatch(/if \(markDirty && savingRef\.current\) return/);
    expect(tabSrc).toMatch(/disabled=\{!canManage \|\| saving \|\| element\.kind !== 'text'\}/);
    expect(tabSrc).toMatch(/disabled=\{!canManage \|\| saving \|\| element\.kind !== 'qr'\}/);
    expect(tabSrc).toMatch(/disabled=\{!canManage \|\| saving\}/);
    expect(tabSrc).toMatch(/canDrag=\{canManage && !saving\}/);
    expect(tabSrc).toMatch(/setEditorElements/);
    expect(tabSrc).not.toMatch(/setElements\(\[\.\.\.elements,/);
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

  it('still maps backend LABEL_QR_NAME_REQUIRED/DUPLICATE save errors (defensive)', () => {
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
