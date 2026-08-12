import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Collapse, Form, Input, InputNumber, Modal, Radio, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import { AlignCenterOutlined, AlignLeftOutlined, AlignRightOutlined, CopyOutlined, DeleteOutlined, EditOutlined, ImportOutlined, PictureOutlined, PlusOutlined, QrcodeOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type Konva from 'konva';
import { Group as KonvaGroup, Layer, Line as KonvaLine, Rect as KonvaRect, Stage, Text as KonvaText, Transformer } from 'react-konva';
import { labelsApi } from '../../../api/labelsApi';
import { ApiError } from '../../../api/apiError';
import { authSession } from '../../../api/authSession';
import type {
  LabelElementKind,
  LabelConditionBranch,
  LabelConditionOperator,
  LabelCustomFieldExpressionV1,
  LabelExportFormat,
  LabelFieldCatalogItem,
  LabelFieldCatalogSnapshot,
  LabelQrTemplate,
  LabelQrTemplateInput,
  LabelTemplate,
  LabelTemplateElement,
  LabelTemplateInput,
  LabelIfElseCondition,
  LabelRendererCapability,
} from '../../../api/types/labelsApi.types';
import { can } from '../../../utils/permissions';
import {
  extractQrTemplateFieldIds,
  qrErrorCorrectionOf,
  qrProtectedRect,
  qrSideOf,
  qrTemplateOf,
} from './labelQrHelpers';
import { collectDuplicateQrNames, qrDraftFromElement, qrElementFromLibrary, rowsToTemplate, sanitizeQrText, templateToRows, uniqueQrName, type QrRow } from './labelQrLibrary';
import {
  customFieldRowsFromSchema,
  customFieldRowsToSchema,
  customExpressionFieldIds,
  centerLabelSelection,
  claimLabelGestureCommit,
  describeLabelFieldSource,
  findSameRowHeightSuggestion,
  findCustomFieldDependencyCycle,
  groupLabelElements,
  labelConditionFieldIds,
  moveLabelDragGesture,
  normalizeLabelMultiSelectionTransform,
  readLabelEditorMeta,
  readLabelIfElseCondition,
  readAndNormalizeLabelTransformedNodes,
  readLabelTransformedNodes,
  readLabelTypography,
  evaluateCustomFieldPreviewValues,
  isCustomFieldExpressionValid,
  resolveLabelCanvasText,
  resolveLatestStateUpdate,
  selectLabelElements,
  snapElementCenters,
  summarizeCustomFieldExpression,
  ungroupLabelElements,
  withLabelEditorMeta,
  withLabelTypography,
  type AlignmentGuide,
  type CustomFieldSchemaRow,
  type CustomExpressionPreviewCollections,
  type CustomFieldType,
  type CustomFieldValueMode,
} from './labelTemplateEditorHelpers';
import { CustomFieldExpressionEditor, type CustomFieldAggregateSourceOption } from './CustomFieldExpressionEditor';
import { OcrTemplatesConfig } from './OcrTemplatesConfig';
import {
  labelEditorLayoutGeometry,
  loadLabelEditorLayoutMode,
  resolveLabelPreviewWidth,
  saveLabelEditorLayoutMode,
  type LabelEditorLayoutMode,
} from './labelEditorLayoutPreference';

const { Text } = Typography;
const { Panel } = Collapse;
const EXPORT_FORMATS: LabelExportFormat[] = ['bmp', 'png', 'emf'];
const CUSTOM_FIELD_TYPE_OPTIONS = [
  { value: 'string', label: 'Строка' },
  { value: 'number', label: 'Число' },
  { value: 'boolean', label: 'Да/нет' },
  { value: 'date', label: 'Дата' },
];
const PREVIEW_FIELD_VALUES: Record<string, string> = {
  'bazis.order_number': '548-16мм МДФ',
  'bazis.detail_id': '2590',
  'bazis.position': '27',
  'bazis.quantity': '1',
  'bazis.name': 'Фасад левый',
  'bazis.detail_length': '902',
  'bazis.detail_width': '596',
  'bazis.material': 'МДФ 16 мм',
  'bazis.comment': '',
  'date.today': '24.06.2026',
  'label.counter_text': 'Бир.№    1 / 0',
};
const LABEL_AGGREGATE_SOURCES: CustomFieldAggregateSourceOption[] = [
  { value: 'order.details', label: 'Детали заказа', fieldSource: 'detail' },
];
const LABEL_PREVIEW_COLLECTIONS: CustomExpressionPreviewCollections = {
  'order.details': [
    {
      'detail.detail_number': '27',
      'detail.detail_name': 'Фасад левый',
      'detail.edge_type_name': 'ПВХ 2мм',
      'detail.material_name': 'МДФ 16 мм',
      'detail.quantity': 1,
      'detail.width': 596,
      'detail.height': 902,
    },
    {
      'detail.detail_number': '28',
      'detail.detail_name': 'Фасад правый',
      'detail.edge_type_name': 'ABS 1мм',
      'detail.material_name': 'МДФ 16 мм',
      'detail.quantity': 2,
      'detail.width': 596,
      'detail.height': 902,
    },
    {
      'detail.detail_number': '29',
      'detail.detail_name': 'Перемычка',
      'detail.edge_type_name': 'ПВХ 2мм',
      'detail.material_name': 'МДФ 16 мм',
      'detail.quantity': 1,
      'detail.width': 120,
      'detail.height': 596,
    },
  ],
};
const QR_NAME_DUP_ERROR_PREFIX = 'QR_NAME_DUP:';
const QR_NAME_EMPTY_ERROR_PREFIX = 'QR_NAME_EMPTY:';
const QR_ERROR_CORRECTION_OPTIONS = [
  { value: 'L', label: 'L' },
  { value: 'M', label: 'M' },
  { value: 'Q', label: 'Q' },
  { value: 'H', label: 'H' },
];
const LABEL_CONDITION_OPERATOR_OPTIONS: Array<{ value: LabelConditionOperator; label: string }> = [
  { value: 'exists', label: 'существует' },
  { value: 'not_empty', label: 'не пусто' },
  { value: 'equals', label: 'равно' },
  { value: 'not_equals', label: 'не равно' },
];
const LABEL_CONDITION_BRANCH_OPTIONS: Array<{ value: LabelConditionBranch['type']; label: string }> = [
  { value: 'current', label: 'Текущее значение элемента' },
  { value: 'field', label: 'Другое поле' },
  { value: 'text', label: 'Фиксированный текст' },
  { value: 'hidden', label: 'Скрыть элемент' },
];

interface TemplateFormValues {
  name: string;
  description?: string;
  isActive: boolean;
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  defaultExportFormats: LabelExportFormat[];
}

interface BazisImportVariant {
  key: string;
  name: string;
  description: string;
  elements: LabelTemplateElement[];
  rowCount: number;
  templateFiles: string[];
}

interface CustomFieldFormValues {
  label: string;
  type: CustomFieldType;
  valueMode: CustomFieldValueMode;
  sourceField?: string;
  defaultValue?: unknown;
}

interface QrDraft {
  id: number | null;
  version: number | null;
  name: string;
  rows: QrRow[];
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  sizeMm: number;
}

type LabelPreviewDataMode = 'structure' | 'sample';

const EMPTY_QR_DRAFT: QrDraft = { id: null, version: null, name: '', rows: [[]], errorCorrection: 'M', sizeMm: 20 };

export const LabelsConfigTab: React.FC = () => {
  const canManage = can('labels.manage_templates');
  const layoutPreferenceUserId = authSession.getUser()?.id ?? 'anon';
  const [form] = Form.useForm<TemplateFormValues>();
  const [customFieldForm] = Form.useForm<CustomFieldFormValues>();
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [fields, setFields] = useState<LabelFieldCatalogItem[]>([]);
  const [rendererCapabilities, setRendererCapabilities] = useState<LabelRendererCapability[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<LabelTemplate | null>(null);
  const [elements, setElements] = useState<LabelTemplateElement[]>([]);
  const elementsRef = useRef<LabelTemplateElement[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldSchemaRow[]>([]);
  const customFieldsRef = useRef<CustomFieldSchemaRow[]>([]);
  const [customFieldEditorOpen, setCustomFieldEditorOpen] = useState(false);
  const [editingCustomFieldId, setEditingCustomFieldId] = useState<string | null>(null);
  const [customFieldExpression, setCustomFieldExpression] = useState<LabelCustomFieldExpressionV1>(() => defaultCustomFieldExpression());
  const [editorDirty, setEditorDirty] = useState(false);
  const [importVariants, setImportVariants] = useState<BazisImportVariant[]>([]);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [selectedElementKey, setSelectedElementKey] = useState<string | null>(null);
  const [selectedElementKeys, setSelectedElementKeys] = useState<string[]>([]);
  const [editorGestureActive, setEditorGestureActive] = useState(false);
  const editorGestureActiveRef = useRef(false);
  const [previewDataMode, setPreviewDataMode] = useState<LabelPreviewDataMode>('sample');
  const [conditionEditorKey, setConditionEditorKey] = useState<string | null>(null);
  const [conditionDraft, setConditionDraft] = useState<LabelIfElseCondition>(() => defaultIfElseCondition());
  const [fieldSearch, setFieldSearch] = useState('');
  const [draggingField, setDraggingField] = useState<LabelFieldCatalogItem | null>(null);
  const [dragCursor, setDragCursor] = useState<{ x: number; y: number } | null>(null);
  const [editorLayoutMode, setEditorLayoutMode] = useState<LabelEditorLayoutMode>(() => (
    loadLabelEditorLayoutMode(layoutPreferenceUserId)
  ));
  const [qrTemplates, setQrTemplates] = useState<LabelQrTemplate[]>([]);
  const [qrDraft, setQrDraft] = useState<QrDraft>(EMPTY_QR_DRAFT);
  const [qrTextDraftsByRow, setQrTextDraftsByRow] = useState<string[]>(['']);
  const [qrSaving, setQrSaving] = useState(false);
  const [qrFieldSearch, setQrFieldSearch] = useState('');
  const [draggingQrField, setDraggingQrField] = useState<LabelFieldCatalogItem | null>(null);
  const [qrFieldDragCursor, setQrFieldDragCursor] = useState<{ x: number; y: number } | null>(null);
  const [draggingQr, setDraggingQr] = useState<LabelQrTemplate | null>(null);
  const [qrDragCursor, setQrDragCursor] = useState<{ x: number; y: number } | null>(null);
  const [showAllBorders, setShowAllBorders] = useState(true);
  const qrRowDropRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Shared guard so ONE field drag from the QR builder's own palette resolves
  // exactly once. Both the per-row native onDrop (HTML5 drag'n'drop) and the
  // window pointerup/mouseup fallback below can fire on the same release,
  // which would otherwise add the same field chip twice (same bug class as
  // qrDropResolvedRef's canvas double-drop).
  const qrFieldChipResolvedRef = useRef(false);
  const previewWidthMm = Form.useWatch('canvasWidthMm', form);
  const previewHeightMm = Form.useWatch('canvasHeightMm', form);
  const customFieldValueMode = Form.useWatch('valueMode', customFieldForm);
  const customFieldType = Form.useWatch('type', customFieldForm);

  const setEditorElements = (
    update: React.SetStateAction<LabelTemplateElement[]>,
    markDirty = true,
  ) => {
    if (markDirty && (savingRef.current || editorGestureActiveRef.current)) return;
    const next = resolveLatestStateUpdate(elementsRef.current, update);
    elementsRef.current = next;
    setElements(next);
    if (markDirty) setEditorDirty(true);
  };

  const setEditorCustomFields = (
    update: React.SetStateAction<CustomFieldSchemaRow[]>,
    markDirty = true,
  ) => {
    if (markDirty && savingRef.current) return;
    const next = resolveLatestStateUpdate(customFieldsRef.current, update);
    customFieldsRef.current = next;
    setCustomFields(next);
    if (markDirty) setEditorDirty(true);
  };

  const setTemplateSaving = (next: boolean) => {
    savingRef.current = next;
    setSaving(next);
  };

  const setEditorGesture = (active: boolean) => {
    editorGestureActiveRef.current = active;
    setEditorGestureActive(active);
  };

  const setEditorSelection = (keys: string[]) => {
    setSelectedElementKeys(keys);
    setSelectedElementKey(keys.at(-1) ?? null);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [nextTemplates, nextFields, capabilitiesResponse] = await Promise.all([
        labelsApi.listTemplates(true),
        labelsApi.listFields(),
        labelsApi.getRendererCapabilities().catch(() => null),
      ]);
      setTemplates(nextTemplates);
      setFields(nextFields);
      setRendererCapabilities(
        capabilitiesResponse?.rendererCapabilities
        ?? [...new Set(nextTemplates.flatMap((template) => template.rendererCapabilities ?? []))],
      );
    } catch {
      message.error('Не удалось загрузить настройки бирок');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const loadQrTemplates = async () => {
    try {
      setQrTemplates(await labelsApi.listQrTemplates());
    } catch {
      setQrTemplates([]); // QR library unavailable — editor still works
    }
  };

  useEffect(() => {
    void loadQrTemplates();
  }, []);

  useEffect(() => {
    if (selectedTemplate) {
      form.setFieldsValue({
        name: selectedTemplate.name,
        description: selectedTemplate.description ?? '',
        isActive: selectedTemplate.isActive,
        canvasWidthMm: selectedTemplate.canvasWidthMm,
        canvasHeightMm: selectedTemplate.canvasHeightMm,
        dpi: selectedTemplate.dpi,
        defaultExportFormats: selectedTemplate.defaultExportFormats,
      });
      setEditorElements(selectedTemplate.elements, false);
      setEditorCustomFields(customFieldRowsFromSchema(selectedTemplate.customFieldSchema ?? {}), false);
      setEditorSelection([]);
      setEditorDirty(false);
    }
  }, [form, selectedTemplate]);

  const fieldCategories = useMemo(() => new Set(fields.map((field) => field.category)).size, [fields]);
  const advancedRendererReady = useMemo(
    () => rendererCapabilities.includes('if_else_v1') && rendererCapabilities.includes('typography_v1'),
    [rendererCapabilities],
  );
  const cutMapRendererReady = useMemo(
    () => rendererCapabilities.includes('cut_map_v1'),
    [rendererCapabilities],
  );
  const customExpressionRendererReady = useMemo(
    () => rendererCapabilities.includes('custom_expression_v1'),
    [rendererCapabilities],
  );
  const sourceFields = useMemo<LabelFieldCatalogItem[]>(
    () => [
      ...fields,
      ...customFields.map((row) => ({
        id: row.fieldId,
        source: 'dynamic' as const,
        sourceColumn: null,
        label: row.label || row.fieldId,
        type: row.type,
        category: 'Кастомные',
      })),
    ],
    [customFields, fields],
  );
  const customFieldPreview = useMemo(() => {
    const generated = Object.fromEntries(fields.map((field, index) => [field.id, sampleLabelFieldValue(field, index)]));
    try {
      return {
        values: evaluateCustomFieldPreviewValues(customFields, { ...generated, ...PREVIEW_FIELD_VALUES }, {
          collections: LABEL_PREVIEW_COLLECTIONS,
        }),
        error: null,
      };
    } catch (error) {
      return {
        values: {},
        error: error instanceof Error && error.message === 'LABEL_CUSTOM_EXPRESSION_RESULT_TOO_LONG'
          ? 'Результат формулы превышает 10 000 символов'
          : 'Не удалось вычислить пример формулы',
      };
    }
  }, [customFields, fields]);
  const customFieldPreviewValues = customFieldPreview.values;
  const customExpressionFields = useMemo(
    () => sourceFields.filter((field) => field.id !== editingCustomFieldId),
    [editingCustomFieldId, sourceFields],
  );
  // Global QR templates are backend-validated against built-in fields only (label-scoped
  // "Кастомные" fields are rejected with 422), so the QR builder's palette must never offer them.
  const qrPaletteFields = useMemo(
    () => fields.filter((field) => field.category !== 'Кастомные'),
    [fields],
  );
  const usedFieldIds = useMemo(
    () => {
      const ids = new Set(elements.map((element) => element.sourceField).filter((fieldId): fieldId is string => Boolean(fieldId)));
      for (const element of elements) {
        for (const fieldId of labelConditionFieldIds(element.condition)) ids.add(fieldId);
        if (element.kind !== 'qr') continue;
        for (const fieldId of extractQrTemplateFieldIds(qrTemplateOf(element))) {
          ids.add(fieldId);
        }
      }
      return ids;
    },
    [elements],
  );
  const templateFieldHealth = useMemo(
    () => compareFieldSnapshot(selectedTemplate?.fieldCatalogSnapshot ?? {}, sourceFields, usedFieldIds),
    [selectedTemplate?.fieldCatalogSnapshot, sourceFields, usedFieldIds],
  );
  const templatePaletteFields = useMemo(
    () => appendMissingSnapshotFields(sourceFields, selectedTemplate?.fieldCatalogSnapshot ?? {}, templateFieldHealth),
    [selectedTemplate?.fieldCatalogSnapshot, sourceFields, templateFieldHealth],
  );
  const selectedQrTemplate = useMemo(
    () => qrTemplates.find((template) => template.labelQrTemplateId === qrDraft.id) ?? null,
    [qrDraft.id, qrTemplates],
  );
  const qrReferencedFieldIds = useMemo(
    () => new Set(qrDraft.rows.flatMap((row) => row.filter((chip) => chip.kind === 'field').map((chip) => chip.fieldId))),
    [qrDraft.rows],
  );
  const qrFieldHealth = useMemo(
    () => compareFieldSnapshot(selectedQrTemplate?.fieldCatalogSnapshot ?? {}, qrPaletteFields, qrReferencedFieldIds),
    [qrPaletteFields, qrReferencedFieldIds, selectedQrTemplate?.fieldCatalogSnapshot],
  );
  const qrEditorFields = useMemo(
    () => appendMissingSnapshotFields(qrPaletteFields, selectedQrTemplate?.fieldCatalogSnapshot ?? {}, qrFieldHealth),
    [qrFieldHealth, qrPaletteFields, selectedQrTemplate?.fieldCatalogSnapshot],
  );

  useEffect(() => {
    if (!draggingField) {
      setDragCursor(null);
      return;
    }
    const handleMove = (event: PointerEvent | MouseEvent) => {
      setDragCursor({ x: event.clientX, y: event.clientY });
    };
    const handleEnd = () => {
      setDraggingField(null);
      setDragCursor(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('mouseup', handleEnd);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('mouseup', handleEnd);
    };
  }, [draggingField]);

  // Fallback drag: a field dragged from the QR builder's own palette is appended as a
  // chip to whichever row's drop zone the pointer is released over (mirrors draggingField
  // above, but resolved per-row since the builder now has multiple independent rows).
  // Also tracks the cursor position (mirrors the draggingField/draggingQr cursor effects)
  // so a floating ghost badge with the field's label can follow the pointer while it's
  // "picked up" — previously this drag had no visual feedback at all.
  useEffect(() => {
    if (!draggingQrField) {
      setQrFieldDragCursor(null);
      return;
    }
    qrFieldChipResolvedRef.current = false;
    const handleMove = (event: PointerEvent | MouseEvent) => {
      setQrFieldDragCursor({ x: event.clientX, y: event.clientY });
    };
    const handleEnd = (event: PointerEvent | MouseEvent) => {
      if (qrFieldChipResolvedRef.current) {
        setDraggingQrField(null);
        setQrFieldDragCursor(null);
        return;
      }
      let targetRow: number | null = null;
      qrRowDropRefs.current.forEach((el, rowIndex) => {
        const rect = el.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (inside) targetRow = rowIndex;
      });
      if (targetRow != null) {
        qrFieldChipResolvedRef.current = true;
        addQrFieldChip(targetRow, draggingQrField);
      }
      setDraggingQrField(null);
      setQrFieldDragCursor(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('mouseup', handleEnd);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('mouseup', handleEnd);
    };
  }, [draggingQrField]);

  // The draggable QR-library icon: tracks cursor position for the floating drag badge and
  // clears the drag state on release (mirrors the draggingField effect above). The actual
  // drop-onto-canvas resolution happens in LabelTemplatePreview's own capture-phase listener,
  // which runs before this bubble-phase listener clears draggingQr.
  useEffect(() => {
    if (!draggingQr) {
      setQrDragCursor(null);
      return;
    }
    const handleMove = (event: PointerEvent | MouseEvent) => {
      setQrDragCursor({ x: event.clientX, y: event.clientY });
    };
    const handleEnd = () => {
      setDraggingQr(null);
      setQrDragCursor(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('mouseup', handleEnd);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('mouseup', handleEnd);
    };
  }, [draggingQr]);

  const startNew = () => {
    if (saving || editorGestureActiveRef.current) return;
    setSelectedTemplate(null);
    setEditorElements([
      {
        elementKey: `text-${Date.now()}`,
        kind: 'text',
        sourceField: 'bazis.order_number',
        staticText: null,
        xMm: 2,
        yMm: 2,
        widthMm: 60,
        heightMm: 6,
        rotationDeg: 0,
        zIndex: 0,
        style: newLabelTextStyle(advancedRendererReady),
        condition: {},
      },
    ], false);
    setEditorCustomFields([], false);
    setEditorSelection([]);
    setEditorDirty(false);
    form.setFieldsValue({
      name: '',
      description: '',
      isActive: true,
      canvasWidthMm: 85,
      canvasHeightMm: 88,
      dpi: 203,
      defaultExportFormats: ['bmp', 'png', 'emf'],
    });
  };

  const buildTemplatePayload = (values: TemplateFormValues, name = values.name): LabelTemplateInput => {
    const currentElements = elementsRef.current;
    const customFieldSchema = customFieldRowsToSchema(customFieldsRef.current);
    // QR is a first-class element: it may freely overlap other elements and sit
    // anywhere on the canvas (use z-index layering). Overlap/out-of-bounds is NOT
    // a conflict and never blocks saving.
    //
    // A placed QR must carry a non-empty, per-label-unique name (backend contract).
    // Rather than REFUSE a save on a missing name, AUTO-FILL every empty QR name
    // with a unique default — this covers an unnamed QR from the toolbar button or
    // an older template — so saving never blocks on a missing name. Only a genuine
    // duplicate of two user-typed names is still surfaced (rare, actionable).
    const usedQrNames = new Set(
      currentElements
        .filter((element) => element.kind === 'qr')
        .map((element) => String((element.style as Record<string, unknown> | undefined)?.qrName ?? '').trim())
        .filter(Boolean),
    );
    const namedElements = currentElements.map((element) => {
      if (element.kind !== 'qr') return element;
      const raw = String((element.style as Record<string, unknown> | undefined)?.qrName ?? '').trim();
      if (raw) return element;
      const filled = uniqueQrName('QR', [...usedQrNames]);
      usedQrNames.add(filled);
      return { ...element, style: { ...((element.style as Record<string, unknown>) ?? {}), qrName: filled } };
    });
    const dupes = collectDuplicateQrNames(namedElements);
    if (dupes.length > 0) {
      throw new Error(`${QR_NAME_DUP_ERROR_PREFIX}${dupes.join(', ')}`);
    }
    return {
      name: name.trim(),
      description: values.description?.trim() || null,
      isActive: values.isActive ?? true,
      canvasWidthMm: values.canvasWidthMm,
      canvasHeightMm: values.canvasHeightMm,
      dpi: values.dpi,
      defaultExportFormats: values.defaultExportFormats,
      customFieldSchema,
      elements: toTemplateElementInput(namedElements),
      idempotencyKey: `label-template-${Date.now()}`,
    };
  };

  const describeSaveError = (error: unknown, fallback: string): string => {
    if (error instanceof ApiError) {
      if (error.code === 'LABEL_QR_NAME_REQUIRED') {
        return 'У каждого QR-кода должно быть имя (заполните «Имя QR»).';
      }
      if (error.code === 'LABEL_QR_NAME_DUPLICATE') {
        return 'Имена QR-кодов должны быть уникальны: имя уже используется в этом шаблоне.';
      }
      if (error.code === 'LABEL_CUSTOM_EXPRESSION_INVALID') {
        return 'Проверьте формулы пользовательских полей: найдена некорректная ссылка, структура или циклическая зависимость.';
      }
      if (error.code === 'LABEL_CUSTOM_EXPRESSION_RESULT_TOO_LONG') {
        return 'Результат формулы пользовательского поля превышает 10 000 символов.';
      }
    }
    if (error instanceof Error) {
      if (error.message.startsWith(QR_NAME_DUP_ERROR_PREFIX)) {
        const dupes = error.message.slice(QR_NAME_DUP_ERROR_PREFIX.length);
        return `Имена QR-кодов должны быть уникальны: ${dupes}`;
      }
      if (error.message.startsWith(QR_NAME_EMPTY_ERROR_PREFIX)) {
        const count = error.message.slice(QR_NAME_EMPTY_ERROR_PREFIX.length);
        return `Заполните имя для каждого QR-кода (QR без имени: ${count}).`;
      }
    }
    return fallback;
  };

  const saveTemplate = async (values: TemplateFormValues) => {
    if (!canManage || saving || qrSaving) return;
    if (editorGestureActiveRef.current) {
      message.warning('Завершите изменение элементов на канвасе перед сохранением');
      return;
    }
    if (!advancedRendererReady && elementsRef.current.some(hasAdvancedLabelElementData)) {
      message.error('Backend ещё не подтвердил новый renderer шаблонов. Сохранение расширенных настроек заблокировано.');
      return;
    }
    if (!customExpressionRendererReady && customFieldsRef.current.some((row) => row.valueMode === 'expression')) {
      message.error('Backend ещё не подтвердил поддержку формул пользовательских полей. Сохранение заблокировано.');
      return;
    }
    setTemplateSaving(true);
    try {
      const payload = buildTemplatePayload(values);
      let saved: LabelTemplate;
      if (selectedTemplate) {
        saved = await labelsApi.updateTemplate(selectedTemplate.labelTemplateId, { ...payload, version: selectedTemplate.version });
        message.success('Шаблон обновлён');
      } else {
        saved = await labelsApi.createTemplate(payload);
        message.success('Шаблон создан');
      }
      await load();
      // Keep the just-saved template open in the editor (mirrors saveTemplateAs).
      // Resetting to the blank new-template scaffold here read as "switched to
      // another template" after every save.
      setSelectedTemplate(saved);
      setEditorElements(saved.elements, false);
      setEditorCustomFields(customFieldRowsFromSchema(saved.customFieldSchema ?? {}), false);
      setEditorDirty(false);
    } catch (error) {
      message.error(describeSaveError(error, 'Не удалось сохранить шаблон'));
    } finally {
      setTemplateSaving(false);
    }
  };

  const openSaveAs = async () => {
    if (!canManage || saving || qrSaving || editorGestureActiveRef.current) return;
    const values = await form.validateFields();
    setSaveAsName(`${values.name.trim() || selectedTemplate?.name || 'Шаблон'} — копия`);
    setSaveAsOpen(true);
  };

  const saveTemplateAs = async () => {
    if (!canManage || saving || qrSaving || editorGestureActiveRef.current) return;
    const name = saveAsName.trim();
    if (!name) {
      message.error('Введите название копии');
      return;
    }
    if (!advancedRendererReady && elementsRef.current.some(hasAdvancedLabelElementData)) {
      message.error('Backend ещё не подтвердил новый renderer шаблонов. Копирование расширенного шаблона заблокировано.');
      return;
    }
    if (!customExpressionRendererReady && customFieldsRef.current.some((row) => row.valueMode === 'expression')) {
      message.error('Backend ещё не подтвердил поддержку формул пользовательских полей. Копирование заблокировано.');
      return;
    }
    setTemplateSaving(true);
    try {
      const values = await form.validateFields();
      const created = await labelsApi.createTemplate(buildTemplatePayload(values, name));
      message.success('Копия шаблона создана');
      setSaveAsOpen(false);
      setSaveAsName('');
      await load();
      setSelectedTemplate(created);
      setEditorElements(created.elements, false);
      setEditorCustomFields(customFieldRowsFromSchema(created.customFieldSchema ?? {}), false);
      setEditorDirty(false);
    } catch (error) {
      message.error(describeSaveError(error, 'Не удалось создать копию шаблона'));
    } finally {
      setTemplateSaving(false);
    }
  };

  const addElement = (kind: LabelElementKind) => {
    if (!canManage || saving || editorGestureActiveRef.current) return;
    if (kind === 'cut_map' && elementsRef.current.some((element) => element.kind === 'cut_map')) {
      message.warning('На бирке уже есть миниатюра раскроя');
      return;
    }
    const elementKey = `${kind}-${Date.now()}`;
    setEditorElements((current) => {
      const nextElement: LabelTemplateElement = {
        elementKey,
        kind,
        sourceField: null,
        staticText: kind === 'text' ? 'Новый текст' : null,
        xMm: kind === 'qr' ? 10 : 2,
        yMm: kind === 'qr' ? 10 : 2 + current.length * 6,
        widthMm: kind === 'line' ? 60 : kind === 'qr' ? 20 : kind === 'cut_map' ? 40 : 40,
        heightMm: kind === 'line' ? 0 : kind === 'qr' ? 20 : kind === 'cut_map' ? 28 : 6,
        rotationDeg: 0,
        zIndex: current.length,
        style: kind === 'cut_map'
          ? {
              cutMap: {
                version: 1,
                fit: 'contain',
                highlightFill: '#ffd666',
                highlightStroke: '#d4380d',
              },
            }
          : kind === 'qr'
          ? {
              qrName: uniqueQrName(
                'QR',
                current
                  .filter((element) => element.kind === 'qr')
                  .map((element) => String((element.style as Record<string, unknown> | undefined)?.qrName ?? '')),
              ),
              qrTemplate: '{bazis.detail_id}',
              qrErrorCorrection: 'M',
            }
          : kind === 'text'
            ? newLabelTextStyle(advancedRendererReady)
            : {},
        condition: {},
      };
      // QR is a first-class element: it may freely overlap others and sit anywhere
      // on the canvas (no auto-shift, no overlap/out-of-bounds conflict). A default
      // unique qrName is assigned so the save-time name contract is never tripped
      // for a freshly-added QR.
      return [...current, nextElement];
    });
    setEditorSelection([elementKey]);
  };

  const patchElement = (index: number, patch: Partial<LabelTemplateElement>) => {
    setEditorElements((current) => current.map((element, i) => {
      if (i !== index) return element;
      const updated = { ...element, ...patch };
      return advancedRendererReady && element.kind === 'text' && (patch.widthMm !== undefined || patch.heightMm !== undefined)
        ? withLabelEditorMeta(updated, { boundsMode: 'manual' })
        : updated;
    }));
  };

  const patchElementsByKey = (patches: Array<{ elementKey: string; patch: Partial<LabelTemplateElement> }>) => {
    if (savingRef.current) return;
    const byKey = new Map(patches.map((entry) => [entry.elementKey, entry.patch]));
    const next = elementsRef.current.map((element) => {
      const patch = byKey.get(element.elementKey);
      if (!patch) return element;
      const updated = { ...element, ...patch };
      return advancedRendererReady && element.kind === 'text' && (patch.widthMm !== undefined || patch.heightMm !== undefined)
        ? withLabelEditorMeta(updated, { boundsMode: 'manual' })
        : updated;
    });
    elementsRef.current = next;
    setElements(next);
    setEditorDirty(true);
  };

  const currentCanvasBounds = () => ({
    widthMm: Number(form.getFieldValue('canvasWidthMm') ?? selectedTemplate?.canvasWidthMm ?? 85),
    heightMm: Number(form.getFieldValue('canvasHeightMm') ?? selectedTemplate?.canvasHeightMm ?? 88),
  });

  const openCustomFieldEditor = (row?: CustomFieldSchemaRow) => {
    if (!canManage || savingRef.current) return;
    setEditingCustomFieldId(row?.fieldId ?? null);
    setCustomFieldExpression(row?.expression ?? defaultCustomFieldExpression(fields[0]?.id));
    customFieldForm.setFieldsValue({
      label: row?.label ?? '',
      type: row?.valueMode === 'expression' ? 'string' : row?.type ?? 'string',
      valueMode: row?.valueMode ?? 'constant',
      sourceField: row?.sourceField ?? undefined,
      defaultValue: row?.defaultValue ?? '',
    });
    setCustomFieldEditorOpen(true);
  };

  const saveCustomField = async () => {
    if (!canManage || savingRef.current) return;
    let values: CustomFieldFormValues;
    try {
      values = await customFieldForm.validateFields();
    } catch {
      return;
    }
    if (savingRef.current) return;
    const duplicate = customFieldsRef.current.some((row) => (
      row.fieldId !== editingCustomFieldId &&
      row.label.trim().localeCompare(values.label.trim(), 'ru', { sensitivity: 'accent' }) === 0
    ));
    if (duplicate) {
      message.error('Пользовательское поле с таким названием уже существует');
      return;
    }
    const fieldId = editingCustomFieldId ?? `custom.field_${Date.now()}`;
    const existing = customFieldsRef.current.find((row) => row.fieldId === fieldId);
    if (values.valueMode === 'expression') {
      if (!customExpressionRendererReady) {
        message.error('Backend ещё не подтвердил поддержку формул пользовательских полей');
        return;
      }
      const allowedFieldIds = new Set(customExpressionFields.map((field) => field.id));
      if (!isCustomFieldExpressionValid(customFieldExpression, allowedFieldIds)) {
        message.error('Заполните все поля формулы и удалите недоступные ссылки');
        return;
      }
    }
    const nextRow: CustomFieldSchemaRow = {
      fieldId,
      label: values.label.trim(),
      type: values.valueMode === 'expression' ? 'string' : values.type,
      valueMode: values.valueMode,
      sourceField: values.valueMode === 'source' ? values.sourceField ?? null : null,
      defaultValue: values.valueMode === 'constant'
        ? values.defaultValue ?? ''
        : null,
      expression: values.valueMode === 'expression' ? customFieldExpression : null,
      extra: existing?.extra ?? {},
    };
    const candidateRows = customFieldsRef.current.some((row) => row.fieldId === fieldId)
      ? customFieldsRef.current.map((row) => (row.fieldId === fieldId ? nextRow : row))
      : [...customFieldsRef.current, nextRow];
    if (candidateRows.some((row) => row.valueMode === 'expression') && candidateRows.length > 100) {
      message.error('В шаблоне с формулами может быть не больше 100 пользовательских полей');
      return;
    }
    const cycle = findCustomFieldDependencyCycle(candidateRows);
    if (cycle) {
      const labelsById = new Map(candidateRows.map((row) => [row.fieldId, row.label]));
      message.error(`Циклическая зависимость: ${cycle.map((id) => labelsById.get(id) ?? id).join(' → ')}`);
      return;
    }
    setEditorCustomFields((current) => {
      const index = current.findIndex((row) => row.fieldId === fieldId);
      return index === -1
        ? [...current, nextRow]
        : current.map((row) => (row.fieldId === fieldId ? nextRow : row));
    });
    setCustomFieldEditorOpen(false);
    setEditingCustomFieldId(null);
    setCustomFieldExpression(defaultCustomFieldExpression());
    customFieldForm.resetFields();
  };

  const deleteCustomField = (fieldId: string) => {
    if (!canManage || savingRef.current) return;
    const used = elementsRef.current.some((element) => (
      element.sourceField === fieldId
      || labelConditionFieldIds(element.condition).includes(fieldId)
      || (element.kind === 'qr' && extractQrTemplateFieldIds(qrTemplateOf(element)).includes(fieldId))
    ));
    const dependedOn = customFieldsRef.current.some((row) => (
      row.fieldId !== fieldId
      && row.expression
      && customExpressionFieldIds(row.expression).includes(fieldId)
    ));
    if (dependedOn) {
      message.error('Поле используется в другой формуле. Сначала удалите эту ссылку.');
      return;
    }
    if (used) {
      message.error('Поле размещено на бирке. Сначала удалите связанный элемент или выберите для него другое поле.');
      return;
    }
    setEditorCustomFields((current) => current.filter((row) => row.fieldId !== fieldId));
  };

  const moveElement = (elementKey: string, xMm: number, yMm: number) => {
    const target = elementsRef.current.find((element) => element.elementKey === elementKey);
    if (target?.kind === 'qr') {
      applyQrGeometryPatch(elementKey, { xMm: roundMm(xMm), yMm: roundMm(yMm) });
      return;
    }
    setEditorElements((current) =>
      current.map((element) =>
        element.elementKey === elementKey
          ? { ...element, xMm: roundMm(xMm), yMm: roundMm(yMm) }
          : element,
      ),
    );
  };

  const patchElementByKey = (elementKey: string, patch: Partial<LabelTemplateElement>) => {
    const target = elementsRef.current.find((element) => element.elementKey === elementKey);
    if (target?.kind === 'qr' && (patch.xMm !== undefined || patch.yMm !== undefined || patch.widthMm !== undefined || patch.heightMm !== undefined)) {
      applyQrGeometryPatch(elementKey, patch);
      return;
    }
    setEditorElements((current) => current.map((element) => {
      if (element.elementKey !== elementKey) return element;
      const updated = { ...element, ...patch };
      return advancedRendererReady && element.kind === 'text' && (patch.widthMm !== undefined || patch.heightMm !== undefined)
        ? withLabelEditorMeta(updated, { boundsMode: 'manual' })
        : updated;
    }));
  };

  // Applies a QR move/resize/geometry patch. QR is a free-overlap element, so
  // nothing is pushed and there is no conflict tracking — the patch simply lands
  // and the QR is kept square (side = max of width/height via qrSideOf).
  const applyQrGeometryPatch = (elementKey: string, patch: Partial<LabelTemplateElement>) => {
    setEditorElements((current) => {
      const currentQr = current.find((element) => element.elementKey === elementKey);
      if (!currentQr || currentQr.kind !== 'qr') {
        return current.map((element) => (element.elementKey === elementKey ? { ...element, ...patch } : element));
      }
      const updated = current.map((element) => {
        if (element.elementKey !== elementKey) return element;
        // A QR stays square (side = max of width/height, floor MIN_QR_SIDE_MM via
        // qrSideOf) and keeps its error-correction level defaulted.
        const merged = { ...element, ...patch };
        const side = qrSideOf(merged);
        return {
          ...merged,
          kind: 'qr' as const,
          sourceField: null,
          staticText: null,
          widthMm: side,
          heightMm: side,
          style: {
            ...(merged.style ?? {}),
            qrErrorCorrection: qrErrorCorrectionOf(merged),
          },
        };
      });
      return updated;
    });
  };

  const patchQrStyle = (index: number, patch: Record<string, unknown>) => {
    setEditorElements((current) => current.map((element, i) => (
      i === index
        ? { ...element, style: { ...(element.style ?? {}), ...patch } }
        : element
    )));
  };

  const patchElementTypography = (
    index: number,
    patch: { fontSizePt?: number; fontWeight?: 'normal' | 'bold'; italic?: boolean },
  ) => {
    setEditorElements((current) => current.map((element, currentIndex) => (
      currentIndex === index && element.kind === 'text'
        ? withLabelTypography(element, patch)
        : element
    )));
  };

  const openElementCondition = (element: LabelTemplateElement) => {
    if (element.kind !== 'text' || !advancedRendererReady) return;
    const current = readLabelIfElseCondition(element.condition);
    setConditionDraft(current ?? defaultIfElseCondition(element.sourceField ?? sourceFields[0]?.id));
    setConditionEditorKey(element.elementKey);
  };

  const saveElementCondition = () => {
    if (!conditionEditorKey || !advancedRendererReady) return;
    patchElementByKey(conditionEditorKey, { condition: conditionDraft as unknown as Record<string, unknown> });
    setConditionEditorKey(null);
  };

  const clearElementCondition = () => {
    if (!conditionEditorKey) return;
    patchElementByKey(conditionEditorKey, { condition: {} });
    setConditionEditorKey(null);
  };

  const changeElementKind = (index: number, kind: LabelElementKind) => {
    const current = elementsRef.current[index];
    if (!current) return;
    if (kind === 'cut_map' && elementsRef.current.some((element, currentIndex) => currentIndex !== index && element.kind === 'cut_map')) {
      message.warning('На бирке уже есть миниатюра раскроя');
      return;
    }
    const patch: Partial<LabelTemplateElement> = {
      kind,
      sourceField: kind === 'text' ? current.sourceField ?? 'bazis.name' : null,
      staticText: kind === 'text' ? current.staticText ?? null : null,
      heightMm: kind === 'line' ? 0 : kind === 'qr' ? qrSideOf(current) : kind === 'cut_map' ? Math.max(10, Number(current.heightMm ?? 28)) : Math.max(6, Number(current.heightMm ?? 6)),
      widthMm: kind === 'qr' ? qrSideOf(current) : kind === 'line' ? Math.max(10, Number(current.widthMm ?? 60)) : kind === 'cut_map' ? Math.max(10, Number(current.widthMm ?? 40)) : Number(current.widthMm ?? 40),
      style: kind === 'cut_map'
        ? {
            cutMap: {
              version: 1,
              fit: 'contain',
              highlightFill: '#ffd666',
              highlightStroke: '#d4380d',
            },
          }
        : kind === 'qr'
        ? { ...withoutCutMapStyle(current.style), qrTemplate: qrTemplateOf(current) || '{bazis.detail_id}', qrErrorCorrection: qrErrorCorrectionOf(current) }
        : { ...withoutCutMapStyle(current.style), fontSize: Number(current.style?.fontSize ?? 12) },
      condition: kind === 'text' ? current.condition ?? {} : {},
    };
    if (kind === 'qr') {
      applyQrGeometryPatch(current.elementKey, patch);
      return;
    }
    patchElement(index, patch);
  };

  const deleteElementByKey = (elementKey: string) => {
    const keys = selectedElementKeys.includes(elementKey)
      ? selectedElementKeys
      : selectLabelElements(elementsRef.current, [], elementKey, false);
    const selected = elementsRef.current.filter((element) => keys.includes(element.elementKey));
    if (selected.some(isLabelElementLocked)) {
      message.warning('Сначала разблокируйте все элементы группы');
      return;
    }
    const removed = new Set(keys);
    setEditorElements((current) => cleanupSingletonLabelGroups(current.filter((element) => !removed.has(element.elementKey))));
    setEditorSelection([]);
  };

  const groupSelectedElements = (keys: string[]) => {
    if (!advancedRendererReady) {
      message.warning('Группировка станет доступна после обновления renderer backend');
      return;
    }
    const selected = elementsRef.current.filter((element) => keys.includes(element.elementKey));
    if (selected.length < 2 || selected.some(isLabelElementLocked)) return;
    const groupId = `label-group-${Date.now()}`;
    const grouped = groupLabelElements(elementsRef.current, keys, groupId);
    setEditorElements(grouped);
    setEditorSelection(grouped.filter((element) => readLabelEditorMeta(element).groupId === groupId).map((element) => element.elementKey));
  };

  const ungroupSelectedElements = (keys: string[]) => {
    const selected = elementsRef.current.filter((element) => keys.includes(element.elementKey));
    if (selected.length === 0 || selected.some(isLabelElementLocked)) return;
    setEditorElements(ungroupLabelElements(elementsRef.current, keys));
    setEditorSelection(keys);
  };

  const centerSelectedElements = (keys: string[], axis: 'horizontal' | 'vertical') => {
    const selected = elementsRef.current.filter((element) => keys.includes(element.elementKey));
    if (selected.length === 0 || selected.some(isLabelElementLocked)) return;
    const bounds = currentCanvasBounds();
    setEditorElements(centerLabelSelection(elementsRef.current, keys, bounds.widthMm, bounds.heightMm, axis));
  };

  // Both the Konva preview (`sorted` in LabelTemplatePreview) and the server SVG
  // renderer (label-renderer.ts) draw elements ordered by ascending `zIndex`, so
  // reordering must reassign zIndex across the whole array (not just move the
  // element within `elements`) for a visible draw-order change. The array order
  // is kept in sync with the new zIndex order too, since it doubles as a stable
  // tie-breaker / display order elsewhere.
  const bringElementToFront = (elementKey: string) => {
    setEditorElements((current) => {
      const index = current.findIndex((element) => element.elementKey === elementKey);
      if (index === -1) return current;
      const target = current[index];
      const rest = [...current.slice(0, index), ...current.slice(index + 1)];
      return [...rest, target].map((element, i) => ({ ...element, zIndex: i }));
    });
  };

  const sendElementToBack = (elementKey: string) => {
    setEditorElements((current) => {
      const index = current.findIndex((element) => element.elementKey === elementKey);
      if (index === -1) return current;
      const target = current[index];
      const rest = [...current.slice(0, index), ...current.slice(index + 1)];
      return [target, ...rest].map((element, i) => ({ ...element, zIndex: i }));
    });
  };

  const duplicateElementByKey = (elementKey: string) => {
    const keys = selectedElementKeys.includes(elementKey)
      ? selectedElementKeys
      : selectLabelElements(elementsRef.current, [], elementKey, false);
    const source = elementsRef.current.filter((element) => keys.includes(element.elementKey));
    if (source.length === 0) return;
    if (source.some((element) => element.kind === 'cut_map')) {
      message.warning('Миниатюра раскроя может быть только одна');
      return;
    }
    const freshGroupId = source.length > 1 || source.some((element) => readLabelEditorMeta(element).groupId)
      ? `label-group-copy-${Date.now()}`
      : null;
    let nextZ = Math.max(0, ...elementsRef.current.map((element) => Number(element.zIndex ?? 0))) + 1;
    const copies = source.map((element, index) => {
      const copyKey = `${element.elementKey}-copy-${Date.now()}-${index}`;
      const copy = withLabelEditorMeta({
        ...element,
        labelTemplateElementId: undefined,
        elementKey: copyKey,
        xMm: roundMm(Number(element.xMm ?? 0) + 2),
        yMm: roundMm(Number(element.yMm ?? 0) + 2),
        zIndex: nextZ++,
        style: { ...(element.style ?? {}), locked: false },
      }, { groupId: freshGroupId });
      return copy;
    });
    setEditorElements((current) => [...current, ...copies]);
    setEditorSelection(copies.map((element) => element.elementKey));
  };

  const addFieldElement = (field: LabelFieldCatalogItem, xMm: number, yMm: number) => {
    if (!canManage || saving) return;
    const elementKey = `field-${field.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}`;
    const element: LabelTemplateElement = {
      elementKey,
      kind: 'text',
      sourceField: field.id,
      staticText: null,
      xMm: roundMm(xMm),
      yMm: roundMm(yMm),
      widthMm: 40,
      heightMm: 6,
      rotationDeg: 0,
      zIndex: elementsRef.current.length,
      style: newLabelTextStyle(advancedRendererReady),
      condition: {},
    };
    setEditorElements((current) => [...current, element]);
    setEditorSelection([elementKey]);
  };

  const onDropDraggingQr = (payload: LabelQrTemplate, xMm: number, yMm: number) => {
    if (!canManage || saving) return;
    const el = qrElementFromLibrary(
      {
        name: payload.name,
        contentTemplate: payload.contentTemplate,
        errorCorrection: payload.errorCorrection,
        defaultSizeMm: payload.defaultSizeMm,
        sourceTemplateId: payload.labelQrTemplateId,
      },
      xMm,
      yMm,
      elementsRef.current,
    );
    el.elementKey = `qr-${Date.now()}`;
    const bounds = currentCanvasBounds();
    // Clamp by the QR's own size so it can never land partly outside the canvas
    // (a top-left-only clamp let the right/bottom edge spill out → permanent
    // out-of-bounds conflict that blocked saving).
    el.xMm = roundMm(Math.min(Math.max(el.xMm, 0), Math.max(0, bounds.widthMm - el.widthMm)));
    el.yMm = roundMm(Math.min(Math.max(el.yMm, 0), Math.max(0, bounds.heightMm - el.heightMm)));
    // QR drops exactly where placed (clamped inside the canvas). It may freely
    // overlap other elements — overlap is allowed (use z-index layering), so
    // nothing is pushed and there is no conflict.
    setEditorElements((current) => [...current, el]);
    setEditorSelection([el.elementKey]);
  };

  const handleBazisImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const variants = parseBazisTemplateVariants(text, file.name);
      setImportFileName(file.name);
      setImportVariants(variants);
      if (variants.length === 0) {
        message.warning('В файле не найдено вариантов шаблонов бирок');
      } else {
        message.success(`Найдено вариантов: ${variants.length}`);
      }
    } catch {
      message.error('Не удалось разобрать Bazis .xbir файл');
    }
  };

  const applyImportVariant = (variant: BazisImportVariant) => {
    if (saving) return;
    setSelectedTemplate(null);
    setEditorElements(variant.elements);
    setEditorCustomFields([]);
    form.setFieldsValue({
      name: variant.name,
      description: variant.description,
      isActive: true,
      canvasWidthMm: 85,
      canvasHeightMm: 88,
      dpi: 203,
      defaultExportFormats: ['bmp', 'png', 'emf'],
    });
  };

  const resetQrDraft = () => {
    setQrDraft(EMPTY_QR_DRAFT);
    setQrTextDraftsByRow(['']);
  };

  const editQrTemplateRow = (template: LabelQrTemplate) => {
    const rows = templateToRows(template.contentTemplate);
    const normalizedRows = rows.length > 0 ? rows : [[]];
    setQrDraft({
      id: template.labelQrTemplateId,
      version: template.version,
      name: template.name,
      rows: normalizedRows,
      errorCorrection: template.errorCorrection,
      sizeMm: template.defaultSizeMm,
    });
    setQrTextDraftsByRow(normalizedRows.map(() => ''));
  };

  const addQrFieldChip = (rowIndex: number, field: LabelFieldCatalogItem) => {
    setQrDraft((current) => {
      const rows = current.rows.map((row, i) => (i === rowIndex ? [...row, { kind: 'field' as const, fieldId: field.id }] : row));
      return { ...current, rows };
    });
  };

  const addQrTextChip = (rowIndex: number) => {
    const text = sanitizeQrText(qrTextDraftsByRow[rowIndex] ?? '');
    if (!text) return;
    setQrDraft((current) => {
      const rows = current.rows.map((row, i) => (i === rowIndex ? [...row, { kind: 'text' as const, text }] : row));
      return { ...current, rows };
    });
    setQrTextDraftsByRow((current) => current.map((v, i) => (i === rowIndex ? '' : v)));
  };

  const removeQrChip = (rowIndex: number, chipIndex: number) => {
    setQrDraft((current) => {
      const rows = current.rows.map((row, i) => (i === rowIndex ? row.filter((_, j) => j !== chipIndex) : row));
      return { ...current, rows };
    });
  };

  const moveQrChip = (rowIndex: number, chipIndex: number, direction: -1 | 1) => {
    setQrDraft((current) => {
      const row = current.rows[rowIndex];
      if (!row) return current;
      const target = chipIndex + direction;
      if (target < 0 || target >= row.length) return current;
      const nextRow = [...row];
      [nextRow[chipIndex], nextRow[target]] = [nextRow[target], nextRow[chipIndex]];
      const rows = current.rows.map((r, i) => (i === rowIndex ? nextRow : r));
      return { ...current, rows };
    });
  };

  const addQrRow = () => {
    setQrDraft((current) => ({ ...current, rows: [...current.rows, []] }));
    setQrTextDraftsByRow((current) => [...current, '']);
  };

  const removeQrRow = (rowIndex: number) => {
    setQrDraft((current) => {
      if (current.rows.length <= 1) return current;
      return { ...current, rows: current.rows.filter((_, i) => i !== rowIndex) };
    });
    setQrTextDraftsByRow((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== rowIndex)));
  };

  const saveQrTemplate = async (
    override?: { name: string; contentTemplate: string; errorCorrection: 'L' | 'M' | 'Q' | 'H'; defaultSizeMm: number },
  ): Promise<LabelQrTemplate | null> => {
    if (!canManage || saving || qrSaving) return null;
    const name = (override?.name ?? qrDraft.name).trim();
    if (!name) {
      message.error('Введите название QR-шаблона');
      return null;
    }
    setQrSaving(true);
    try {
      const input: LabelQrTemplateInput = {
        name,
        contentTemplate: override?.contentTemplate ?? rowsToTemplate(qrDraft.rows),
        errorCorrection: override?.errorCorrection ?? qrDraft.errorCorrection,
        defaultSizeMm: override?.defaultSizeMm ?? qrDraft.sizeMm,
        idempotencyKey: `label-qr-template-${Date.now()}`,
      };
      let saved: LabelQrTemplate;
      if (!override && qrDraft.id != null) {
        saved = await labelsApi.updateQrTemplate(qrDraft.id, { ...input, version: qrDraft.version ?? 0 });
        message.success('QR-шаблон обновлён');
      } else {
        saved = await labelsApi.createQrTemplate(input);
        message.success(override ? 'QR-шаблон сохранён в библиотеку' : 'QR-шаблон создан');
      }
      await loadQrTemplates();
      resetQrDraft();
      return saved;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (error.code === 'LABEL_QR_TEMPLATE_NAME_TAKEN') {
          message.error('QR-шаблон с таким именем уже существует.');
        } else {
          message.error('QR-шаблон изменён в другом месте. Список обновлён, повторите изменения.');
        }
        await loadQrTemplates();
      } else {
        message.error('Не удалось сохранить QR-шаблон');
      }
      return null;
    } finally {
      setQrSaving(false);
    }
  };

  const promoteAdHocQrToLibrary = async (element: LabelTemplateElement, index: number) => {
    if (!canManage || saving) return;
    const draft = qrDraftFromElement(element);
    const created = await saveQrTemplate(draft);
    if (created) {
      patchQrStyle(index, { qrSourceTemplateId: created.labelQrTemplateId });
    }
  };

  const deleteQrTemplateRow = async (template: LabelQrTemplate) => {
    if (!canManage) return;
    try {
      await labelsApi.deleteQrTemplate(template.labelQrTemplateId, template.version, `label-qr-template-${Date.now()}`);
      message.success('QR-шаблон удалён');
      if (qrDraft.id === template.labelQrTemplateId) resetQrDraft();
      await loadQrTemplates();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (error.code === 'LABEL_QR_TEMPLATE_NAME_TAKEN') {
          message.error('QR-шаблон с таким именем уже существует.');
        } else {
          message.error('QR-шаблон изменён в другом месте. Список обновлён.');
        }
        await loadQrTemplates();
      } else {
        message.error('Не удалось удалить QR-шаблон');
      }
    }
  };

  const layoutGeometry = labelEditorLayoutGeometry(editorLayoutMode);
  const { leftColumnSpan, rightColumnSpan } = layoutGeometry;
  const changeEditorLayoutMode = (mode: LabelEditorLayoutMode) => {
    setEditorLayoutMode(mode);
    saveLabelEditorLayoutMode(layoutPreferenceUserId, mode);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
        <Button type="primary" icon={<PlusOutlined />} disabled={!canManage || saving} onClick={startNew}>
          Новый шаблон
        </Button>
      </Space>

      {!canManage && (
        <Alert
          type="info"
          showIcon
          message="Шаблоны доступны только для просмотра"
        />
      )}

      <Card size="small" title="Импорт из Bazis .xbir">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <input
              type="file"
              accept=".xbir,.xml,text/xml,application/xml"
              disabled={!canManage}
              onChange={(event) => void handleBazisImportFile(event.target.files?.[0] ?? null)}
            />
            {importFileName && <Text type="secondary">{importFileName}</Text>}
          </Space>
          <Alert
            type="info"
            showIcon
            message="Импорт читает .xbir, группирует строки по полю «Шаблон бирки» и предлагает варианты ERP-шаблона. Файлы .brx пока не читаются напрямую."
          />
          {importVariants.length > 0 && (
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={importVariants}
              columns={[
                { title: 'Вариант', dataIndex: 'name' },
                { title: 'Строк', dataIndex: 'rowCount', width: 90 },
                {
                  title: 'Bazis файл',
                  dataIndex: 'templateFiles',
                  render: (files: string[]) => files.map((file) => <Tag key={file}>{file}</Tag>),
                },
                {
                  title: '',
                  width: 150,
                  render: (_, variant) => (
                    <Button icon={<ImportOutlined />} disabled={!canManage || saving} onClick={() => applyImportVariant(variant)}>
                      В форму
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Space>
      </Card>

      <Card size="small" title="Шаблоны">
        <Table
          rowKey="labelTemplateId"
          loading={loading}
          dataSource={templates}
          pagination={false}
          size="small"
          scroll={{ y: 430 }}
          rowClassName={(template) => (selectedTemplate?.labelTemplateId === template.labelTemplateId ? 'ant-table-row-selected' : '')}
          onRow={(template) => ({
            onClick: () => {
              if (!saving) setSelectedTemplate(template);
            },
            style: { cursor: saving ? 'wait' : 'pointer' },
          })}
          columns={[
            { title: 'Название', dataIndex: 'name' },
            { title: 'Версия', dataIndex: 'version', width: 90 },
            {
              title: 'Форматы',
              dataIndex: 'defaultExportFormats',
              width: 180,
              render: (formats: string[]) => formats.map((format) => <Tag key={format}>{format}</Tag>),
            },
            {
              title: 'Статус',
              dataIndex: 'isActive',
              width: 120,
              render: (active: boolean) => <Tag color={active ? 'green' : 'default'}>{active ? 'Активен' : 'Отключён'}</Tag>,
            },
            {
              title: '',
              width: 48,
              render: () => <Button icon={<EditOutlined />} size="small" disabled={!canManage || saving} />,
            },
          ]}
        />
      </Card>

      <Collapse defaultActiveKey={['current-template-preview']}>
        <Panel
          header="Просмотр текущего шаблона"
          key="current-template-preview"
          extra={(
            <div onClick={(event) => event.stopPropagation()}>
              <Radio.Group
                size="small"
                value={previewDataMode}
                onChange={(event) => setPreviewDataMode(event.target.value as LabelPreviewDataMode)}
                optionType="button"
                buttonStyle="solid"
                options={[
                  { value: 'structure', label: 'Структура' },
                  { value: 'sample', label: 'Пример с данными' },
                ]}
              />
            </div>
          )}
        >
          <LabelTemplatePreview
            widthMm={Number(previewWidthMm ?? selectedTemplate?.canvasWidthMm ?? 85)}
            heightMm={Number(previewHeightMm ?? selectedTemplate?.canvasHeightMm ?? 88)}
            elements={elements}
            fields={sourceFields}
            previewFieldValues={customFieldPreviewValues}
            previewDataMode={previewDataMode}
            selectedElementKey={selectedElementKey}
            canDrag={false}
          />
        </Panel>
      </Collapse>

      <Card size="small" title="OCR-шаблоны бирок">
        <OcrTemplatesConfig canManage={can('labels.manage_templates')} />
      </Card>

      <Form
        form={form}
        layout="vertical"
        onFinish={saveTemplate}
        onValuesChange={() => {
          if (!savingRef.current) setEditorDirty(true);
        }}
        disabled={!canManage || saving}
      >
        <Row gutter={16} align="top">
          <Col xs={24} lg={leftColumnSpan}>
            <Card size="small" title={selectedTemplate ? 'Редактирование шаблона' : 'Новый шаблон'} style={{ marginBottom: 16 }}>
              {!loading && !advancedRendererReady && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="Расширенный renderer пока не подтверждён"
                  description={templates.length === 0
                    ? 'Первый шаблон можно сохранить в совместимом формате. После перечитывания списка станут доступны if/else, группы и новая типографика.'
                    : 'Размер шрифта, if/else и группы заблокированы до обновления backend.'}
                />
              )}
              <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }]}>
                <Input />
              </Form.Item>
              <div style={{ marginBottom: 16 }}>
                <Text strong>Поля бирки</Text>
                <div style={{ marginTop: 8 }}>
                  <FieldPalette
                    fields={templatePaletteFields}
                    usedFieldIds={usedFieldIds}
                    fieldHealth={templateFieldHealth}
                    disabled={!canManage || saving}
                    search={fieldSearch}
                    onSearch={setFieldSearch}
                    onBeginDrag={setDraggingField}
                    maxHeight={140}
                  />
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <Collapse defaultActiveKey={[]}>
                  <Panel header="Пользовательские поля" key="custom-fields">
                    <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
                      <Alert
                        type="info"
                        showIcon
                        message="Поле может быть константой, данными ERP или формулой из полей, текста, склейки и цепочек IF/ELSE."
                      />
                      {customFieldPreview.error && (
                        <Alert type="error" showIcon message={customFieldPreview.error} />
                      )}
                      {!customExpressionRendererReady && (
                        <Alert
                          type="warning"
                          showIcon
                          message="Формулы недоступны: backend не подтвердил capability custom_expression_v1."
                        />
                      )}
                      <div>
                        <Button
                          icon={<PlusOutlined />}
                          disabled={!canManage || saving}
                          onClick={() => openCustomFieldEditor()}
                        >
                          Добавить поле
                        </Button>
                      </div>
                      <Table
                        rowKey="fieldId"
                        size="small"
                        pagination={false}
                        locale={{ emptyText: 'Пользовательских полей пока нет' }}
                        dataSource={customFields}
                        columns={[
                          { title: 'Название', dataIndex: 'label', width: 180 },
                          {
                            title: 'Тип',
                            width: 100,
                            render: (_, row) => CUSTOM_FIELD_TYPE_OPTIONS.find((option) => option.value === row.type)?.label ?? 'Строка',
                          },
                          {
                            title: 'Значение',
                            render: (_, row) => {
                              if (row.valueMode === 'constant') {
                                return (
                                  <Space size={6}>
                                    <Tag color="blue">Постоянный текст</Tag>
                                    <Text ellipsis style={{ maxWidth: 220 }}>{String(row.defaultValue ?? '') || 'Пусто'}</Text>
                                  </Space>
                                );
                              }
                              if (row.valueMode === 'source') {
                                const source = fields.find((field) => field.id === row.sourceField);
                                return <Tag color="processing">{source ? `${source.category}: ${source.label}` : row.sourceField}</Tag>;
                              }
                              if (row.valueMode === 'expression' && row.expression) {
                                const labelsById = new Map(sourceFields.map((field) => [field.id, field.label]));
                                return (
                                  <Space size={6}>
                                    <Tag color="purple">Формула</Tag>
                                    <Text ellipsis={{ tooltip: true }} style={{ maxWidth: 260 }}>
                                      {summarizeCustomFieldExpression(row.expression, labelsById)}
                                    </Text>
                                  </Space>
                                );
                              }
                              return null;
                            },
                          },
                          {
                            title: '',
                            width: 92,
                            render: (_, row) => (
                              <Space size={4}>
                                <Tooltip title="Редактировать поле">
                                  <Button
                                    type="text"
                                    icon={<EditOutlined />}
                                    disabled={!canManage || saving}
                                    onClick={() => openCustomFieldEditor(row)}
                                  />
                                </Tooltip>
                                <Tooltip title="Удалить поле">
                                  <Button
                                    type="text"
                                    danger
                                    icon={<DeleteOutlined />}
                                    disabled={!canManage || saving}
                                    onClick={() => Modal.confirm({
                                      title: `Удалить поле «${row.label}»?`,
                                      content: 'Удаление применится после сохранения шаблона.',
                                      okText: 'Удалить',
                                      okButtonProps: { danger: true },
                                      cancelText: 'Отмена',
                                      onOk: () => deleteCustomField(row.fieldId),
                                    })}
                                  />
                                </Tooltip>
                              </Space>
                            ),
                          },
                        ]}
                      />
                    </Space>
                  </Panel>
                </Collapse>
              </div>
              <Space wrap>
                <Button htmlType="submit" type="primary" icon={<SaveOutlined />} loading={saving} disabled={!canManage || qrSaving || editorGestureActive}>
                  Сохранить шаблон
                </Button>
                <Button icon={<CopyOutlined />} loading={saving} disabled={!canManage || qrSaving || editorGestureActive || !selectedTemplate || elements.length === 0} onClick={() => void openSaveAs()}>
                  Сохранить как
                </Button>
                {editorDirty
                  ? <Tag color="warning">Есть несохранённые изменения</Tag>
                  : selectedTemplate
                    ? <Tag color="success">Все изменения сохранены</Tag>
                    : <Tag>Новый шаблон</Tag>}
              </Space>
            </Card>
            <Table
            rowKey="elementKey"
            title={() => (
              <Space wrap>
                <Text strong>Элементы</Text>
                <Tooltip title="Добавляет текстовый элемент. Можно привязать к полю заказа, детали, Базиса или кастомному полю, затем перетащить на визуале.">
                  <Button disabled={!canManage || saving} onClick={() => addElement('text')}>Текст</Button>
                </Tooltip>
                <Tooltip title="Добавляет линию. Используйте для разделителей, подчеркиваний и простых графических границ внутри бирки.">
                  <Button disabled={!canManage || saving} onClick={() => addElement('line')}>Линия</Button>
                </Tooltip>
                <Tooltip title="Добавляет прямоугольник. Используйте для рамок, блоков и визуального выделения областей бирки.">
                  <Button disabled={!canManage || saving} onClick={() => addElement('rect')}>Прямоугольник</Button>
                </Tooltip>
                <Tooltip title="Добавляет QR-код. Данные собираются по шаблону из полей детали, заказа, Bazis и кастомных полей.">
                  <Button icon={<QrcodeOutlined />} disabled={!canManage || saving} onClick={() => addElement('qr')}>QR-код</Button>
                </Tooltip>
                <Tooltip title="Добавляет растягиваемую область миниатюры листа раскроя. При формировании бирки лист впишется сюда автоматически, а нужная деталь будет выделена.">
                  <Button
                    icon={<PictureOutlined />}
                    disabled={!canManage || saving || !cutMapRendererReady || elements.some((element) => element.kind === 'cut_map')}
                    onClick={() => addElement('cut_map')}
                  >
                    Миниатюра раскроя
                  </Button>
                </Tooltip>
              </Space>
            )}
            size="small"
            pagination={false}
            dataSource={elements}
            scroll={{ y: 360, x: 1180 }}
            rowClassName={(element) => (selectedElementKeys.includes(element.elementKey) ? 'ant-table-row-selected' : '')}
            onRow={(element) => ({
              onClick: (event) => setEditorSelection(selectLabelElements(
                elementsRef.current,
                selectedElementKeys,
                element.elementKey,
                event.shiftKey,
              )),
              style: { cursor: 'pointer' },
            })}
            columns={[
              {
                title: 'Тип',
                width: 120,
                render: (_, element, index) => (
                  <Select
                    value={element.kind}
                    disabled={!canManage || saving}
                    style={{ width: '100%' }}
                    onChange={(kind) => changeElementKind(index, kind)}
                    options={[
                      { value: 'text', label: 'Текст' },
                      { value: 'line', label: 'Линия' },
                      { value: 'rect', label: 'Прямоугольник' },
                      { value: 'qr', label: 'QR-код' },
                      { value: 'cut_map', label: 'Миниатюра раскроя', disabled: !cutMapRendererReady },
                    ]}
                  />
                ),
              },
              {
                title: 'Поле',
                width: 220,
                render: (_, element, index) => (
                  <Select
                    showSearch
                    allowClear
                    value={element.sourceField ?? undefined}
                    disabled={!canManage || saving || element.kind !== 'text'}
                    style={{ width: '100%' }}
                    onChange={(sourceField) => patchElement(index, { sourceField: sourceField ?? null })}
                    options={sourceFields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
                  />
                ),
              },
              {
                title: 'Текст',
                width: 180,
                render: (_, element, index) => (
                  <Input
                    value={element.staticText ?? ''}
                    disabled={!canManage || saving || element.kind !== 'text'}
                    onChange={(event) => patchElement(index, { staticText: event.target.value || null })}
                  />
                ),
              },
              {
                title: 'Шрифт',
                width: 190,
                render: (_, element, index) => {
                  const typography = readLabelTypography(element);
                  return (
                    <Space.Compact block>
                      <InputNumber
                        aria-label="Размер шрифта"
                        min={4}
                        max={96}
                        addonAfter="pt"
                        value={typography.fontSizePt}
                        disabled={!canManage || saving || !advancedRendererReady || element.kind !== 'text'}
                        onChange={(value) => patchElementTypography(index, { fontSizePt: Number(value ?? 10) })}
                      />
                      <Button
                        aria-label="Полужирный"
                        type={typography.fontWeight === 'bold' ? 'primary' : 'default'}
                        disabled={!canManage || saving || !advancedRendererReady || element.kind !== 'text'}
                        onClick={() => patchElementTypography(index, { fontWeight: typography.fontWeight === 'bold' ? 'normal' : 'bold' })}
                      >
                        <strong>Ж</strong>
                      </Button>
                      <Button
                        aria-label="Курсив"
                        type={typography.italic ? 'primary' : 'default'}
                        disabled={!canManage || saving || !advancedRendererReady || element.kind !== 'text'}
                        onClick={() => patchElementTypography(index, { italic: !typography.italic })}
                      >
                        <em>К</em>
                      </Button>
                    </Space.Compact>
                  );
                },
              },
              {
                title: 'Условие',
                width: 150,
                render: (_, element) => {
                  if (element.kind !== 'text') return null;
                  const active = Boolean(readLabelIfElseCondition(element.condition));
                  return (
                    <Button
                      size="small"
                      type={active ? 'primary' : 'default'}
                      disabled={!canManage || saving || !advancedRendererReady}
                      onClick={() => openElementCondition(element)}
                    >
                      {active ? 'if/else настроен' : 'Добавить if/else'}
                    </Button>
                  );
                },
              },
              {
                title: 'Имя QR',
                width: 140,
                render: (_, element, index) => (
                  <Input
                    value={String((element.style as Record<string, unknown> | undefined)?.qrName ?? '')}
                    disabled={!canManage || saving || element.kind !== 'qr'}
                    onChange={(event) => patchQrStyle(index, { qrName: event.target.value })}
                    onBlur={(event) => patchQrStyle(index, { qrName: event.target.value.trim() })}
                  />
                ),
              },
              {
                title: 'QR шаблон',
                width: 260,
                render: (_, element, index) => (
                  <Space.Compact block>
                    <Input
                      value={qrTemplateOf(element)}
                      placeholder="{bazis.detail_id}|{bazis.name}"
                      disabled={!canManage || saving || element.kind !== 'qr'}
                      onChange={(event) => patchQrStyle(index, { qrTemplate: event.target.value })}
                    />
                    <Select
                      value={qrErrorCorrectionOf(element)}
                      disabled={!canManage || saving || element.kind !== 'qr'}
                      style={{ width: 72 }}
                      options={QR_ERROR_CORRECTION_OPTIONS}
                      onChange={(qrErrorCorrection) => patchQrStyle(index, { qrErrorCorrection })}
                    />
                  </Space.Compact>
                ),
              },
              {
                title: 'Библиотека',
                width: 150,
                render: (_, element, index) => {
                  if (element.kind !== 'qr') return null;
                  const hasSourceTemplate = (element.style as Record<string, unknown> | undefined)?.qrSourceTemplateId != null;
                  if (hasSourceTemplate) return <Tag color="processing">В библиотеке</Tag>;
                  return (
                    <Tooltip title="Сохраняет этот QR-код как переиспользуемый шаблон в глобальной библиотеке QR-кодов.">
                      <Button
                        size="small"
                        disabled={!canManage || saving || qrSaving}
                        loading={qrSaving}
                        onClick={() => void promoteAdHocQrToLibrary(element, index)}
                      >
                        Сохранить в библиотеку
                      </Button>
                    </Tooltip>
                  );
                },
              },
              ...(['xMm', 'yMm', 'widthMm', 'heightMm'] as const).map((key) => ({
                title: ({ xMm: 'X, мм', yMm: 'Y, мм', widthMm: 'Ширина, мм', heightMm: 'Высота, мм' } as const)[key],
                width: 95,
                render: (_: unknown, element: LabelTemplateElement, index: number) => (
                  <InputNumber
                    value={element[key]}
                    min={0}
                    disabled={!canManage || saving}
                    style={{ width: '100%' }}
                    onChange={(value) => {
                      const patch = { [key]: Number(value ?? 0) } as Partial<LabelTemplateElement>;
                      if (element.kind === 'qr') applyQrGeometryPatch(element.elementKey, patch);
                      else patchElement(index, patch);
                    }}
                  />
                ),
              })),
            ]}
          />
          </Col>
          <Col xs={24} lg={rightColumnSpan}>
            <Card size="small" title="Параметры шаблона" style={{ marginBottom: 16 }}>
              <Form.Item name="description" label="Описание">
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
              <Form.Item
                name="isActive"
                label="Доступен для формирования"
                valuePropName="checked"
                tooltip="Отключённые шаблоны остаются в редакторе, но не показываются в модалках формирования бирок."
              >
                <Switch checkedChildren="Активен" unCheckedChildren="Отключён" />
              </Form.Item>
              <Row gutter={8} align="top" wrap={false}>
                <Col flex="47px">
                  <Form.Item name="canvasWidthMm" label={<span style={{ fontSize: 11 }}>Ширина</span>} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col flex="47px">
                  <Form.Item name="canvasHeightMm" label={<span style={{ fontSize: 11 }}>Высота</span>} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col flex="67px">
                  <Form.Item name="dpi" label={<span style={{ fontSize: 11 }}>Разрешение</span>} tooltip="Разрешение печати в точках на дюйм. Влияет на размер растровых файлов при генерации бирок." rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col flex="auto">
                  <Form.Item name="defaultExportFormats" label={<span style={{ fontSize: 11 }}>Форматы</span>} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                    <Checkbox.Group options={EXPORT_FORMATS.map((format) => ({ label: format, value: format }))} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
            <Card
              size="small"
              title="Визуал бирки"
              extra={(
                <Space size={12} wrap>
                  <Radio.Group
                    size="small"
                    value={previewDataMode}
                    onChange={(event) => setPreviewDataMode(event.target.value as LabelPreviewDataMode)}
                    optionType="button"
                    buttonStyle="solid"
                    options={[
                      { value: 'structure', label: 'Структура' },
                      { value: 'sample', label: 'Пример с данными' },
                    ]}
                  />
                  <Tooltip title="Меняет пропорции формы. В крупном режиме правая колонка вдвое шире левой, а визуал автоматически занимает всю доступную ширину.">
                    <Space size={6}>
                      <Text type="secondary">Колонки</Text>
                      <Radio.Group
                        className="label-editor-layout-mode"
                        aria-label="Пропорции колонок редактора"
                        value={editorLayoutMode}
                        optionType="button"
                        buttonStyle="solid"
                        onChange={(event) => changeEditorLayoutMode(event.target.value as LabelEditorLayoutMode)}
                        options={[
                          { value: 'balanced', label: 'Обычные' },
                          { value: 'large-preview', label: 'Крупный визуал' },
                        ]}
                      />
                    </Space>
                  </Tooltip>
                  <Checkbox checked={showAllBorders} onChange={(event) => setShowAllBorders(event.target.checked)}>Показать границы всех элементов</Checkbox>
                </Space>
              )}
              style={{ marginBottom: 16 }}
            >
              <LabelTemplatePreview
                widthMm={Number(previewWidthMm ?? selectedTemplate?.canvasWidthMm ?? 85)}
                heightMm={Number(previewHeightMm ?? selectedTemplate?.canvasHeightMm ?? 88)}
                elements={elements}
                fields={sourceFields}
                previewFieldValues={customFieldPreviewValues}
                previewDataMode={previewDataMode}
                selectedElementKey={selectedElementKey}
                selectedElementKeys={selectedElementKeys}
                canDrag={canManage && !saving}
                advancedFeaturesEnabled={advancedRendererReady}
                initialZoom={layoutGeometry.initialZoom}
                fitToContainer={layoutGeometry.fitPreviewToColumn}
                keepConditionallyHiddenTextVisible
                showAllBounds={showAllBorders}
                onSelectElement={(elementKey, additive) => setEditorSelection(selectLabelElements(
                  elementsRef.current,
                  selectedElementKeys,
                  elementKey,
                  additive,
                ))}
                onMoveElement={moveElement}
                onChangeElement={patchElementByKey}
                onChangeElements={patchElementsByKey}
                onGestureActiveChange={setEditorGesture}
                onDeleteElement={deleteElementByKey}
                onDuplicateElement={duplicateElementByKey}
                onGroupElements={groupSelectedElements}
                onUngroupElements={ungroupSelectedElements}
                onCenterElements={centerSelectedElements}
                onBringElementToFront={bringElementToFront}
                onSendElementToBack={sendElementToBack}
                onDropField={addFieldElement}
                draggingField={draggingField}
                onDropDraggingField={(field, xMm, yMm) => {
                  addFieldElement(field, xMm, yMm);
                  setDraggingField(null);
                  setDragCursor(null);
                }}
                draggingQr={draggingQr}
                onDropDraggingQr={(payload, xMm, yMm) => {
                  onDropDraggingQr(payload, xMm, yMm);
                  setDraggingQr(null);
                  setQrDragCursor(null);
                }}
              />
            </Card>
              <div style={{ marginBottom: 16 }}>
                <Collapse defaultActiveKey={[]}>
                  <Panel header="QR-коды" key="qr-library">
                        <Space direction="vertical" size={12} style={{ width: '100%' }}>
                          <Table
                            rowKey="labelQrTemplateId"
                            size="small"
                            pagination={false}
                            dataSource={qrTemplates}
                            columns={[
                              { title: 'Название', dataIndex: 'name' },
                              {
                                title: 'EC',
                                dataIndex: 'errorCorrection',
                                width: 60,
                                render: (value: string) => <Tag>{value}</Tag>,
                              },
                              { title: 'Размер, мм', dataIndex: 'defaultSizeMm', width: 110 },
                              {
                                title: '',
                                width: 150,
                                render: (_, template) => (
                                  <Space size={4}>
                                    <QrcodeOutlined
                                      data-qr-template-drag={template.labelQrTemplateId}
                                      draggable={canManage && !saving}
                                      style={{ cursor: canManage && !saving ? 'grab' : 'default', fontSize: 16, userSelect: 'none' }}
                                      onDragStart={(event) => {
                                        if (!canManage || saving) return;
                                        setDraggingQr(template);
                                        event.dataTransfer.setData('application/x-label-qr-template', String(template.labelQrTemplateId));
                                        event.dataTransfer.effectAllowed = 'copy';
                                      }}
                                      onDragEnd={() => setDraggingQr(null)}
                                      onMouseDown={(event) => {
                                        if (!canManage || saving) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                      onMouseDownCapture={(event) => {
                                        if (!canManage || saving) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                      onPointerDown={(event) => {
                                        if (!canManage || saving) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                      onPointerDownCapture={(event) => {
                                        if (!canManage || saving) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                    />
                                    <Button size="small" icon={<EditOutlined />} disabled={!canManage || saving || qrSaving} onClick={() => editQrTemplateRow(template)} />
                                    <Button size="small" danger icon={<DeleteOutlined />} disabled={!canManage || saving || qrSaving} onClick={() => void deleteQrTemplateRow(template)} />
                                  </Space>
                                ),
                              },
                            ]}
                          />
                          <Card size="small" title={qrDraft.id != null ? 'Редактирование QR-шаблона' : 'Новый QR-шаблон'}>
                            <Space direction="vertical" size={8} style={{ width: '100%' }}>
                              <Input
                                placeholder="Название QR-шаблона"
                                value={qrDraft.name}
                                disabled={!canManage}
                                onChange={(event) => setQrDraft((current) => ({ ...current, name: event.target.value }))}
                              />
                              <div>
                                <Text type="secondary">Содержимое QR — несколько независимых строк (перетащите поля из палитры ниже в нужную строку)</Text>
                                <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 4 }}>
                                  {qrDraft.rows.map((row, rowIndex) => (
                                    <div key={rowIndex} style={{ border: '1px solid #f0f0f0', borderRadius: 4, padding: 6 }}>
                                      <div
                                        ref={(el) => {
                                          if (el) qrRowDropRefs.current.set(rowIndex, el);
                                          else qrRowDropRefs.current.delete(rowIndex);
                                        }}
                                        data-qr-chip-dropzone
                                        data-qr-row-index={rowIndex}
                                        style={{
                                          minHeight: 40,
                                          padding: 8,
                                          border: '1px dashed #d9d9d9',
                                          borderRadius: 4,
                                          display: 'flex',
                                          flexWrap: 'wrap',
                                          gap: 6,
                                        }}
                                        onDragOver={(event) => {
                                          if (canManage) event.preventDefault();
                                        }}
                                        onDrop={(event) => {
                                          if (!canManage) return;
                                          event.preventDefault();
                                          if (qrFieldChipResolvedRef.current) return;
                                          const fieldId = event.dataTransfer.getData('application/x-label-field') || event.dataTransfer.getData('text/plain');
                                          const field = qrPaletteFields.find((item) => item.id === fieldId);
                                          if (field) {
                                            qrFieldChipResolvedRef.current = true;
                                            addQrFieldChip(rowIndex, field);
                                          }
                                        }}
                                      >
                                        {row.length === 0 && (
                                          <Text type="secondary">Строка {rowIndex + 1}: нет полей — перетащите поле или добавьте текст</Text>
                                        )}
                                        {row.map((chip, chipIndex) => (
                                          <Tag
                                            key={`${chip.kind}-${chipIndex}`}
                                            color={chip.kind === 'field' ? fieldHealthColor(qrFieldHealth.get(chip.fieldId)) : undefined}
                                            title={chip.kind === 'field' ? fieldHealthTitle(qrFieldHealth.get(chip.fieldId)) : undefined}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                          >
                                            <span>
                                              {chip.kind === 'field'
                                                ? (qrEditorFields.find((field) => field.id === chip.fieldId)?.label ?? chip.fieldId)
                                                : chip.text}
                                            </span>
                                            {canManage && (
                                              <>
                                                <Button
                                                  type="text"
                                                  size="small"
                                                  style={{ padding: '0 2px' }}
                                                  disabled={chipIndex === 0}
                                                  onClick={() => moveQrChip(rowIndex, chipIndex, -1)}
                                                >
                                                  ←
                                                </Button>
                                                <Button
                                                  type="text"
                                                  size="small"
                                                  style={{ padding: '0 2px' }}
                                                  disabled={chipIndex === row.length - 1}
                                                  onClick={() => moveQrChip(rowIndex, chipIndex, 1)}
                                                >
                                                  →
                                                </Button>
                                                <Button
                                                  type="text"
                                                  size="small"
                                                  style={{ padding: '0 2px' }}
                                                  onClick={() => removeQrChip(rowIndex, chipIndex)}
                                                >
                                                  ✕
                                                </Button>
                                              </>
                                            )}
                                          </Tag>
                                        ))}
                                      </div>
                                      <Space.Compact style={{ width: '100%', marginTop: 6 }}>
                                        <Input
                                          placeholder="Статический текст"
                                          value={qrTextDraftsByRow[rowIndex] ?? ''}
                                          disabled={!canManage}
                                          onChange={(event) => {
                                            const sanitized = sanitizeQrText(event.target.value);
                                            setQrTextDraftsByRow((current) => current.map((v, i) => (i === rowIndex ? sanitized : v)));
                                          }}
                                          onPressEnter={() => addQrTextChip(rowIndex)}
                                        />
                                        <Button disabled={!canManage} onClick={() => addQrTextChip(rowIndex)}>Добавить текст</Button>
                                        <Button
                                          disabled={!canManage || qrDraft.rows.length <= 1}
                                          onClick={() => removeQrRow(rowIndex)}
                                        >
                                          ✕ строка
                                        </Button>
                                      </Space.Compact>
                                    </div>
                                  ))}
                                  <Button disabled={!canManage} icon={<PlusOutlined />} onClick={addQrRow} style={{ alignSelf: 'flex-start' }}>
                                    + строка
                                  </Button>
                                </Space>
                              </div>
                              <div>
                                <Text type="secondary">Поля для перетаскивания</Text>
                                <div style={{ marginTop: 4 }}>
                                  <FieldPalette
                                    fields={qrEditorFields}
                                    fieldHealth={qrFieldHealth}
                                    disabled={!canManage}
                                    search={qrFieldSearch}
                                    onSearch={setQrFieldSearch}
                                    onBeginDrag={setDraggingQrField}
                                  />
                                </div>
                              </div>
                              <Row gutter={8} align="bottom">
                                <Col flex="90px">
                                  <Form.Item label="EC" style={{ marginBottom: 0 }}>
                                    <Select
                                      value={qrDraft.errorCorrection}
                                      disabled={!canManage}
                                      options={QR_ERROR_CORRECTION_OPTIONS}
                                      onChange={(value) => setQrDraft((current) => ({ ...current, errorCorrection: value as QrDraft['errorCorrection'] }))}
                                    />
                                  </Form.Item>
                                </Col>
                                <Col flex="130px">
                                  <Form.Item label="Размер, мм" style={{ marginBottom: 0 }}>
                                    <InputNumber
                                      min={8}
                                      value={qrDraft.sizeMm}
                                      disabled={!canManage}
                                      style={{ width: '100%' }}
                                      onChange={(value) => setQrDraft((current) => ({ ...current, sizeMm: Number(value ?? 20) }))}
                                    />
                                  </Form.Item>
                                </Col>
                                <Col flex="auto">
                                  <Space>
                                    <Button
                                      type="primary"
                                      icon={<SaveOutlined />}
                                      loading={qrSaving}
                                      disabled={!canManage}
                                      onClick={() => void saveQrTemplate()}
                                    >
                                      Сохранить QR-шаблон
                                    </Button>
                                    {qrDraft.id != null && (
                                      <Button disabled={!canManage} onClick={resetQrDraft}>Отмена</Button>
                                    )}
                                  </Space>
                                </Col>
                              </Row>
                            </Space>
                          </Card>
                        </Space>
                  </Panel>
                </Collapse>
              </div>
          </Col>
        </Row>
      </Form>

      <div>
        <Text type="secondary">Доступно полей: {fields.length}; категорий: {fieldCategories}</Text>
      </div>

      {draggingField && dragCursor && (
        <div
          data-label-global-drag-preview
          style={{
            position: 'fixed',
            left: dragCursor.x + 12,
            top: dragCursor.y + 12,
            zIndex: 3000,
            padding: '4px 8px',
            color: '#1677ff',
            background: '#e6f4ff',
            border: '1px dashed #1677ff',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            pointerEvents: 'none',
            fontSize: 12,
            lineHeight: 1.3,
          }}
        >
          {draggingField.label}
        </div>
      )}

      {draggingQr && qrDragCursor && (
        <div
          data-label-global-drag-preview-qr
          style={{
            position: 'fixed',
            left: qrDragCursor.x + 12,
            top: qrDragCursor.y + 12,
            zIndex: 3000,
            padding: '4px 8px',
            color: '#1677ff',
            background: '#e6f4ff',
            border: '1px dashed #1677ff',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            pointerEvents: 'none',
            fontSize: 12,
            lineHeight: 1.3,
          }}
        >
          {draggingQr.name}
        </div>
      )}

      {draggingQrField && qrFieldDragCursor && (
        <div
          data-label-global-drag-preview-qr-field
          style={{
            position: 'fixed',
            left: qrFieldDragCursor.x + 12,
            top: qrFieldDragCursor.y + 12,
            zIndex: 3000,
            padding: '4px 8px',
            color: '#1677ff',
            background: '#e6f4ff',
            border: '1px dashed #1677ff',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            pointerEvents: 'none',
            fontSize: 12,
            lineHeight: 1.3,
          }}
        >
          {draggingQrField.label}
        </div>
      )}

      <Modal
        title={editingCustomFieldId ? 'Редактировать пользовательское поле' : 'Добавить пользовательское поле'}
        open={customFieldEditorOpen}
        width={960}
        styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
        okText={editingCustomFieldId ? 'Сохранить поле' : 'Добавить поле'}
        cancelText="Отмена"
        destroyOnClose
        forceRender
        okButtonProps={{
          disabled: !canManage || saving || (customFieldValueMode === 'expression' && !customExpressionRendererReady),
        }}
        cancelButtonProps={{ disabled: saving }}
        onOk={() => void saveCustomField()}
        onCancel={() => {
          setCustomFieldEditorOpen(false);
          setEditingCustomFieldId(null);
          setCustomFieldExpression(defaultCustomFieldExpression());
          customFieldForm.resetFields();
        }}
      >
        <Form
          form={customFieldForm}
          layout="vertical"
          preserve={false}
          disabled={!canManage || saving}
          initialValues={{ type: 'string', valueMode: 'constant', defaultValue: '' }}
        >
          <Form.Item
            name="label"
            label="Название поля"
            rules={[
              { required: true, whitespace: true, message: 'Введите понятное название поля' },
              { max: 120, message: 'Не больше 120 символов' },
            ]}
          >
            <Input autoFocus placeholder="Например: Особая отметка" />
          </Form.Item>
          <Form.Item name="type" label="Тип значения" rules={[{ required: true }]}>
            <Select
              disabled={customFieldValueMode === 'expression'}
              options={CUSTOM_FIELD_TYPE_OPTIONS}
              onChange={(type: CustomFieldType) => {
                customFieldForm.setFieldValue(
                  'defaultValue',
                  type === 'boolean' ? false : type === 'number' ? undefined : '',
                );
              }}
            />
          </Form.Item>
          <Form.Item
            name="valueMode"
            label="Откуда брать значение"
            rules={[{ required: true }]}
            extra="Формула позволяет склеивать поля и текст, собирать значения из списка деталей, строить IF/ELSE и возвращать пустое значение."
          >
            <Select
              options={[
                { value: 'constant', label: 'Постоянный текст' },
                { value: 'source', label: 'Данные ERP / Базис' },
                {
                  value: 'expression',
                  label: 'Формула',
                  disabled: !customExpressionRendererReady,
                },
              ]}
              onChange={(mode: CustomFieldValueMode) => {
                if (mode === 'expression') customFieldForm.setFieldValue('type', 'string');
              }}
            />
          </Form.Item>
          {customFieldValueMode === 'source' && (
            <Form.Item
              name="sourceField"
              label="Поле-источник"
              rules={[{ required: true, message: 'Выберите поле-источник' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="Выберите данные заказа или детали"
                options={fields.map((field) => ({
                  value: field.id,
                  label: `${field.category}: ${field.label}`,
                }))}
              />
            </Form.Item>
          )}
          {customFieldValueMode === 'constant' && (
            <Form.Item
              name="defaultValue"
              label={customFieldType === 'string' ? 'Текст' : 'Значение'}
              valuePropName={customFieldType === 'boolean' ? 'checked' : 'value'}
              rules={[{
                validator: (_, value) => (
                  value === undefined || value === null || value === ''
                    ? Promise.reject(new Error('Введите постоянное значение'))
                    : Promise.resolve()
                ),
              }]}
            >
              {customFieldType === 'number' ? (
                <InputNumber style={{ width: '100%' }} placeholder="Введите число" />
              ) : customFieldType === 'boolean' ? (
                <Switch checkedChildren="Да" unCheckedChildren="Нет" />
              ) : customFieldType === 'date' ? (
                <Input type="date" />
              ) : (
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  placeholder="Введите произвольный текст, который должен печататься на бирке"
                  maxLength={1000}
                  showCount
                />
              )}
            </Form.Item>
          )}
          {customFieldValueMode === 'expression' && (
            <Form.Item
              label="Формула значения"
              extra="В склейке пробелы и разделители добавляются отдельными фиксированными текстами. Агрегация собирает значения выбранного поля из списка деталей."
            >
              <CustomFieldExpressionEditor
                value={customFieldExpression.root}
                fields={customExpressionFields}
                aggregateSources={LABEL_AGGREGATE_SOURCES}
                disabled={!canManage || saving || !customExpressionRendererReady}
                onChange={(root) => setCustomFieldExpression({
                  type: 'custom_expression',
                  version: 1,
                  root,
                })}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title="Условие вывода поля"
        open={conditionEditorKey !== null}
        okText="Сохранить условие"
        cancelText="Отмена"
        okButtonProps={{
          disabled: !canManage || saving || !advancedRendererReady || !isLabelConditionDraftValid(conditionDraft),
        }}
        onOk={saveElementCondition}
        onCancel={() => setConditionEditorKey(null)}
        footer={[
          <Button key="clear" danger disabled={!canManage || saving} onClick={clearElementCondition} style={{ float: 'left' }}>
            Удалить условие
          </Button>,
          <Button key="cancel" disabled={saving} onClick={() => setConditionEditorKey(null)}>
            Отмена
          </Button>,
          <Button
            key="save"
            type="primary"
            disabled={!canManage || saving || !advancedRendererReady || !isLabelConditionDraftValid(conditionDraft)}
            onClick={saveElementCondition}
          >
            Сохранить условие
          </Button>,
        ]}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="Проверка выполняется для каждой бирки. В каждой ветке можно оставить текущее значение, подставить другое поле, фиксированный текст или скрыть элемент."
          />
          <div>
            <Text strong>Если</Text>
            <Space.Compact block style={{ marginTop: 6 }}>
              <Select
                showSearch
                optionFilterProp="label"
                value={conditionDraft.when.field}
                style={{ width: '58%' }}
                options={sourceFields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
                onChange={(field) => setConditionDraft((current) => ({
                  ...current,
                  when: { ...current.when, field },
                }))}
              />
              <Select
                value={conditionDraft.when.op}
                style={{ width: '42%' }}
                options={LABEL_CONDITION_OPERATOR_OPTIONS}
                onChange={(op: LabelConditionOperator) => setConditionDraft((current) => ({
                  ...current,
                  when: op === 'equals' || op === 'not_equals'
                    ? { ...current.when, op, value: current.when.value ?? '' }
                    : { field: current.when.field, op },
                }))}
              />
            </Space.Compact>
            {(conditionDraft.when.op === 'equals' || conditionDraft.when.op === 'not_equals') && (
              <Input
                aria-label="Значение условия"
                value={String(conditionDraft.when.value ?? '')}
                placeholder="Значение для сравнения"
                maxLength={1000}
                style={{ marginTop: 8 }}
                onChange={(event) => setConditionDraft((current) => ({
                  ...current,
                  when: { ...current.when, value: event.target.value },
                }))}
              />
            )}
          </div>
          <ConditionBranchEditor
            title="Тогда"
            branch={conditionDraft.then}
            fields={sourceFields}
            onChange={(thenBranch) => setConditionDraft((current) => ({ ...current, then: thenBranch }))}
          />
          <ConditionBranchEditor
            title="Иначе"
            branch={conditionDraft.else}
            fields={sourceFields}
            onChange={(elseBranch) => setConditionDraft((current) => ({ ...current, else: elseBranch }))}
          />
        </Space>
      </Modal>

      <Modal
        title="Сохранить шаблон как"
        open={saveAsOpen}
        okText="Создать копию"
        cancelText="Отмена"
        confirmLoading={saving}
        onOk={() => void saveTemplateAs()}
        onCancel={() => setSaveAsOpen(false)}
      >
        <Input
          autoFocus
          value={saveAsName}
          placeholder="Новое название шаблона"
          onChange={(event) => setSaveAsName(event.target.value)}
          onPressEnter={() => void saveTemplateAs()}
        />
      </Modal>
    </Space>
  );
};

function ConditionBranchEditor({
  title,
  branch,
  fields,
  onChange,
}: {
  title: string;
  branch: LabelConditionBranch;
  fields: LabelFieldCatalogItem[];
  onChange: (branch: LabelConditionBranch) => void;
}) {
  const changeType = (type: LabelConditionBranch['type']) => {
    if (type === 'field') onChange({ type, field: fields[0]?.id ?? '' });
    else if (type === 'text') onChange({ type, value: '' });
    else onChange({ type });
  };
  return (
    <div>
      <Text strong>{title}</Text>
      <Select
        value={branch.type}
        style={{ width: '100%', marginTop: 6 }}
        options={LABEL_CONDITION_BRANCH_OPTIONS}
        onChange={changeType}
      />
      {branch.type === 'field' && (
        <Select
          showSearch
          optionFilterProp="label"
          value={branch.field}
          style={{ width: '100%', marginTop: 8 }}
          options={fields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
          onChange={(field) => onChange({ type: 'field', field })}
        />
      )}
      {branch.type === 'text' && (
        <Input
          value={branch.value}
          placeholder="Фиксированный текст"
          maxLength={1000}
          style={{ marginTop: 8 }}
          onChange={(event) => onChange({ type: 'text', value: event.target.value })}
        />
      )}
    </div>
  );
}

function LabelTemplatePreview({
  widthMm,
  heightMm,
  elements,
  fields,
  previewFieldValues,
  previewDataMode = 'sample',
  selectedElementKey,
  selectedElementKeys,
  canDrag,
  advancedFeaturesEnabled = true,
  onSelectElement,
  onMoveElement,
  onChangeElement,
  onChangeElements,
  onGestureActiveChange,
  onDeleteElement,
  onDuplicateElement,
  onGroupElements,
  onUngroupElements,
  onCenterElements,
  onBringElementToFront,
  onSendElementToBack,
  onDropField,
  draggingField,
  onDropDraggingField,
  draggingQr,
  onDropDraggingQr,
  initialZoom = 1,
  fitToContainer = false,
  keepConditionallyHiddenTextVisible = false,
  showAllBounds = false,
}: {
  widthMm: number;
  heightMm: number;
  elements: LabelTemplateElement[];
  fields: LabelFieldCatalogItem[];
  previewFieldValues?: Record<string, string>;
  previewDataMode?: LabelPreviewDataMode;
  selectedElementKey?: string | null;
  selectedElementKeys?: string[];
  canDrag?: boolean;
  advancedFeaturesEnabled?: boolean;
  onSelectElement?: (elementKey: string, additive: boolean) => void;
  onMoveElement?: (elementKey: string, xMm: number, yMm: number) => void;
  onChangeElement?: (elementKey: string, patch: Partial<LabelTemplateElement>) => void;
  onChangeElements?: (patches: Array<{ elementKey: string; patch: Partial<LabelTemplateElement> }>) => void;
  onGestureActiveChange?: (active: boolean) => void;
  onDeleteElement?: (elementKey: string) => void;
  onDuplicateElement?: (elementKey: string) => void;
  onGroupElements?: (elementKeys: string[]) => void;
  onUngroupElements?: (elementKeys: string[]) => void;
  onCenterElements?: (elementKeys: string[], axis: 'horizontal' | 'vertical') => void;
  onBringElementToFront?: (elementKey: string) => void;
  onSendElementToBack?: (elementKey: string) => void;
  onDropField?: (field: LabelFieldCatalogItem, xMm: number, yMm: number) => void;
  draggingField?: LabelFieldCatalogItem | null;
  onDropDraggingField?: (field: LabelFieldCatalogItem, xMm: number, yMm: number) => void;
  draggingQr?: LabelQrTemplate | null;
  onDropDraggingQr?: (payload: LabelQrTemplate, xMm: number, yMm: number) => void;
  initialZoom?: number;
  fitToContainer?: boolean;
  keepConditionallyHiddenTextVisible?: boolean;
  showAllBounds?: boolean;
}) {
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  const gestureSequenceRef = useRef(0);
  const transformGestureRef = useRef<{ id: number; committed: boolean } | null>(null);
  const dragGestureRef = useRef<{
    id: number;
    committed: boolean;
    ownerKey: string;
    keys: string[];
    ownerStart: { x: number; y: number };
    starts: Map<string, { x: number; y: number }>;
  } | null>(null);
  // Shared guard so ONE QR-library release resolves the drop exactly once. Both
  // the capture-phase window listener (handleGlobalDrop) and the bubble-phase
  // wrapper onMouseUp used to fire on the same release, dropping TWO QR elements
  // at the same point — the second stayed behind as a phantom (its dashed
  // quiet-zone frame) and kept tripping the overlap/out-of-bounds error even
  // after the first was moved.
  const qrDropResolvedRef = useRef(false);
  const [zoom, setZoom] = useState(initialZoom);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [showGrid, setShowGrid] = useState(Boolean(canDrag));
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const [measurement, setMeasurement] = useState<{ widthMm: number; heightMm: number } | null>(null);
  const [heightSuggestion, setHeightSuggestion] = useState<ReturnType<typeof findSameRowHeightSuggestion>>(null);
  const [hoveredElement, setHoveredElement] = useState<{ element: LabelTemplateElement; x: number; y: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ field: LabelFieldCatalogItem; xMm: number; yMm: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ elementKey: string; x: number; y: number } | null>(null);
  const safeWidth = Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 85;
  const safeHeight = Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 88;
  // True while an external drag (field or QR icon) is in flight over the canvas; used to
  // suspend normal element selection/dragging/context-menu so the drop target doesn't fight
  // with in-canvas interactions.
  const externalDragActive = Boolean(draggingField || draggingQr);
  const fieldLabels = useMemo(() => new Map(fields.map((field) => [field.id, field.label])), [fields]);
  const fieldInfo = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const fieldValues = useMemo(() => {
    if (previewDataMode === 'structure') return new Map<string, string>();
    const generated = Object.fromEntries(fields.map((field, index) => [field.id, sampleLabelFieldValue(field, index)]));
    return new Map(Object.entries({ ...generated, ...PREVIEW_FIELD_VALUES, ...previewFieldValues }));
  }, [fields, previewDataMode, previewFieldValues]);
  const sorted = elements.slice().sort((a, b) => Number(a.zIndex ?? 0) - Number(b.zIndex ?? 0));
  const intrinsicPreviewWidth = Math.min(760, Math.max(360, safeWidth * 7));
  const previewWidth = resolveLabelPreviewWidth({
    intrinsicWidth: intrinsicPreviewWidth,
    availableWidth,
    zoom,
    fitToContainer,
  });
  const previewHeight = previewWidth * (safeHeight / safeWidth);
  const effectiveSelectedKeys = selectedElementKeys?.length
    ? selectedElementKeys
    : selectedElementKey
      ? [selectedElementKey]
      : [];
  const selectedElements = elements.filter((element) => effectiveSelectedKeys.includes(element.elementKey));
  const selectedElement = selectedElements.at(-1);
  const selectedElementLocked = selectedElements.some(isLabelElementLocked);
  const contextElement = contextMenu
    ? elements.find((element) => element.elementKey === contextMenu.elementKey) ?? null
    : null;
  const contextKeys = contextElement && effectiveSelectedKeys.includes(contextElement.elementKey)
    ? effectiveSelectedKeys
    : contextElement
      ? selectLabelElements(elements, [], contextElement.elementKey, false)
      : [];
  const contextElements = elements.filter((element) => contextKeys.includes(element.elementKey));
  const contextBounds = contextElements.length > 0 ? labelElementsBounds(contextElements) : null;
  const contextHasGroup = contextElements.some((element) => Boolean(readLabelEditorMeta(element).groupId));
  const contextTextElement = contextElements.find((element) => element.kind === 'text') ?? null;
  const contextAllLocked = contextElements.length > 0 && contextElements.every(isLabelElementLocked);
  const pointFromEvent = (event: Pick<React.MouseEvent<Element> | React.DragEvent<Element>, 'clientX' | 'clientY'>) => {
    const container = stageRef.current?.container();
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * safeWidth,
      y: ((event.clientY - rect.top) / rect.height) * safeHeight,
    };
  };

  useEffect(() => {
    setZoom(initialZoom);
  }, [initialZoom]);

  useEffect(() => {
    const host = previewHostRef.current;
    if (!host) return;
    const updateAvailableWidth = () => {
      const width = Math.floor(host.getBoundingClientRect().width);
      if (width > 0) setAvailableWidth(width);
    };
    updateAvailableWidth();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateAvailableWidth);
      return () => window.removeEventListener('resize', updateAvailableWidth);
    }
    const observer = new ResizeObserver(updateAvailableWidth);
    observer.observe(host);
    return () => observer.disconnect();
  }, [fitToContainer]);

  useEffect(() => {
    if (!canDrag || externalDragActive) setAlignmentGuides([]);
  }, [canDrag, externalDragActive]);

  useEffect(() => {
    if (!canDrag || effectiveSelectedKeys.length === 0 || selectedElementLocked || externalDragActive) {
      transformerRef.current?.nodes([]);
      transformerRef.current?.getLayer()?.batchDraw();
      return;
    }
    const nodes = effectiveSelectedKeys
      .map((key) => nodeRefs.current.get(key))
      .filter((node): node is Konva.Node => Boolean(node));
    transformerRef.current?.nodes(nodes);
    transformerRef.current?.getLayer()?.batchDraw();
  }, [canDrag, externalDragActive, elements, selectedElementLocked, selectedElementKeys, selectedElementKey]);

  useEffect(() => {
    if (!canDrag || !draggingField || !onDropDraggingField) return;
    let dropped = false;
    const handleGlobalDrop = (event: MouseEvent | PointerEvent) => {
      if (dropped) return;
      const container = stageRef.current?.container();
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) {
        setDragPreview(null);
        return;
      }
      dropped = true;
      setDragPreview(null);
      onDropDraggingField(
        draggingField,
        clamp(((event.clientX - rect.left) / rect.width) * safeWidth, 0, safeWidth - 1),
        clamp(((event.clientY - rect.top) / rect.height) * safeHeight, 0, safeHeight - 1),
      );
    };
    window.addEventListener('pointerup', handleGlobalDrop, true);
    window.addEventListener('mouseup', handleGlobalDrop, true);
    return () => {
      window.removeEventListener('pointerup', handleGlobalDrop, true);
      window.removeEventListener('mouseup', handleGlobalDrop, true);
    };
  }, [canDrag, draggingField, onDropDraggingField, previewHeight, previewWidth, safeHeight, safeWidth]);

  // Mirrors the draggingField global-drop effect above: a capture-phase window listener
  // resolves the drop (if released over the canvas container) before the outer component's
  // bubble-phase listener clears draggingQr.
  useEffect(() => {
    if (!canDrag || !draggingQr || !onDropDraggingQr) return;
    qrDropResolvedRef.current = false;
    const handleGlobalDrop = (event: MouseEvent | PointerEvent) => {
      if (qrDropResolvedRef.current) return;
      const container = stageRef.current?.container();
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) return;
      qrDropResolvedRef.current = true;
      onDropDraggingQr(
        draggingQr,
        clamp(((event.clientX - rect.left) / rect.width) * safeWidth, 0, safeWidth - 1),
        clamp(((event.clientY - rect.top) / rect.height) * safeHeight, 0, safeHeight - 1),
      );
    };
    window.addEventListener('pointerup', handleGlobalDrop, true);
    window.addEventListener('mouseup', handleGlobalDrop, true);
    return () => {
      window.removeEventListener('pointerup', handleGlobalDrop, true);
      window.removeEventListener('mouseup', handleGlobalDrop, true);
    };
  }, [canDrag, draggingQr, onDropDraggingQr, previewHeight, previewWidth, safeHeight, safeWidth]);

  const applySnap = (value: number, event?: { altKey?: boolean }) => (
    snapToGrid && !event?.altKey ? Math.round(value) : value
  );

  const commitGeometry = (patches: Array<{ elementKey: string; patch: Partial<LabelTemplateElement> }>) => {
    if (onChangeElements) onChangeElements(patches);
    else patches.forEach(({ elementKey, patch }) => onChangeElement?.(elementKey, patch));
  };

  const resolveDragPosition = (
    elementKey: string,
    xMm: number,
    yMm: number,
    event?: { altKey?: boolean },
  ): { xMm: number; yMm: number; guides: AlignmentGuide[] } => {
    const element = elements.find((item) => item.elementKey === elementKey);
    if (!element || isLabelElementLocked(element)) return { xMm, yMm, guides: [] };
    const maxX = Math.max(0, safeWidth - Number(element.widthMm ?? 0));
    const maxY = Math.max(0, safeHeight - Number(element.heightMm ?? 0));
    const gridX = applySnap(xMm, event);
    const gridY = applySnap(yMm, event);
    const centered = event?.altKey
      ? { xMm: gridX, yMm: gridY, guides: [] }
      : snapElementCenters({
          elements,
          movingElementKey: elementKey,
          xMm: gridX,
          yMm: gridY,
          toleranceMm: 1.2,
        });
    return {
      xMm: clamp(centered.xMm, 0, maxX),
      yMm: clamp(centered.yMm, 0, maxY),
      guides: centered.guides,
    };
  };

  const handleDragStartElement = (
    elementKey: string,
    node: Konva.Node,
  ) => {
    const keys = effectiveSelectedKeys.includes(elementKey)
      ? effectiveSelectedKeys
      : selectLabelElements(elements, [], elementKey, false);
    const selected = elements.filter((element) => keys.includes(element.elementKey));
    if (selected.some(isLabelElementLocked)) return;
    const starts = new Map<string, { x: number; y: number }>();
    for (const key of keys) {
      const selectedNode = nodeRefs.current.get(key);
      if (selectedNode) starts.set(key, { x: selectedNode.x(), y: selectedNode.y() });
    }
    dragGestureRef.current = {
      id: ++gestureSequenceRef.current,
      committed: false,
      ownerKey: elementKey,
      keys,
      ownerStart: starts.get(elementKey) ?? { x: node.x(), y: node.y() },
      starts,
    };
    onGestureActiveChange?.(true);
  };

  const handleDragMoveElement = (
    elementKey: string,
    node: Konva.Node,
    event: Konva.KonvaEventObject<DragEvent>,
  ) => {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.ownerKey !== elementKey || gesture.committed) return;
    const selected = elements.filter((element) => gesture.keys.includes(element.elementKey));
    const bounds = labelElementsBounds(selected);
    const desiredOwner = gesture.keys.length === 1
      ? resolveDragPosition(elementKey, node.x(), node.y(), event.evt)
      : {
          xMm: applySnap(node.x(), event.evt),
          yMm: applySnap(node.y(), event.evt),
          guides: [] as AlignmentGuide[],
        };
    const positions = moveLabelDragGesture(
      gesture,
      { x: desiredOwner.xMm, y: desiredOwner.yMm },
      bounds,
      { width: safeWidth, height: safeHeight },
    );
    for (const position of positions) {
      nodeRefs.current.get(position.elementKey)?.position({ x: position.x, y: position.y });
    }
    setMeasurement({ widthMm: bounds.widthMm, heightMm: bounds.heightMm });
    setAlignmentGuides(desiredOwner.guides);
  };

  const handleDragEndElement = (elementKey: string) => {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.ownerKey !== elementKey || !claimLabelGestureCommit(gesture)) return;
    commitGeometry(gesture.keys.flatMap((key) => {
      const node = nodeRefs.current.get(key);
      return node ? [{ elementKey: key, patch: { xMm: roundMm(node.x()), yMm: roundMm(node.y()) } }] : [];
    }));
    dragGestureRef.current = null;
    setMeasurement(null);
    setAlignmentGuides([]);
    onGestureActiveChange?.(false);
  };

  const transformedElements = () => {
    const byKey = new Map(selectedElements.map((element) => [element.elementKey, element]));
    return readLabelTransformedNodes(selectedElements, nodeRefs.current).flatMap((snapshot) => {
      const element = byKey.get(snapshot.elementKey);
      return element ? [{ ...element, ...snapshot }] : [];
    });
  };

  const handleTransformStart = () => {
    transformGestureRef.current = { id: ++gestureSequenceRef.current, committed: false };
    onGestureActiveChange?.(true);
  };

  const handleTransform = () => {
    const transformed = transformedElements();
    if (transformed.length === 0) return;
    const bounds = labelElementsBounds(transformed);
    setMeasurement({ widthMm: roundMm(bounds.widthMm), heightMm: roundMm(bounds.heightMm) });
    if (transformed.length === 1 && transformed[0].kind === 'text') {
      setHeightSuggestion(findSameRowHeightSuggestion({
        elements: elements.map((element) => (
          element.elementKey === transformed[0].elementKey ? transformed[0] : element
        )),
        movingElementKey: transformed[0].elementKey,
        proposedHeightMm: Number(transformed[0].heightMm),
        rowToleranceMm: 1.2,
        heightToleranceMm: 1.5,
      }));
    } else {
      setHeightSuggestion(null);
    }
  };

  const handleTransformEnd = (event: Konva.KonvaEventObject<Event>) => {
    if (!claimLabelGestureCommit(transformGestureRef.current)) return;
    const rotationStep = (event.evt as MouseEvent | KeyboardEvent | PointerEvent | undefined)?.shiftKey ? 15 : 1;
    const eventFlags = event.evt as MouseEvent | PointerEvent | undefined;
    const elementsByKey = new Map(selectedElements.map((element) => [element.elementKey, element]));
    const rawSnapshots = readAndNormalizeLabelTransformedNodes(selectedElements, nodeRefs.current);
    const snapshots = rawSnapshots.length > 1
      ? normalizeLabelMultiSelectionTransform({
          elements: selectedElements,
          snapshots: rawSnapshots,
          canvasWidthMm: safeWidth,
          canvasHeightMm: safeHeight,
          snapToGrid: snapToGrid && !eventFlags?.altKey,
          rotationStep,
        })
      : rawSnapshots;
    const patches = snapshots.flatMap((snapshot) => {
      const element = elementsByKey.get(snapshot.elementKey);
      if (!element) return [];
      const widthMm = element.kind === 'qr'
        ? Math.max(snapshot.widthMm, snapshot.heightMm)
        : snapshot.widthMm;
      const heightMm = element.kind === 'qr' ? widthMm : snapshot.heightMm;
      return [{
        elementKey: element.elementKey,
        patch: {
          xMm: roundMm(snapshots.length > 1
            ? snapshot.xMm
            : clamp(applySnap(snapshot.xMm, eventFlags), 0, Math.max(0, safeWidth - widthMm))),
          yMm: roundMm(snapshots.length > 1
            ? snapshot.yMm
            : clamp(applySnap(snapshot.yMm, eventFlags), 0, Math.max(0, safeHeight - heightMm))),
          widthMm: roundMm(Math.max(0.1, snapshots.length > 1 ? widthMm : applySnap(widthMm, eventFlags))),
          heightMm: roundMm(Math.max(element.kind === 'line' ? 0 : 0.1, snapshots.length > 1 ? heightMm : applySnap(heightMm, eventFlags))),
          rotationDeg: roundMm(snapshots.length > 1
            ? snapshot.rotationDeg
            : Math.round(snapshot.rotationDeg / rotationStep) * rotationStep),
        },
      }];
    });
    commitGeometry(patches);
    transformGestureRef.current = null;
    setMeasurement(null);
    onGestureActiveChange?.(false);
  };

  const toggleElementLock = (locked: boolean) => {
    commitGeometry(contextElements.map((element) => ({
      elementKey: element.elementKey,
      patch: { style: { ...(element.style ?? {}), locked } },
    })));
    setContextMenu(null);
  };

  const setElementTextAlign = (textAlign: LabelTextAlign) => {
    commitGeometry(contextElements.filter((element) => element.kind === 'text' && !isLabelElementLocked(element)).map((element) => {
      const style = { ...(element.style ?? {}) };
      if (textAlign === 'center') delete style.textAlign;
      else style.textAlign = textAlign;
      return { elementKey: element.elementKey, patch: { style } };
    }));
    setContextMenu(null);
  };

  const patchContextTypography = (patch: { fontSizePt?: number; fontWeight?: 'normal' | 'bold'; italic?: boolean }) => {
    if (!advancedFeaturesEnabled) return;
    commitGeometry(contextElements.filter((element) => element.kind === 'text' && !isLabelElementLocked(element)).map((element) => ({
      elementKey: element.elementKey,
      patch: { style: withLabelTypography(element, patch).style },
    })));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canDrag || selectedElements.length === 0) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && !selectedElementLocked) {
      event.preventDefault();
      onDeleteElement?.(selectedElements[0].elementKey);
      return;
    }
    const delta = event.shiftKey ? 5 : 1;
    const moveBy: Record<string, [number, number]> = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    const offset = moveBy[event.key];
    if (!offset || selectedElementLocked) return;
    event.preventDefault();
    const bounds = labelElementsBounds(selectedElements);
    const deltaX = clamp(offset[0], -bounds.minX, safeWidth - bounds.maxX);
    const deltaY = clamp(offset[1], -bounds.minY, safeHeight - bounds.maxY);
    commitGeometry(selectedElements.map((element) => ({
      elementKey: element.elementKey,
      patch: {
        xMm: roundMm(Number(element.xMm ?? 0) + deltaX),
        yMm: roundMm(Number(element.yMm ?? 0) + deltaY),
      },
    })));
  };

  const handleDrop = (event: React.DragEvent<Element>) => {
    if (!canDrag || !onDropField) return;
    const fieldId = event.dataTransfer.getData('application/x-label-field') || event.dataTransfer.getData('text/plain');
    const field = fields.find((item) => item.id === fieldId);
    if (!field) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointFromEvent(event);
    setDragPreview(null);
    onDropField(field, clamp(point.x, 0, safeWidth - 1), clamp(point.y, 0, safeHeight - 1));
  };
  const handleWrapperMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canDrag) return;
    if (draggingField && onDropDraggingField) {
      event.preventDefault();
      event.stopPropagation();
      const point = pointFromEvent(event);
      setDragPreview(null);
      onDropDraggingField(draggingField, clamp(point.x, 0, safeWidth - 1), clamp(point.y, 0, safeHeight - 1));
      return;
    }
    if (draggingQr && onDropDraggingQr) {
      event.preventDefault();
      event.stopPropagation();
      if (qrDropResolvedRef.current) return;
      qrDropResolvedRef.current = true;
      const point = pointFromEvent(event);
      onDropDraggingQr(draggingQr, clamp(point.x, 0, safeWidth - 1), clamp(point.y, 0, safeHeight - 1));
    }
  };
  const updateDragPreview = (event: Pick<React.MouseEvent<Element> | React.DragEvent<Element>, 'clientX' | 'clientY'>) => {
    if (!draggingField) return;
    const point = pointFromEvent(event);
    setDragPreview({
      field: draggingField,
      xMm: clamp(point.x, 0, safeWidth - 1),
      yMm: clamp(point.y, 0, safeHeight - 1),
    });
  };
  const openContextMenuAt = (point: { x: number; y: number }) => {
    if (!canDrag) return;
    const element = findTopLabelElementAtPoint(sorted, point.x, point.y);
    if (!element) {
      setContextMenu(null);
      return;
    }
    if (!effectiveSelectedKeys.includes(element.elementKey)) {
      onSelectElement?.(element.elementKey, false);
    }
    setContextMenu({
      elementKey: element.elementKey,
      x: (point.x / safeWidth) * previewWidth,
      y: (point.y / safeHeight) * previewHeight,
    });
  };
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {canDrag && (
        <Space wrap size={8}>
          <Tooltip title="Показывает миллиметровую сетку поверх бирки. Толстые линии идут через каждые 5 мм, тонкие — через 1 мм. Помогает ровно выставлять поля и рамки.">
            <Space size={6}>
              <Text type="secondary">Сетка</Text>
              <Switch size="small" checked={showGrid} onChange={setShowGrid} />
            </Space>
          </Tooltip>
          <Tooltip title="Привязывает перемещение и изменение размера к шагу 1 мм. Удерживайте Alt во время перетаскивания или изменения размера, чтобы временно отключить привязку.">
            <Space size={6}>
              <Text type="secondary">Привязка</Text>
              <Switch size="small" checked={snapToGrid} onChange={setSnapToGrid} />
            </Space>
          </Tooltip>
          <Tooltip title="При приближении элемента к центру другого элемента появляются направляющие и координата мягко привязывается. Удерживайте Alt для свободного перемещения.">
            <Text type="secondary">Линии центрирования</Text>
          </Tooltip>
          <Tooltip title="Уменьшает масштаб визуального редактора. Размер самой бирки и координаты элементов не меняются.">
            <Button size="small" onClick={() => setZoom((value) => clamp(Math.round((value - 0.1) * 10) / 10, 0.4, 2.5))}>-</Button>
          </Tooltip>
          <Text>{Math.round(zoom * 100)}%</Text>
          <Tooltip title="Увеличивает масштаб визуального редактора. Удобно для точной настройки мелких текстов и линий.">
            <Button size="small" onClick={() => setZoom((value) => clamp(Math.round((value + 0.1) * 10) / 10, 0.4, 2.5))}>+</Button>
          </Tooltip>
          <Tooltip title="Возвращает масштаб редактора к исходному значению 100%. Это не сбрасывает изменения шаблона.">
            <Button size="small" onClick={() => setZoom(1)}>По размеру</Button>
          </Tooltip>
          <Tooltip title="Выделите элемент на бирке, чтобы появились ручки изменения размера и поворота. Для линии доступны две боковые ручки, для текста и прямоугольника — ручки по углам и сторонам.">
            <Text type="secondary">Размер/поворот</Text>
          </Tooltip>
          <Tooltip title="После выбора элемента стрелки двигают его на 1 мм. Ускоренное перемещение со стрелками двигает на 5 мм. Клавиша удаления убирает выбранный элемент.">
            <Text type="secondary">Клавиатура</Text>
          </Tooltip>
        </Space>
      )}
      <div
        ref={previewHostRef}
        data-label-preview-fit={fitToContainer ? 'container' : 'intrinsic'}
        style={{ width: '100%', overflowX: 'auto', overscrollBehaviorX: 'contain' }}
      >
        <div
          data-label-dragging-field={draggingField?.id}
          data-label-dragging-qr={draggingQr?.labelQrTemplateId}
          tabIndex={canDrag ? 0 : undefined}
          style={{
            width: previewWidth,
            aspectRatio: `${safeWidth} / ${safeHeight}`,
            border: '1px solid #d9d9d9',
            background: '#fff',
            overflow: 'hidden',
            position: 'relative',
            touchAction: 'none',
            outline: 'none',
          }}
        onDragOver={(event) => {
          if (!canDrag) return;
          event.preventDefault();
          updateDragPreview(event);
        }}
        onDragLeave={() => setDragPreview(null)}
        onDrop={handleDrop}
        onMouseMove={(event) => updateDragPreview(event)}
        onMouseUp={handleWrapperMouseUp}
        onMouseDown={(event) => {
          if (event.button !== 2) return;
          event.preventDefault();
          openContextMenuAt(pointFromEvent(event));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openContextMenuAt(pointFromEvent(event));
        }}
        onKeyDown={handleKeyDown}
      >
        <Stage
          ref={stageRef}
          width={previewWidth}
          height={previewHeight}
          scaleX={previewWidth / safeWidth}
          scaleY={previewHeight / safeHeight}
          onMouseDown={(event) => {
            if (event.evt.button !== 2) return;
            event.evt.preventDefault();
            const pointer = event.target.getStage()?.getPointerPosition();
            if (pointer) {
              openContextMenuAt({
                x: (pointer.x / previewWidth) * safeWidth,
                y: (pointer.y / previewHeight) * safeHeight,
              });
            }
          }}
          onContextMenu={(event) => {
            event.evt.preventDefault();
            const pointer = event.target.getStage()?.getPointerPosition();
            if (pointer) {
              openContextMenuAt({
                x: (pointer.x / previewWidth) * safeWidth,
                y: (pointer.y / previewHeight) * safeHeight,
              });
            }
          }}
          onWheel={(event) => {
            if (!canDrag || !event.evt.ctrlKey) return;
            event.evt.preventDefault();
            const direction = event.evt.deltaY > 0 ? -0.1 : 0.1;
            setZoom((value) => clamp(Math.round((value + direction) * 10) / 10, 0.4, 2.5));
          }}
        >
          <Layer>
            <KonvaRect x={0} y={0} width={safeWidth} height={safeHeight} fill="#fff" listening={false} />
            {showGrid && renderGrid(safeWidth, safeHeight)}
            {sorted.map((element) =>
              renderKonvaPreviewElement({
                element,
                fieldLabels,
                fieldValues,
                evaluateConditions: previewDataMode === 'sample',
                keepConditionallyHiddenTextVisible,
                selected: !externalDragActive && effectiveSelectedKeys.includes(element.elementKey),
                interactive: Boolean(canDrag && !externalDragActive),
                draggable: Boolean(canDrag && !externalDragActive && !isLabelElementLocked(element)),
                showAllBounds,
                safeWidth,
                safeHeight,
                onSelectElement: externalDragActive ? undefined : onSelectElement,
                onMoveElement,
                onDragStartElement: handleDragStartElement,
                onDragMoveElement: handleDragMoveElement,
                onDragEndElement: handleDragEndElement,
                nodeRef: (node) => {
                  if (node) nodeRefs.current.set(element.elementKey, node);
                  else nodeRefs.current.delete(element.elementKey);
                },
                onHoverElement: (hovered, event) => {
                  const pointer = event.target.getStage()?.getPointerPosition();
                  setHoveredElement({
                    element: hovered,
                    x: pointer?.x ?? 0,
                    y: pointer?.y ?? 0,
                  });
                },
                onLeaveElement: () => setHoveredElement(null),
                onContextMenu: externalDragActive ? undefined : (menuElement, event) => {
                  if (!canDrag) return;
                  event.evt.preventDefault();
                  const pointer = event.target.getStage()?.getPointerPosition();
                  if (!effectiveSelectedKeys.includes(menuElement.elementKey)) {
                    onSelectElement?.(menuElement.elementKey, false);
                  }
                  setContextMenu({
                    elementKey: menuElement.elementKey,
                    x: pointer?.x ?? 0,
                    y: pointer?.y ?? 0,
                  });
                },
              }),
            )}
            {renderAlignmentGuides(alignmentGuides, safeWidth, safeHeight)}
            {dragPreview && (
              <>
                <KonvaText
                  x={dragPreview.xMm}
                  y={dragPreview.yMm}
                  width={Math.min(40, Math.max(8, safeWidth - dragPreview.xMm))}
                  height={7}
                  text={dragPreview.field.label}
                  fontFamily="Arial"
                  fontSize={4.2}
                  fill="#1677ff"
                  opacity={0.72}
                  listening={false}
                />
                <KonvaRect
                  x={dragPreview.xMm}
                  y={dragPreview.yMm}
                  width={Math.min(40, Math.max(8, safeWidth - dragPreview.xMm))}
                  height={7}
                  stroke="#1677ff"
                  strokeWidth={0.3}
                  dash={[1, 1]}
                  opacity={0.72}
                  listening={false}
                />
              </>
            )}
            {canDrag && !externalDragActive && (
              <Transformer
                ref={transformerRef}
                rotateEnabled
                flipEnabled={false}
                keepRatio={selectedElements.length > 1 || selectedElement?.kind === 'qr'}
                enabledAnchors={selectedElements.length === 1 && selectedElement?.kind === 'line' ? ['middle-left', 'middle-right'] : undefined}
                boundBoxFunc={(oldBox, newBox) => (
                  newBox.width < 2 || newBox.height < 2 ? oldBox : newBox
                )}
                onTransformStart={handleTransformStart}
                onTransform={handleTransform}
                onTransformEnd={handleTransformEnd}
              />
            )}
          </Layer>
        </Stage>
        {measurement && (
          <div
            data-label-measurement
            style={{
              position: 'absolute',
              right: 8,
              top: 8,
              zIndex: 3,
              padding: '4px 7px',
              color: '#fff',
              background: 'rgba(0, 0, 0, 0.72)',
              borderRadius: 4,
              fontSize: 12,
              pointerEvents: 'none',
            }}
          >
            {roundMm(measurement.widthMm)} × {roundMm(measurement.heightMm)} мм
          </div>
        )}
        {heightSuggestion && selectedElements.length === 1 && (
          <Button
            data-label-height-suggestion
            size="small"
            type="primary"
            style={{ position: 'absolute', right: 8, bottom: 8, zIndex: 3 }}
            onClick={() => {
              commitGeometry([{
                elementKey: selectedElements[0].elementKey,
                patch: { heightMm: heightSuggestion.heightMm },
              }]);
              setHeightSuggestion(null);
            }}
          >
            Выровнять высоту: {roundMm(heightSuggestion.heightMm)} мм
          </Button>
        )}
        {contextMenu && contextElement && contextBounds && (
          <div
            data-label-context-menu
            style={{
              position: 'absolute',
              left: Math.min(contextMenu.x + 6, Math.max(8, previewWidth - 252)),
              top: Math.min(contextMenu.y + 6, Math.max(8, previewHeight - 420)),
              zIndex: 3,
              minWidth: 244,
              padding: 4,
              background: '#fff',
              border: '1px solid #d9d9d9',
              borderRadius: 4,
              boxShadow: '0 6px 16px rgba(0, 0, 0, 0.16)',
            }}
            onMouseLeave={() => setContextMenu(null)}
          >
            <div style={{ padding: '4px 6px 7px', borderBottom: '1px solid #f0f0f0', marginBottom: 3 }}>
              <Text strong style={{ display: 'block', fontSize: 12 }}>
                {contextElements.length > 1 ? `Выбрано: ${contextElements.length}` : labelElementTitle(contextElement, fieldInfo)}
              </Text>
              <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 3 }}>
                X {roundMm(contextBounds.minX)} · Y {roundMm(contextBounds.minY)} · {roundMm(contextBounds.widthMm)} × {roundMm(contextBounds.heightMm)} мм
              </Text>
            </div>
            {contextTextElement && (
              <div style={{ padding: '4px 4px 6px' }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                  Шрифт
                </Text>
                <Space.Compact block style={{ marginBottom: 6 }}>
                  <InputNumber
                    aria-label="Размер шрифта в контекстном меню"
                    min={4}
                    max={96}
                    addonAfter="pt"
                    value={readLabelTypography(contextTextElement).fontSizePt}
                    disabled={!advancedFeaturesEnabled || contextElements.some(isLabelElementLocked)}
                    onChange={(value) => patchContextTypography({ fontSizePt: Number(value ?? 10) })}
                  />
                  <Button
                    type={readLabelTypography(contextTextElement).fontWeight === 'bold' ? 'primary' : 'default'}
                    disabled={!advancedFeaturesEnabled || contextElements.some(isLabelElementLocked)}
                    onClick={() => patchContextTypography({
                      fontWeight: readLabelTypography(contextTextElement).fontWeight === 'bold' ? 'normal' : 'bold',
                    })}
                  >
                    <strong>Ж</strong>
                  </Button>
                  <Button
                    type={readLabelTypography(contextTextElement).italic ? 'primary' : 'default'}
                    disabled={!advancedFeaturesEnabled || contextElements.some(isLabelElementLocked)}
                    onClick={() => patchContextTypography({ italic: !readLabelTypography(contextTextElement).italic })}
                  >
                    <em>К</em>
                  </Button>
                </Space.Compact>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                  Выравнивание значения
                </Text>
                <Space.Compact block>
                  <Tooltip title="Выровнять значение по левой стороне поля">
                    <Button
                      size="small"
                      icon={<AlignLeftOutlined />}
                      type={getLabelTextAlign(contextTextElement) === 'left' ? 'primary' : 'default'}
                      disabled={contextElements.some(isLabelElementLocked)}
                      onClick={() => setElementTextAlign('left')}
                    />
                  </Tooltip>
                  <Tooltip title="Выровнять значение по центру поля">
                    <Button
                      size="small"
                      icon={<AlignCenterOutlined />}
                      type={getLabelTextAlign(contextTextElement) === 'center' ? 'primary' : 'default'}
                      disabled={contextElements.some(isLabelElementLocked)}
                      onClick={() => setElementTextAlign('center')}
                    />
                  </Tooltip>
                  <Tooltip title="Выровнять значение по правой стороне поля">
                    <Button
                      size="small"
                      icon={<AlignRightOutlined />}
                      type={getLabelTextAlign(contextTextElement) === 'right' ? 'primary' : 'default'}
                      disabled={contextElements.some(isLabelElementLocked)}
                      onClick={() => setElementTextAlign('right')}
                    />
                  </Tooltip>
                </Space.Compact>
              </div>
            )}
            <Button
              type="text"
              size="small"
              block
              disabled={contextElements.some(isLabelElementLocked)}
              onClick={() => {
                onCenterElements?.(contextKeys, 'horizontal');
                setContextMenu(null);
              }}
            >
              По горизонтальному центру канваса
            </Button>
            <Button
              type="text"
              size="small"
              block
              disabled={contextElements.some(isLabelElementLocked)}
              onClick={() => {
                onCenterElements?.(contextKeys, 'vertical');
                setContextMenu(null);
              }}
            >
              По вертикальному центру канваса
            </Button>
            {contextElements.length > 1 && (
              <Button
                type="text"
                size="small"
                block
                disabled={!advancedFeaturesEnabled || contextElements.some(isLabelElementLocked)}
                onClick={() => {
                  onGroupElements?.(contextKeys);
                  setContextMenu(null);
                }}
              >
                {contextHasGroup ? 'Перегруппировать выделение' : 'Сгруппировать'}
              </Button>
            )}
            {contextHasGroup && (
              <Button
                type="text"
                size="small"
                block
                disabled={!advancedFeaturesEnabled || contextElements.some(isLabelElementLocked)}
                onClick={() => {
                  onUngroupElements?.(contextKeys);
                  setContextMenu(null);
                }}
              >
                Разгруппировать
              </Button>
            )}
            <Button
              type="text"
              size="small"
              block
              onClick={() => toggleElementLock(!contextAllLocked)}
            >
              {contextAllLocked ? 'Разблокировать' : 'Заблокировать'}
            </Button>
            <Button
              type="text"
              size="small"
              block
              onClick={() => {
                onDuplicateElement?.(contextElement.elementKey);
                setContextMenu(null);
              }}
            >
              Сделать копию
            </Button>
            <Button
              type="text"
              size="small"
              block
              onClick={() => {
                onBringElementToFront?.(contextElement.elementKey);
                setContextMenu(null);
              }}
            >
              На передний план
            </Button>
            <Button
              type="text"
              size="small"
              block
              onClick={() => {
                onSendElementToBack?.(contextElement.elementKey);
                setContextMenu(null);
              }}
            >
              На задний план
            </Button>
            <Button
              danger
              type="text"
              size="small"
              block
              onClick={() => {
                onDeleteElement?.(contextElement.elementKey);
                setContextMenu(null);
              }}
            >
              Удалить
            </Button>
          </div>
        )}
        {hoveredElement && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(hoveredElement.x + 10, Math.max(8, previewWidth - 230)),
              top: Math.min(hoveredElement.y + 10, Math.max(8, previewHeight - 74)),
              maxWidth: 220,
              padding: '6px 8px',
              color: '#fff',
              background: 'rgba(0, 0, 0, 0.78)',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.35,
              pointerEvents: 'none',
              zIndex: 2,
            }}
          >
            {describeLabelElement(hoveredElement.element, fieldInfo)}
          </div>
        )}
      </div>
      </div>
    </Space>
  );
}

type FieldHealth = 'changed' | 'missing';

function compareFieldSnapshot(
  snapshot: LabelFieldCatalogSnapshot,
  currentFields: readonly LabelFieldCatalogItem[],
  referencedFieldIds: ReadonlySet<string>,
): Map<string, FieldHealth> {
  const currentById = new Map(currentFields.map((field) => [field.id, field]));
  const health = new Map<string, FieldHealth>();
  for (const fieldId of referencedFieldIds) {
    const current = currentById.get(fieldId);
    if (!current) {
      health.set(fieldId, 'missing');
      continue;
    }
    const previous = snapshot[fieldId];
    if (
      previous &&
      (previous.type !== current.type || previous.label !== current.label || previous.sourceColumn !== current.sourceColumn)
    ) {
      health.set(fieldId, 'changed');
    }
  }
  return health;
}

function appendMissingSnapshotFields(
  currentFields: readonly LabelFieldCatalogItem[],
  snapshot: LabelFieldCatalogSnapshot,
  health: ReadonlyMap<string, FieldHealth>,
): LabelFieldCatalogItem[] {
  const result = [...currentFields];
  const currentIds = new Set(currentFields.map((field) => field.id));
  for (const [fieldId, status] of health) {
    if (status !== 'missing' || currentIds.has(fieldId)) continue;
    const previous = snapshot[fieldId];
    const source = fieldId.startsWith('detail.')
      ? 'detail'
      : fieldId.startsWith('order.')
        ? 'order'
        : fieldId.startsWith('bazis.')
          ? 'bazis'
          : 'dynamic';
    result.push({
      id: fieldId,
      source,
      sourceColumn: previous?.sourceColumn ?? null,
      label: previous?.label ?? fieldId,
      type: previous?.type ?? 'string',
      category: 'Недоступные поля',
    });
  }
  return result;
}

function fieldHealthColor(health: FieldHealth | undefined): 'error' | 'warning' | undefined {
  if (health === 'missing') return 'error';
  if (health === 'changed') return 'warning';
  return undefined;
}

function fieldHealthTitle(health: FieldHealth | undefined): string | undefined {
  if (health === 'missing') return 'Поле отсутствует в актуальной схеме деталей';
  if (health === 'changed') return 'Название или тип поля изменились после сохранения шаблона';
  return undefined;
}

function FieldPalette({
  fields,
  usedFieldIds,
  fieldHealth,
  disabled,
  search,
  onSearch,
  onBeginDrag,
  maxHeight,
}: {
  fields: LabelFieldCatalogItem[];
  usedFieldIds?: Set<string>;
  fieldHealth?: ReadonlyMap<string, FieldHealth>;
  disabled?: boolean;
  search: string;
  onSearch: (value: string) => void;
  onBeginDrag?: (field: LabelFieldCatalogItem) => void;
  maxHeight?: number;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const visibleFields = fields.filter((field) => {
    if (!normalizedSearch) return true;
    return `${field.category} ${field.label} ${field.id}`.toLowerCase().includes(normalizedSearch);
  });
  const grouped = groupFieldsByCategory(visibleFields);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Input.Search value={search} onChange={(event) => onSearch(event.target.value)} allowClear />
      {fieldHealth && fieldHealth.size > 0 && (
        <Space size={6} wrap>
          {[...fieldHealth.values()].includes('changed') && <Tag color="warning">Изменено в схеме</Tag>}
          {[...fieldHealth.values()].includes('missing') && <Tag color="error">Отсутствует в схеме</Tag>}
        </Space>
      )}
      <div style={{ maxHeight: maxHeight ?? 280, overflowY: 'auto', paddingRight: 4 }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {grouped.map(([category, categoryFields]) => (
            <div key={category}>
              <Text type="secondary">{category}</Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {categoryFields.map((field) => {
                  const used = usedFieldIds?.has(field.id) ?? false;
                  const health = fieldHealth?.get(field.id);
                  const unavailable = health === 'missing';
                  const source = describeLabelFieldSource(field);
                  return (
                    <Tooltip
                      key={field.id}
                      mouseEnterDelay={0.25}
                      title={
                        <Space direction="vertical" size={2}>
                          <div style={{ fontWeight: 600 }}>{field.category}: {field.label}</div>
                          <div>{source.entity}</div>
                          <code style={{ color: 'inherit', fontSize: 11 }}>{source.databasePath}</code>
                          <div style={{ opacity: 0.82, fontSize: 11 }}>
                            Поле шаблона: <code style={{ color: 'inherit' }}>{field.id}</code>
                            {' · '}
                            Тип: {labelFieldTypeName(field.type)}
                          </div>
                          {fieldHealthTitle(health) && (
                            <div style={{ color: '#ffd666', fontSize: 11 }}>{fieldHealthTitle(health)}</div>
                          )}
                        </Space>
                      }
                    >
                      <Tag
                        color={fieldHealthColor(health) ?? (used ? 'processing' : undefined)}
                        draggable={!disabled && !unavailable}
                        onDragStart={(event) => {
                          if (!disabled && !unavailable) onBeginDrag?.(field);
                          event.dataTransfer.setData('application/x-label-field', field.id);
                          event.dataTransfer.setData('text/plain', field.id);
                          event.dataTransfer.effectAllowed = 'copy';
                        }}
                        onMouseDown={(event) => {
                          if (disabled || unavailable) return;
                          event.preventDefault();
                          onBeginDrag?.(field);
                        }}
                        onMouseDownCapture={(event) => {
                          if (disabled || unavailable) return;
                          event.preventDefault();
                          onBeginDrag?.(field);
                        }}
                        onPointerDown={(event) => {
                          if (disabled || unavailable) return;
                          event.preventDefault();
                          onBeginDrag?.(field);
                        }}
                        onPointerDownCapture={(event) => {
                          if (disabled || unavailable) return;
                          event.preventDefault();
                          onBeginDrag?.(field);
                        }}
                        style={{
                          cursor: disabled || unavailable ? 'default' : 'grab',
                          userSelect: 'none',
                          fontWeight: used ? 600 : 400,
                        }}
                      >
                        <span
                          onMouseDown={(event) => {
                            if (disabled || unavailable) return;
                            event.preventDefault();
                            onBeginDrag?.(field);
                          }}
                          onPointerDown={(event) => {
                            if (disabled || unavailable) return;
                            event.preventDefault();
                            onBeginDrag?.(field);
                          }}
                          style={{ display: 'inline-block' }}
                        >
                          {field.label}
                        </span>
                      </Tag>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
        </Space>
      </div>
    </Space>
  );
}

function labelFieldTypeName(type: LabelFieldCatalogItem['type']): string {
  if (type === 'number') return 'число';
  if (type === 'boolean') return 'да/нет';
  if (type === 'date') return 'дата';
  return 'текст';
}

function groupFieldsByCategory(fields: LabelFieldCatalogItem[]): Array<[string, LabelFieldCatalogItem[]]> {
  const grouped = new Map<string, LabelFieldCatalogItem[]>();
  for (const field of fields) {
    grouped.set(field.category, [...(grouped.get(field.category) ?? []), field]);
  }
  return Array.from(grouped.entries()).sort(([a], [b]) => {
    const order = ['Недоступные поля', 'Кастомные', 'Деталь', 'Заказ', 'Динамические'];
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.localeCompare(b, 'ru');
  });
}

function renderKonvaPreviewElement({
  element,
  fieldLabels,
  fieldValues,
  evaluateConditions,
  keepConditionallyHiddenTextVisible,
  selected,
  interactive,
  draggable,
  showAllBounds,
  safeWidth,
  safeHeight,
  onSelectElement,
  onMoveElement,
  onDragStartElement,
  onDragMoveElement,
  onDragEndElement,
  nodeRef,
  onHoverElement,
  onLeaveElement,
  onContextMenu,
}: {
  element: LabelTemplateElement;
  fieldLabels: Map<string, string>;
  fieldValues: Map<string, string>;
  evaluateConditions: boolean;
  keepConditionallyHiddenTextVisible: boolean;
  selected: boolean;
  interactive: boolean;
  draggable: boolean;
  showAllBounds?: boolean;
  safeWidth: number;
  safeHeight: number;
  onSelectElement?: (elementKey: string, additive: boolean) => void;
  onMoveElement?: (elementKey: string, xMm: number, yMm: number, event?: { altKey?: boolean }) => void;
  onDragStartElement?: (elementKey: string, node: Konva.Node) => void;
  onDragMoveElement?: (
    elementKey: string,
    node: Konva.Node,
    event: Konva.KonvaEventObject<DragEvent>,
  ) => void;
  onDragEndElement?: (elementKey: string) => void;
  nodeRef?: (node: Konva.Node | null) => void;
  onHoverElement?: (element: LabelTemplateElement, event: Konva.KonvaEventObject<MouseEvent>) => void;
  onLeaveElement?: () => void;
  onContextMenu?: (element: LabelTemplateElement, event: Konva.KonvaEventObject<MouseEvent>) => void;
}) {
  const x = Number(element.xMm ?? 0);
  const y = Number(element.yMm ?? 0);
  const w = Number(element.widthMm ?? 0);
  const h = Number(element.heightMm ?? 0);
  const key = element.elementKey;
  const rotation = Number(element.rotationDeg ?? 0);
  const maxX = Math.max(0, safeWidth - Math.max(w, 1));
  const maxY = Math.max(0, safeHeight - Math.max(h, 1));
  const select = (event: Konva.KonvaEventObject<MouseEvent>) => onSelectElement?.(key, Boolean(event.evt.shiftKey));
  const dragEnd = (event: Konva.KonvaEventObject<DragEvent>) => {
    if (onDragEndElement) {
      onDragEndElement(key);
      return;
    }
    onMoveElement?.(key, clamp(event.target.x(), 0, maxX), clamp(event.target.y(), 0, maxY), event.evt);
  };
  const common = {
    ref: nodeRef,
    x,
    y,
    rotation,
    listening: interactive,
    draggable,
    onClick: select,
    onTap: () => onSelectElement?.(key, false),
    onMouseDown: (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 2) return;
      event.evt.preventDefault();
      onContextMenu?.(element, event);
    },
    onDragStart: (event: Konva.KonvaEventObject<DragEvent>) => {
      if (!selected) onSelectElement?.(key, false);
      onDragStartElement?.(key, event.target);
    },
    onDragMove: (event: Konva.KonvaEventObject<DragEvent>) => onDragMoveElement?.(key, event.target, event),
    onDragEnd: dragEnd,
    onContextMenu: (event: Konva.KonvaEventObject<MouseEvent>) => onContextMenu?.(element, event),
    onMouseEnter: (event: Konva.KonvaEventObject<MouseEvent>) => {
      event.target.getStage()?.container().style.setProperty('cursor', draggable ? 'move' : 'default');
      onHoverElement?.(element, event);
    },
    onMouseMove: (event: Konva.KonvaEventObject<MouseEvent>) => onHoverElement?.(element, event),
    onMouseLeave: (event: Konva.KonvaEventObject<MouseEvent>) => {
      event.target.getStage()?.container().style.setProperty('cursor', 'default');
      onLeaveElement?.();
    },
  };
  const selectionBox = selected ? (
    <KonvaRect
      key={`${key}-selected`}
      x={x}
      y={y}
      width={Math.max(w, 2)}
      height={Math.max(h, 2)}
      rotation={rotation}
      stroke="#1677ff"
      strokeWidth={0.35}
      dash={[1, 1]}
      listening={false}
    />
  ) : null;
  // Non-interactive bounds outline drawn for EVERY element when the "show all element
  // borders" toggle is on, so overlaps/extents can be inspected without selecting each
  // element one at a time. Purely visual — never affects selection/drag/hit-testing.
  const allBoundsBox = showAllBounds ? (
    <KonvaRect
      key={`${key}-all-bounds`}
      x={x}
      y={y}
      width={Math.max(w, 2)}
      height={Math.max(h, 2)}
      rotation={rotation}
      stroke="#faad14"
      strokeWidth={0.3}
      dash={[1, 1]}
      listening={false}
    />
  ) : null;

  if (element.kind === 'line') {
    return (
      <React.Fragment key={key}>
        <KonvaLine
          {...common}
          points={[0, 0, w, h]}
          stroke="black"
          strokeWidth={0.45}
          hitStrokeWidth={4}
        />
        {selectionBox}
        {allBoundsBox}
      </React.Fragment>
    );
  }
  if (element.kind === 'rect') {
    return (
      <React.Fragment key={key}>
        <KonvaRect
          {...common}
          width={Math.max(w, 0.1)}
          height={Math.max(h, 0.1)}
          fill="transparent"
          stroke="black"
          strokeWidth={Number(element.style?.strokeWidth ?? 0.45)}
        />
        {selectionBox}
        {allBoundsBox}
      </React.Fragment>
    );
  }
  if (element.kind === 'cut_map') {
    const innerWidth = Math.max(w, 2);
    const innerHeight = Math.max(h, 2);
    return (
      <React.Fragment key={key}>
        <KonvaGroup {...common} width={innerWidth} height={innerHeight}>
          <KonvaRect
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="#f7f9fb"
            stroke="#5b6b7a"
            strokeWidth={0.35}
          />
          <KonvaRect x={innerWidth * 0.05} y={innerHeight * 0.08} width={innerWidth * 0.42} height={innerHeight * 0.36} fill="#e5ebf0" stroke="#8c9aa7" strokeWidth={0.2} listening={false} />
          <KonvaRect x={innerWidth * 0.5} y={innerHeight * 0.08} width={innerWidth * 0.45} height={innerHeight * 0.2} fill="#e5ebf0" stroke="#8c9aa7" strokeWidth={0.2} listening={false} />
          <KonvaRect x={innerWidth * 0.5} y={innerHeight * 0.31} width={innerWidth * 0.22} height={innerHeight * 0.58} fill="#ffd666" stroke="#d4380d" strokeWidth={0.55} listening={false} />
          <KonvaRect x={innerWidth * 0.75} y={innerHeight * 0.31} width={innerWidth * 0.2} height={innerHeight * 0.58} fill="#e5ebf0" stroke="#8c9aa7" strokeWidth={0.2} listening={false} />
          <KonvaText
            x={innerWidth * 0.05}
            y={innerHeight * 0.56}
            width={innerWidth * 0.4}
            text="Лист раскроя"
            fontFamily="Arial"
            fontSize={Math.max(1.8, Math.min(innerWidth, innerHeight) * 0.12)}
            fill="#5b6b7a"
            align="center"
            listening={false}
          />
        </KonvaGroup>
        {selectionBox}
        {allBoundsBox}
      </React.Fragment>
    );
  }
  if (element.kind === 'qr') {
    const side = qrSideOf(element);
    const protectedRect = qrProtectedRect(element);
    const moduleSide = side / 7;
    const modules = [
      [0, 0], [1, 0], [2, 0], [4, 0], [5, 0], [6, 0],
      [0, 1], [2, 1], [3, 1], [6, 1],
      [0, 2], [1, 2], [2, 2], [4, 2], [6, 2],
      [3, 3], [5, 3],
      [0, 4], [2, 4], [4, 4], [5, 4], [6, 4],
      [0, 5], [3, 5], [6, 5],
      [0, 6], [1, 6], [2, 6], [4, 6], [6, 6],
    ];
    return (
      <React.Fragment key={key}>
        <KonvaRect
          x={protectedRect.x}
          y={protectedRect.y}
          width={protectedRect.width}
          height={protectedRect.height}
          stroke="#8c8c8c"
          strokeWidth={0.25}
          dash={[1, 1]}
          listening={false}
        />
        {/* The QR frame + modules + label are ONE draggable Konva group so the
            whole QR image moves/resizes together. Previously the frame was the
            only draggable node and the modules were absolutely-positioned
            siblings, so a drag left the image behind and only the frame moved.
            width/height are set on the group so the resize Transformer
            normalization helper keeps working. */}
        <KonvaGroup {...common} width={side} height={side}>
          <KonvaRect
            x={0}
            y={0}
            width={side}
            height={side}
            fill="white"
            stroke="black"
            strokeWidth={0.35}
          />
          {modules.map(([col, row], index) => (
            <KonvaRect
              key={`${key}-module-${index}`}
              x={col * moduleSide}
              y={row * moduleSide}
              width={moduleSide}
              height={moduleSide}
              fill="black"
              listening={false}
            />
          ))}
          <KonvaText
            x={0}
            y={side / 2 - 2}
            width={side}
            height={4}
            text="QR"
            fontFamily="Arial"
            fontSize={Math.max(2, side * 0.18)}
            fontStyle="bold"
            fill="#1677ff"
            align="center"
            listening={false}
          />
        </KonvaGroup>
        {selectionBox}
        {allBoundsBox}
      </React.Fragment>
    );
  }

  const typography = readLabelTypography(element);
  const fontSize = Math.max(1.8, typography.fontSizePt * 0.3528);
  const textAlign = getLabelTextAlign(element);
  const text = resolveLabelCanvasText(element, fieldValues, fieldLabels, {
    evaluateConditions,
    keepSourceVisible: keepConditionallyHiddenTextVisible,
  });
  const manualBounds = readLabelEditorMeta(element).boundsMode === 'manual';
  const fontStyle = [typography.fontWeight === 'bold' ? 'bold' : '', typography.italic ? 'italic' : '']
    .filter(Boolean)
    .join(' ') || 'normal';
  return (
    <React.Fragment key={key}>
      <KonvaText
        {...common}
        width={Math.max(w, 1)}
        height={manualBounds ? Math.max(h, 0.1) : Math.max(h, fontSize + 1)}
        text={text}
        fontFamily="Arial"
        fontSize={fontSize}
        fontStyle={fontStyle}
        fill="black"
        align={textAlign}
        wrap="none"
        ellipsis={false}
      />
      {selectionBox}
      {allBoundsBox}
    </React.Fragment>
  );
}

function describeLabelElement(
  element: LabelTemplateElement,
  fieldInfo: Map<string, LabelFieldCatalogItem>,
): React.ReactNode {
  if (element.kind === 'rect') return 'Прямоугольник';
  if (element.kind === 'line') return 'Линия';
  if (element.kind === 'qr') return `QR-код: ${qrTemplateOf(element) || 'шаблон не задан'}`;
  if (element.kind === 'cut_map') return 'Миниатюра листа раскроя с выделением детали';
  if (element.sourceField) {
    const field = fieldInfo.get(element.sourceField);
    if (field) {
      return (
        <>
          <div>{field.label}</div>
          <div>В списке полей: {field.category}: {field.label}</div>
          <div>{field.id}</div>
        </>
      );
    }
    return (
      <>
        <div>{element.sourceField}</div>
        <div>В списке полей: поле не найдено</div>
      </>
    );
  }
  return `Статический текст: ${element.staticText || 'пусто'}`;
}

function labelElementTitle(
  element: LabelTemplateElement,
  fieldInfo: Map<string, LabelFieldCatalogItem>,
): string {
  if (element.kind === 'rect') return 'Прямоугольник';
  if (element.kind === 'line') return 'Линия';
  if (element.kind === 'qr') return 'QR-код';
  if (element.kind === 'cut_map') return 'Миниатюра раскроя';
  if (element.sourceField) return fieldInfo.get(element.sourceField)?.label ?? element.sourceField;
  return element.staticText || 'Текст';
}

function isLabelElementLocked(element: LabelTemplateElement): boolean {
  return Boolean((element.style as Record<string, unknown> | undefined)?.locked);
}

type LabelTextAlign = 'left' | 'center' | 'right';

function getLabelTextAlign(element: LabelTemplateElement): LabelTextAlign {
  const value = (element.style as Record<string, unknown> | undefined)?.textAlign;
  return value === 'left' || value === 'right' ? value : 'center';
}

function findTopLabelElementAtPoint(
  elements: LabelTemplateElement[],
  xMm: number,
  yMm: number,
): LabelTemplateElement | null {
  for (const element of elements.slice().reverse()) {
    const x = Number(element.xMm ?? 0);
    const y = Number(element.yMm ?? 0);
    const width = Math.max(1, Number(element.widthMm ?? 0));
    const height = Math.max(element.kind === 'line' ? 1 : 2, Number(element.heightMm ?? 0));
    if (xMm >= x && xMm <= x + width && yMm >= y && yMm <= y + height) {
      return element;
    }
  }
  return null;
}

function renderGrid(widthMm: number, heightMm: number) {
  const lines = [];
  for (let x = 1; x < widthMm; x += 1) {
    const major = x % 5 === 0;
    lines.push(
      <KonvaLine
        key={`grid-x-${x}`}
        points={[x, 0, x, heightMm]}
        stroke={major ? '#d9d9d9' : '#f0f0f0'}
        strokeWidth={major ? 0.12 : 0.06}
        listening={false}
      />,
    );
  }
  for (let y = 1; y < heightMm; y += 1) {
    const major = y % 5 === 0;
    lines.push(
      <KonvaLine
        key={`grid-y-${y}`}
        points={[0, y, widthMm, y]}
        stroke={major ? '#d9d9d9' : '#f0f0f0'}
        strokeWidth={major ? 0.12 : 0.06}
        listening={false}
      />,
    );
  }
  return lines;
}

function renderAlignmentGuides(
  guides: AlignmentGuide[],
  widthMm: number,
  heightMm: number,
) {
  return guides.map((guide) => (
    <KonvaLine
      key={`${guide.axis}-${guide.targetElementKey}`}
      points={guide.axis === 'vertical'
        ? [guide.positionMm, 0, guide.positionMm, heightMm]
        : [0, guide.positionMm, widthMm, guide.positionMm]}
      stroke="#13a8a8"
      strokeWidth={0.32}
      dash={[1.2, 0.8]}
      listening={false}
    />
  ));
}

function defaultIfElseCondition(field = ''): LabelIfElseCondition {
  return {
    type: 'if_else',
    version: 1,
    when: { field, op: 'not_empty' },
    then: { type: 'current' },
    else: { type: 'hidden' },
  };
}

function defaultCustomFieldExpression(field = ''): LabelCustomFieldExpressionV1 {
  return {
    type: 'custom_expression',
    version: 1,
    root: { type: 'field', field },
  };
}

function newLabelTextStyle(advancedRendererReady: boolean): Record<string, unknown> {
  return advancedRendererReady
    ? {
        typography: { version: 1, fontSizePt: 12, fontWeight: 'normal', italic: false },
        editor: { version: 1, boundsMode: 'auto' },
      }
    : { fontSize: 12 };
}

function withoutCutMapStyle(style: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!style) return {};
  const { cutMap: _cutMap, ...rest } = style;
  return rest;
}

function isLabelConditionDraftValid(condition: LabelIfElseCondition): boolean {
  if (!condition.when.field.trim()) return false;
  if (
    (condition.when.op === 'equals' || condition.when.op === 'not_equals')
    && condition.when.value === undefined
  ) return false;
  return [condition.then, condition.else].every((branch) => (
    branch.type !== 'field' || Boolean(branch.field.trim())
  ));
}

function hasAdvancedLabelElementData(element: LabelTemplateElement): boolean {
  const style = element.style as Record<string, unknown> | undefined;
  const condition = element.condition as Record<string, unknown> | undefined;
  return Boolean(style?.typography || style?.editor || style?.cutMap || condition?.type === 'if_else');
}

function cleanupSingletonLabelGroups(elements: LabelTemplateElement[]): LabelTemplateElement[] {
  const counts = new Map<string, number>();
  for (const element of elements) {
    const groupId = readLabelEditorMeta(element).groupId;
    if (groupId) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  return elements.map((element) => {
    const groupId = readLabelEditorMeta(element).groupId;
    return groupId && (counts.get(groupId) ?? 0) < 2
      ? withLabelEditorMeta(element, { groupId: null })
      : element;
  });
}

function sampleLabelFieldValue(field: LabelFieldCatalogItem, index: number): string {
  if (field.type === 'boolean') return 'Да';
  if (field.type === 'date') return '21.07.2026';
  if (field.type === 'number') return String(100 + index);
  if (field.id.includes('name')) return field.label === 'Название' ? 'Фасад кухонный' : field.label;
  if (field.id.includes('number')) return 'ЗК-1048';
  return `${field.label} ${index + 1}`;
}

function labelElementsBounds(elements: LabelTemplateElement[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthMm: number;
  heightMm: number;
} {
  const points = elements.flatMap((element) => {
    const x = Number(element.xMm ?? 0);
    const y = Number(element.yMm ?? 0);
    const width = Math.max(0.1, Number(element.widthMm ?? 0));
    const height = Math.max(element.kind === 'line' ? 0.1 : 0.1, Number(element.heightMm ?? 0));
    const angle = Number(element.rotationDeg ?? 0) * Math.PI / 180;
    const rotate = (offsetX: number, offsetY: number) => ({
      x: x + offsetX * Math.cos(angle) - offsetY * Math.sin(angle),
      y: y + offsetX * Math.sin(angle) + offsetY * Math.cos(angle),
    });
    return [rotate(0, 0), rotate(width, 0), rotate(width, height), rotate(0, height)];
  });
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return { minX, minY, maxX, maxY, widthMm: maxX - minX, heightMm: maxY - minY };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundMm(value: number): number {
  return Math.round(value * 10) / 10;
}

function toTemplateElementInput(elements: LabelTemplateElement[]): LabelTemplateElement[] {
  return elements.map(({ labelTemplateElementId: _labelTemplateElementId, ...element }) => element);
}

function parseBazisTemplateVariants(xmlText: string, fileName: string): BazisImportVariant[] {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseError = document.querySelector('parsererror');
  if (parseError) throw new Error('invalid xbir xml');

  const columns = Array.from(document.querySelectorAll('Cols Col')).sort(
    (a, b) => Number(a.getAttribute('Index') ?? 0) - Number(b.getAttribute('Index') ?? 0),
  );
  const templateIndex = columns.findIndex((column) => column.getAttribute('Name') === 'Шаблон бирки');
  const rows = Array.from(document.querySelectorAll('Rows Row')).map((row) => row.textContent?.split('\t') ?? []);
  const grouped = new Map<string, string[][]>();

  for (const row of rows) {
    const templatePath = templateIndex >= 0 ? normalizeBazisTemplatePath(row[templateIndex]) : '';
    const key = templatePath || 'Встроенный стандарт';
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return Array.from(grouped.entries()).map(([templatePath, templateRows], index) => {
    const templateName = templatePath === 'Встроенный стандарт' ? templatePath : templatePath.split(/[\\/]/).pop() ?? templatePath;
    const baseName = fileName.replace(/\.(xbir|xml)$/i, '');
    return {
      key: `${templatePath}-${index}`,
      name: `Импорт Bazis ${templateName}`,
      description: `Создано из ${baseName}: ${templateRows.length} строк, источник ${templatePath}.`,
      rowCount: templateRows.length,
      templateFiles: [templatePath],
      elements: buildStandardBazisElements(),
    };
  });
}

function normalizeBazisTemplatePath(value: string | undefined): string {
  return String(value ?? '').trim();
}

function buildStandardBazisElements(): LabelTemplateElement[] {
  const text = (
    elementKey: string,
    sourceField: string | null,
    staticText: string | null,
    xMm: number,
    yMm: number,
    widthMm: number,
    heightMm: number,
    fontSize = 10,
    zIndex = 1,
  ): LabelTemplateElement => ({
    elementKey,
    kind: 'text',
    sourceField,
    staticText,
    xMm,
    yMm,
    widthMm,
    heightMm,
    rotationDeg: 0,
    zIndex,
    style: { fontSize },
    condition: {},
  });

  return [
    {
      elementKey: 'border',
      kind: 'rect',
      sourceField: null,
      staticText: null,
      xMm: 1,
      yMm: 1,
      widthMm: 83,
      heightMm: 86,
      rotationDeg: 0,
      zIndex: 0,
      style: { strokeWidth: 1 },
      condition: {},
    },
    text('detail-id-label', null, '№:', 2, 4, 14, 8, 13, 1),
    text('detail-id-value', 'bazis.detail_id', null, 36, 6, 30, 10, 18, 2),
    text('order-label', null, 'Заказ№:', 2, 18, 22, 7, 11, 3),
    text('order-value', 'bazis.order_number', null, 24, 18, 56, 7, 11, 4),
    text('position-label', null, 'Поз.', 2, 28, 13, 7, 11, 5),
    text('position-value', 'bazis.position', null, 15, 28, 20, 7, 11, 6),
    text('material-value', 'bazis.material', null, 31, 38, 34, 6, 9, 7),
    text('length-value', 'bazis.detail_length', null, 27, 47, 18, 8, 16, 8),
    text('size-x', null, 'x', 45, 47, 7, 8, 16, 9),
    text('width-value', 'bazis.detail_width', null, 52, 47, 18, 8, 16, 10),
    text('date-value', 'date.today', null, 2, 80, 29, 7, 10, 11),
    text('counter-value', 'label.counter_text', null, 41, 80, 38, 7, 10, 12),
  ];
}
