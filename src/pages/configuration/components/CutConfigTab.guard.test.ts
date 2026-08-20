import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabSrc = readFileSync(new URL('./CutConfigTab.tsx', import.meta.url), 'utf8');
const renderFormSrc = readFileSync(new URL('./CutRenderStylesForm.tsx', import.meta.url), 'utf8');
const tabCss = readFileSync(new URL('./CutConfigTab.css', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../../api/cutConfigApi.ts', import.meta.url), 'utf8');

describe('CutConfigTab wiring (backend-owned, flag-guarded)', () => {
  it('reads + writes only through the backend cut-config API (no Hasura)', () => {
    expect(tabSrc).toMatch(/cutConfigApi\.get/);
    expect(tabSrc).not.toMatch(/import[\s\S]*dataProvider/);
    expect(tabSrc).not.toMatch(/gql`|mutation\s/);
  });

  it('no sheet-material card in cut config', () => {
    expect(tabSrc).not.toMatch(/sheet_material_types/i);
    expect(tabSrc).not.toMatch(/SheetModal/);
  });

  it('keeps eligibility + profiles + presets', () => {
    expect(tabSrc).toMatch(/Профили параметров/);
    expect(tabSrc).toMatch(/Пресеты рендера/);
  });

  it('exposes editable render style settings in a dedicated tab', () => {
    expect(tabSrc).toMatch(/Настройки рендера/);
    expect(tabSrc).toMatch(/CutRenderStylesForm/);
    expect(renderFormSrc).toMatch(/CUT_RENDER_STYLES_SETTING_KEY/);
    expect(renderFormSrc).toMatch(/parseCutRenderStylesSetting/);
    expect(renderFormSrc).toMatch(/cutConfigApi\.updateSetting\(CUT_RENDER_STYLES_SETTING_KEY/);
    expect(renderFormSrc).toMatch(/Шаблоны правил рендера/);
    expect(renderFormSrc).toMatch(/Сохранить как копию/);
    expect(renderFormSrc).toMatch(/type="color"/);
    expect(renderFormSrc).toMatch(/Загрузить тестовый SVG/);
    expect(renderFormSrc).toMatch(/Размер строки 1: заказ/);
    expect(renderFormSrc).toMatch(/Размер строки 2: позиция/);
    expect(renderFormSrc).toMatch(/Размер строки 3: размеры/);
    expect(renderFormSrc).toMatch(/Интервал заказ - позиция/);
    expect(renderFormSrc).toMatch(/Интервал позиция - размеры/);
    expect(renderFormSrc).toMatch(/Плотность букв/);
  });

  it('keeps render settings tab and uploaded SVG preview mounted after saving', () => {
    expect(tabSrc).toMatch(/const \[activeInnerTabKey, setActiveInnerTabKey\]/);
    expect(tabSrc).toMatch(/activeKey=\{activeInnerTabKey\}/);
    expect(tabSrc).toMatch(/onChange=\{\(key\) => setActiveInnerTabKey\(key as CutConfigInnerTabKey\)\}/);
    expect(tabSrc).toMatch(/const updateSettingInConfig = useCallback/);
    expect(tabSrc).toMatch(/onSaved=\{updateSettingInConfig\}/);
    expect(tabSrc).not.toMatch(/CutRenderStylesForm config=\{config\} canManage=\{canManage\} onSaved=\{reload\}/);
    expect(renderFormSrc).toMatch(/const savedSetting = await cutConfigApi\.updateSetting/);
    expect(renderFormSrc).toMatch(/await onSaved\(savedSetting\)/);
  });

  it('renders SVG preview from the unsaved draft of the selected render template', () => {
    expect(renderFormSrc).toContain(
      'buildSettingWithDraft(resolvedSetting, draft, selectedTemplateId, selectedTemplateId)',
    );
    expect(renderFormSrc).toMatch(/const previewSvg = useMemo\(/);
    expect(renderFormSrc).toMatch(/\[previewParsed, previewSetting\]/);
    expect(renderFormSrc).toMatch(/useLayoutEffect\(\(\) =>/);
  });

  it('keeps the SVG preview visible while desktop render settings scroll', () => {
    expect(renderFormSrc).toMatch(/className="cut-render-preview-column"/);
    expect(renderFormSrc).toMatch(/--cut-render-preview-sticky-top/);
    expect(tabCss).toMatch(/@media \(min-width: 1200px\)[\s\S]*\.cut-render-preview-column\s*\{[\s\S]*position:\s*sticky/);
    expect(tabCss).toMatch(/top:\s*var\(--cut-render-preview-sticky-top/);
    expect(tabCss).toMatch(/max-height:\s*calc\(100vh - var\(--cut-render-preview-sticky-top/);
    expect(tabCss).toMatch(/overflow-y:\s*auto/);
  });

  it('eligibility statuses use a multiselect from the production-statuses reference (no free text)', () => {
    expect(tabSrc).toMatch(/resource: 'production_statuses'/);
    expect(tabSrc).toMatch(/mode="multiple"/);
    // free-text CSV entry for eligibility codes is gone
    expect(tabSrc).not.toMatch(/parseCodesCsv/);
  });

  it('exposes CRUD for param-profiles and render-presets (not sheet specs)', () => {
    for (const m of [
      'createParamProfile', 'updateParamProfile', 'deleteParamProfile',
      'createRenderPreset', 'updateRenderPreset', 'deleteRenderPreset',
    ]) {
      expect(apiSrc, `cutConfigApi.${m} missing`).toMatch(new RegExp(`${m}\\(`));
    }
    // Sheet CRUD should no longer be in cutConfigApi
    expect(apiSrc).not.toMatch(/createSheetMaterialType/);
    expect(apiSrc).not.toMatch(/updateSheetMaterialType/);
    expect(apiSrc).not.toMatch(/deleteSheetMaterialType/);
    expect(tabSrc).toMatch(/cutConfigApi\.(create|update|delete)ParamProfile/);
    expect(tabSrc).toMatch(/cutConfigApi\.(create|update|delete)RenderPreset/);
  });

  it('passes the optimistic version on every edit/delete (stale-safe writes)', () => {
    expect(apiSrc).toMatch(/deleteWithVersion\(/);
  });

  it('enforces cut.manage for writes in the UI and cut.view to view', () => {
    expect(tabSrc).toMatch(/can\('cut\.view'\)/);
    expect(tabSrc).toMatch(/can\('cut\.manage'\)/);
  });

  it('is registered in /configuration only behind the useBackendCut flag', () => {
    expect(indexSrc).toMatch(/featureFlags\.useBackendCut[\s\S]*CutConfigTab/);
  });

  it('mounts the inline default-settings card and drops the JSON params dump', () => {
    expect(tabSrc).toMatch(/CutDefaultSettingsCard/);
    expect(tabSrc).toMatch(/summarizeParams\(/);
    expect(tabSrc).not.toMatch(/JSON\.stringify\(r\.params\)/);
  });

  it('ProfileModal exposes the same quality + group-shift controls as the default-settings card (parity)', () => {
    // «Качество» Segmented bound to params.quality
    expect(tabSrc).toMatch(/label="Качество"/);
    expect(tabSrc).toMatch(/setField\('quality',/);
    // «Сжимать группы деталей» Switch bound to params.groupShift
    expect(tabSrc).toMatch(/Сжимать группы деталей/);
    expect(tabSrc).toMatch(/setField\('groupShift',/);
    // these were previously absent from the created-profile form (locked to balanced + no group_shift)
    expect(tabSrc).toMatch(/<Segmented/);
  });

  it('ProfileModal offers «Сохранить как…» to clone a profile via the audited create command', () => {
    // Button text present (edit-mode clone entry point).
    expect(tabSrc).toMatch(/Сохранить как/);
    // A save-as prompt for the new copy name, seeded from buildProfileCopyName.
    expect(tabSrc).toMatch(/buildProfileCopyName\(/);
    expect(tabSrc).toMatch(/Сохранить как новый профиль/);
    // The copy is created (not updated) with isDefault:false via the existing backend command.
    expect(tabSrc).toMatch(/createParamProfile\(\{[\s\S]*isDefault:\s*false/);
  });

  it('vacuum_table option exists in the ProfileModal layout_mode control', () => {
    expect(tabSrc).toMatch(/vacuum_table/);
    expect(tabSrc).toMatch(/Вакуумный стол/);
  });

  it('vacuum-direction control is gated on params.layout_mode === vacuum_table in ProfileModal (structural guard)', () => {
    // The gate and the distinctive control token must appear together in one conditional block.
    // setField('vacuum', { direction: exists ONLY on the actual Radio.Group control, not on VACUUM_DIRECTION_META constants.
    // The regex matches: the gate `params.layout_mode === 'vacuum_table' && (` then zero or more characters
    // that do NOT contain `)}` (which would close the && expression), then the control's unique token.
    // If the gate were removed, the first part of the regex would not match, so the whole regex would fail.
    expect(tabSrc).toMatch(
      /params\.layout_mode\s*===\s*['"]vacuum_table['"]\s*&&\s*\((?:(?!\)\}).)*setField\('vacuum',\s*\{/s,
    );
  });

  it('renders the engine selector in both the profile modal and default settings', () => {
    const cardSrc = readFileSync(new URL('./CutDefaultSettingsCard.tsx', import.meta.url), 'utf8');
    for (const src of [tabSrc, cardSrc]) {
      expect(src).toContain('label="Движок расчёта"');
      expect(src).toContain("value: 'heuristic', label: 'Быстрый'");
      expect(src).toMatch(/vacuum_table.*(?:!==|hidden|display)/s);
      expect(src).toContain('detectEngineParamAnomalies');
    }
  });

  it('exposes a PDF template editor tab with expected editor commands', () => {
    expect(tabSrc).toMatch(/Редактирование шаблонов карт раскроя PDF/);
    expect(tabSrc).toMatch(/PdfTemplateEditor/);
    expect(apiSrc).toMatch(/listPdfTemplateFields\(/);
    expect(tabSrc).toMatch(/Сохранить как/);
    expect(tabSrc).toMatch(/Создать копию/);
    expect(tabSrc).toMatch(/onTemplateSaved/);
    expect(tabSrc).toMatch(/updatePdfTemplateInConfig/);
    expect(tabSrc).toMatch(/notifyCutPdfTemplatesChanged/);
    expect(tabSrc).toMatch(/publishDraftAsTemplate/);
    expect(tabSrc).toMatch(/autoPublishingDraftCodesRef/);
    expect(tabSrc).toMatch(/clearStoredPdfTemplateDrafts/);
    expect(tabSrc).toMatch(/renameSelectedTemplate/);
    expect(tabSrc).toMatch(/Название шаблона PDF/);
    expect(tabSrc).toMatch(/Укажите название шаблона PDF/);
    expect(tabSrc).toMatch(/createPdfTemplate/);
    expect(tabSrc).toMatch(/Шаблон PDF создан/);
    expect(tabSrc).not.toMatch(/const copyTemplate/);
    expect(tabSrc).not.toMatch(/Локальная копия шаблона PDF сохранена/);
    expect(tabSrc).toMatch(/\{\s*name:\s*templateName,\s*layout,\s*isActive:\s*template\.isActive\s*\}/);
    expect(tabSrc).toMatch(/Поля карты раскроя PDF/);
    expect(tabSrc).toMatch(/QR-код/);
    expect(tabSrc).toMatch(/sheet_thumbnail/);
    expect(tabSrc).toMatch(/fit:\s*'stretch'/);
    expect(tabSrc).toMatch(/normalizePdfElementStyle/);
    expect(tabSrc).toMatch(/compactPdfElementPatch/);
    expect(tabSrc).toMatch(/if \(patch\.w !== undefined\) next\.w/);
    expect(tabSrc).toMatch(/if \(patch\.h !== undefined\) next\.h/);
    expect(tabSrc).not.toMatch(/w:\s*patch\.w === undefined \? undefined/);
    expect(tabSrc).not.toMatch(/h:\s*patch\.h === undefined \? undefined/);
    expect(tabSrc).not.toMatch(/fit:\s*'contain'/);
    expect(tabSrc).not.toMatch(/value=\{String\(style\.fit \?\? 'contain'\)\}/);
    expect(tabSrc).not.toMatch(/Вписать/);
    expect(tabSrc).not.toMatch(/Заполнить/);
    expect(tabSrc).toMatch(/detail_table/);
    expect(tabSrc).toMatch(/machine_files_table/);
    expect(tabSrc).toMatch(/Миниатюра листа/);
    expect(tabSrc).toMatch(/Таблица деталей/);
    expect(tabSrc).toMatch(/Файлы станка/);
    expect(tabSrc).toMatch(/sheet\.machine_files/);
    expect(tabSrc).toMatch(/sheet\.utilization/);
    expect(tabSrc).toMatch(/Номер задания на раскрой/);
    expect(tabSrc).toMatch(/cut\.number/);
    expect(tabSrc).toMatch(/Номер раскроя/);
    expect(tabSrc).toMatch(/cut\.current_version/);
    expect(tabSrc).toMatch(/Текущая\/актуальная версия Карты раскроя/);
    expect(tabSrc).toMatch(/sheet\.film_requirement/);
    expect(tabSrc).toMatch(/Потребность в плёнке/);
    expect(tabSrc).toMatch(/BATH_PROFILE_PDF_ELEMENTS/);
    expect(tabSrc).toMatch(/defaultPdfElementsForTemplateCode/);
    expect(tabSrc).toMatch(/bath-label-ready-date/);
    expect(tabSrc).toMatch(/bath-field-material/);
    expect(tabSrc).toMatch(/bath-field-thickness/);
    expect(tabSrc).toMatch(/bath-field-utilization/);
    expect(tabSrc).toMatch(/detail\.machine_file/);
    expect(tabSrc).toMatch(/detail\.doweling/);
    expect(tabSrc).toMatch(/detail\.edge_types/);
    expect(tabSrc).toMatch(/PDF_AGGREGATE_SOURCES/);
    expect(tabSrc).toMatch(/sheet\.details/);
    expect(tabSrc).toMatch(/aggregateSources=\{PDF_AGGREGATE_SOURCES\}/);
    expect(tabSrc).toMatch(/PDF_PREVIEW_COLLECTIONS/);
    expect(tabSrc).toMatch(/Линия/);
    expect(tabSrc).toMatch(/Прямоугольник/);
    expect(tabSrc).toMatch(/PdfTemplateCanvas/);
    expect(tabSrc).not.toContain('Обкат: ${piece.edge}');
    expect(tabSrc).not.toContain('Фрезеровка: ${piece.milling}');
    expect(tabSrc).toMatch(/doweling:\s*true/);
    expect(tabSrc).toContain("...(piece.doweling ? ['присадка'] : [])");
    expect(tabSrc).toContain("text={detailMetaLines.join('\\n')}");
    expect(tabSrc).toMatch(/const orderFontSize = detailFontSize \* 1\.25/);
    expect(tabSrc).toMatch(/const detailMetaFontSize = orderFontSize \/ 2/);
    expect(tabSrc).toMatch(/const PDF_DETAIL_DIMENSION_FONT_SCALE = 1\.25/);
    expect(tabSrc).toMatch(/const standardDimensionFontSize = 3\.8 \* PDF_DETAIL_DIMENSION_FONT_SCALE/);
    expect(tabSrc).toMatch(/fontSize=\{orderFontSize\}/);
    expect(tabSrc).toMatch(/fontSize=\{detailMetaFontSize\}/);
    expect(tabSrc).toMatch(/fontSize=\{widthDimensionFontSize\}/);
    expect(tabSrc).toMatch(/fontSize=\{heightDimensionFontSize\}/);
    expect(tabSrc).toMatch(/fontStyle="bold"/);
    expect(tabSrc).toMatch(/widthLabel:\s*'800'/);
    expect(tabSrc).toMatch(/heightLabel:\s*'240'/);
    expect(tabSrc).toMatch(/text=\{piece\.widthLabel\}/);
    expect(tabSrc).toMatch(/text=\{piece\.heightLabel\}/);
    expect(tabSrc).toMatch(/rotation=\{-90\}/);
    expect(tabSrc).not.toMatch(/size:\s*'800×240'/);
    expect(tabSrc).toMatch(/const orderContourColors = new Map/);
    expect(tabSrc).toMatch(/fill="#ffffff" stroke=\{orderContourColors\.get\(piece\.order\) \?\? '#1f2d3d'\}/);
    expect(tabSrc).not.toMatch(/fill=\{orderContourColors\.get\(piece\.order\)/);
    expect(tabSrc).toMatch(/wrap="word"/);
    expect(tabSrc).toMatch(/customFieldRowsToSchema/);
    expect(tabSrc).toMatch(/CustomFieldExpressionEditor/);
    expect(tabSrc).toMatch(/customFieldSchema/);
    expect(tabSrc).toMatch(/sort:\s*\{\s*field:\s*'detail\.order'/);
    expect(tabSrc).toMatch(/readPdfDetailTableColumns/);
    expect(tabSrc).toMatch(/upgradeDefaultPdfDetailTableColumns/);
    expect(tabSrc).toMatch(/upgradeDefaultPdfElements/);
    expect(tabSrc).toMatch(/CUT_PDF_FIELD_DRAG_TYPE/);
    expect(tabSrc).toMatch(/resolveDroppedPdfField/);
    expect(tabSrc).toMatch(/wideCanvas/);
    expect(tabSrc).toMatch(/Широкий визуал/);
    expect(tabSrc).toMatch(/rightAccordionLayout/);
    expect(tabSrc).toMatch(/Панели справа/);
    expect(tabSrc).toMatch(/data-cut-pdf-context-menu/);
    expect(tabSrc).toMatch(/selectedElementIds/);
    expect(tabSrc).toMatch(/selectPdfElements/);
    expect(tabSrc).toMatch(/groupPdfElements/);
    expect(tabSrc).toMatch(/ungroupPdfElements/);
    expect(tabSrc).toMatch(/По горизонтальному центру канваса/);
    expect(tabSrc).toMatch(/По вертикальному центру канваса/);
    expect(tabSrc).toMatch(/Сгруппировать/);
    expect(tabSrc).toMatch(/Разгруппировать/);
    expect(tabSrc).toMatch(/Выравнивание значения/);
    expect(tabSrc).toMatch(/fontItalic/);
    expect(tabSrc).toMatch(/onPatchMany/);
    expect(tabSrc).toMatch(/estimatePdfFieldPaletteColumnWidth/);
    expect(tabSrc).toMatch(/cut-pdf-template-editor-field-col/);
    expect(tabSrc).toMatch(/cut-pdf-template-editor-canvas-col/);
    expect(tabSrc).toMatch(/renderCustomFieldPanel/);
    expect(tabSrc).toMatch(/ResizeObserver/);
    expect(tabSrc).toMatch(/isPdfDetailTableField/);
    expect(tabSrc).toMatch(/field\.source === 'detail'/);
    expect(tabSrc).toMatch(/field\.id\.startsWith\('detail\.'\)/);
    expect(tabSrc).not.toMatch(/onMouseDown=\{\(event\)[\s\S]{0,140}event\.preventDefault\(\)[\s\S]{0,140}onBeginDrag\(field\)/);
    expect(tabSrc).not.toMatch(/setCustomFieldsFromText/);
  });
});
