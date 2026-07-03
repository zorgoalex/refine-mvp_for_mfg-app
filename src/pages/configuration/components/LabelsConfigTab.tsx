import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Collapse, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import { AlignCenterOutlined, AlignLeftOutlined, AlignRightOutlined, CopyOutlined, DeleteOutlined, EditOutlined, ImportOutlined, PlusOutlined, QrcodeOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type Konva from 'konva';
import { Layer, Line as KonvaLine, Rect as KonvaRect, Stage, Text as KonvaText, Transformer } from 'react-konva';
import { labelsApi } from '../../../api/labelsApi';
import { ApiError } from '../../../api/apiError';
import type {
  LabelElementKind,
  LabelExportFormat,
  LabelFieldCatalogItem,
  LabelQrTemplate,
  LabelQrTemplateInput,
  LabelTemplate,
  LabelTemplateElement,
  LabelTemplateInput,
} from '../../../api/types/labelsApi.types';
import { can } from '../../../utils/permissions';
import {
  autoShiftForQr,
  collectQrConflicts,
  extractQrTemplateFieldIds,
  qrErrorCorrectionOf,
  qrProtectedRect,
  qrSideOf,
  qrTemplateOf,
} from './labelQrHelpers';
import { chipsToTemplate, collectDuplicateQrNames, collectEmptyQrNames, qrDraftFromElement, qrElementFromLibrary, sanitizeQrText, templateToChips, type QrChip } from './labelQrLibrary';

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
const QR_CONFLICT_ERROR = 'QR_CONFLICT';
const QR_NAME_DUP_ERROR_PREFIX = 'QR_NAME_DUP:';
const QR_NAME_EMPTY_ERROR_PREFIX = 'QR_NAME_EMPTY:';
const QR_ERROR_CORRECTION_OPTIONS = [
  { value: 'L', label: 'L' },
  { value: 'M', label: 'M' },
  { value: 'Q', label: 'Q' },
  { value: 'H', label: 'H' },
];

interface TemplateFormValues {
  name: string;
  description?: string;
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

interface CustomFieldSchemaRow {
  fieldId: string;
  label: string;
  type: string;
  sourceField: string | null;
}

interface QrDraft {
  id: number | null;
  version: number | null;
  name: string;
  chips: QrChip[];
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  sizeMm: number;
}

const EMPTY_QR_DRAFT: QrDraft = { id: null, version: null, name: '', chips: [], errorCorrection: 'M', sizeMm: 20 };

export const LabelsConfigTab: React.FC = () => {
  const canManage = can('labels.manage_templates');
  const [form] = Form.useForm<TemplateFormValues>();
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [fields, setFields] = useState<LabelFieldCatalogItem[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<LabelTemplate | null>(null);
  const [elements, setElements] = useState<LabelTemplateElement[]>([]);
  const [customSchemaText, setCustomSchemaText] = useState('{}');
  const [importVariants, setImportVariants] = useState<BazisImportVariant[]>([]);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [selectedElementKey, setSelectedElementKey] = useState<string | null>(null);
  const [fieldSearch, setFieldSearch] = useState('');
  const [draggingField, setDraggingField] = useState<LabelFieldCatalogItem | null>(null);
  const [dragCursor, setDragCursor] = useState<{ x: number; y: number } | null>(null);
  const [visualExpanded, setVisualExpanded] = useState(false);
  const [qrConflicts, setQrConflicts] = useState<string[]>([]);
  const [qrTemplates, setQrTemplates] = useState<LabelQrTemplate[]>([]);
  const [qrDraft, setQrDraft] = useState<QrDraft>(EMPTY_QR_DRAFT);
  const [qrTextDraft, setQrTextDraft] = useState('');
  const [qrSaving, setQrSaving] = useState(false);
  const [qrFieldSearch, setQrFieldSearch] = useState('');
  const [draggingQrField, setDraggingQrField] = useState<LabelFieldCatalogItem | null>(null);
  const [draggingQr, setDraggingQr] = useState<LabelQrTemplate | null>(null);
  const [qrDragCursor, setQrDragCursor] = useState<{ x: number; y: number } | null>(null);
  const qrDropZoneRef = useRef<HTMLDivElement | null>(null);
  const previewWidthMm = Form.useWatch('canvasWidthMm', form);
  const previewHeightMm = Form.useWatch('canvasHeightMm', form);

  const load = async () => {
    setLoading(true);
    try {
      const [nextTemplates, nextFields] = await Promise.all([
        labelsApi.listTemplates(true),
        labelsApi.listFields(),
      ]);
      setTemplates(nextTemplates);
      setFields(nextFields);
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
        canvasWidthMm: selectedTemplate.canvasWidthMm,
        canvasHeightMm: selectedTemplate.canvasHeightMm,
        dpi: selectedTemplate.dpi,
        defaultExportFormats: selectedTemplate.defaultExportFormats,
      });
      setElements(selectedTemplate.elements);
      setCustomSchemaText(JSON.stringify(selectedTemplate.customFieldSchema ?? {}, null, 2));
    }
  }, [form, selectedTemplate]);

  const fieldCategories = useMemo(() => new Set(fields.map((field) => field.category)).size, [fields]);
  const customSchemaRows = useMemo(() => parseCustomSchemaRows(customSchemaText), [customSchemaText]);
  const sourceFields = useMemo<LabelFieldCatalogItem[]>(
    () => [
      ...fields,
      ...customSchemaRows.rows.map((row) => ({
        id: row.fieldId,
        source: 'dynamic' as const,
        sourceColumn: null,
        label: row.label || row.fieldId,
        type: (CUSTOM_FIELD_TYPE_OPTIONS.some((option) => option.value === row.type) ? row.type : 'string') as LabelFieldCatalogItem['type'],
        category: 'Кастомные',
      })),
    ],
    [customSchemaRows.rows, fields],
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
        if (element.kind !== 'qr') continue;
        for (const fieldId of extractQrTemplateFieldIds(qrTemplateOf(element))) {
          ids.add(fieldId);
        }
      }
      return ids;
    },
    [elements],
  );

  useEffect(() => {
    setQrConflicts(collectQrConflicts(elements, {
      widthMm: Number(previewWidthMm ?? selectedTemplate?.canvasWidthMm ?? 85),
      heightMm: Number(previewHeightMm ?? selectedTemplate?.canvasHeightMm ?? 88),
    }).map((conflict) => conflict.conflictKey));
  }, [elements, previewHeightMm, previewWidthMm, selectedTemplate]);

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
  // chip if the pointer is released over the chip drop zone (mirrors draggingField above).
  useEffect(() => {
    if (!draggingQrField) return;
    const handleEnd = (event: PointerEvent | MouseEvent) => {
      const rect = qrDropZoneRef.current?.getBoundingClientRect();
      const inside = Boolean(
        rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom,
      );
      if (inside) addQrFieldChip(draggingQrField);
      setDraggingQrField(null);
    };
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('mouseup', handleEnd);
    return () => {
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
    setSelectedTemplate(null);
    setElements([
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
        style: { fontSize: 12 },
        condition: {},
      },
    ]);
    setCustomSchemaText('{}');
    form.setFieldsValue({
      name: '',
      description: '',
      canvasWidthMm: 85,
      canvasHeightMm: 88,
      dpi: 203,
      defaultExportFormats: ['bmp', 'png', 'emf'],
    });
  };

  const buildTemplatePayload = (values: TemplateFormValues, name = values.name): LabelTemplateInput => {
    const customFieldSchema = parseCustomSchema(customSchemaText);
    const conflicts = collectQrConflicts(elements, {
      widthMm: Number(values.canvasWidthMm ?? 85),
      heightMm: Number(values.canvasHeightMm ?? 88),
    });
    if (conflicts.length > 0) {
      throw new Error(QR_CONFLICT_ERROR);
    }
    const dupes = collectDuplicateQrNames(elements);
    if (dupes.length > 0) {
      throw new Error(`${QR_NAME_DUP_ERROR_PREFIX}${dupes.join(', ')}`);
    }
    const emptyNames = collectEmptyQrNames(elements);
    if (emptyNames.length > 0) {
      throw new Error(`${QR_NAME_EMPTY_ERROR_PREFIX}${emptyNames.length}`);
    }
    return {
      name: name.trim(),
      description: values.description?.trim() || null,
      canvasWidthMm: values.canvasWidthMm,
      canvasHeightMm: values.canvasHeightMm,
      dpi: values.dpi,
      defaultExportFormats: values.defaultExportFormats,
      customFieldSchema,
      elements: toTemplateElementInput(elements),
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
    }
    if (error instanceof Error) {
      if (error.message === QR_CONFLICT_ERROR) {
        return 'QR-код пересекается с элементами или выходит за границы бирки';
      }
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
    if (!canManage) return;
    setSaving(true);
    try {
      const payload = buildTemplatePayload(values);
      if (selectedTemplate) {
        await labelsApi.updateTemplate(selectedTemplate.labelTemplateId, { ...payload, version: selectedTemplate.version });
        message.success('Шаблон обновлён');
      } else {
        await labelsApi.createTemplate(payload);
        message.success('Шаблон создан');
      }
      await load();
      startNew();
    } catch (error) {
      message.error(describeSaveError(error, 'Не удалось сохранить шаблон'));
    } finally {
      setSaving(false);
    }
  };

  const openSaveAs = async () => {
    if (!canManage) return;
    const values = await form.validateFields();
    setSaveAsName(`${values.name.trim() || selectedTemplate?.name || 'Шаблон'} — копия`);
    setSaveAsOpen(true);
  };

  const saveTemplateAs = async () => {
    if (!canManage) return;
    const name = saveAsName.trim();
    if (!name) {
      message.error('Введите название копии');
      return;
    }
    setSaving(true);
    try {
      const values = await form.validateFields();
      const created = await labelsApi.createTemplate(buildTemplatePayload(values, name));
      message.success('Копия шаблона создана');
      setSaveAsOpen(false);
      setSaveAsName('');
      await load();
      setSelectedTemplate(created);
      setElements(created.elements);
      setCustomSchemaText(JSON.stringify(created.customFieldSchema ?? {}, null, 2));
    } catch (error) {
      message.error(describeSaveError(error, 'Не удалось создать копию шаблона'));
    } finally {
      setSaving(false);
    }
  };

  const addElement = (kind: LabelElementKind) => {
    const elementKey = `${kind}-${Date.now()}`;
    setElements((current) => {
      const nextElement: LabelTemplateElement = {
        elementKey,
        kind,
        sourceField: kind === 'text' ? 'bazis.name' : null,
        staticText: kind === 'text' ? null : null,
        xMm: kind === 'qr' ? 10 : 2,
        yMm: kind === 'qr' ? 10 : 2 + current.length * 6,
        widthMm: kind === 'line' ? 60 : kind === 'qr' ? 20 : 40,
        heightMm: kind === 'line' ? 0 : kind === 'qr' ? 20 : 6,
        rotationDeg: 0,
        zIndex: current.length,
        style: kind === 'qr'
          ? { qrTemplate: '{bazis.detail_id}', qrErrorCorrection: 'M' }
          : { fontSize: 12 },
        condition: {},
      };
      if (kind !== 'qr') return [...current, nextElement];
      const result = autoShiftForQr({
        qr: nextElement,
        elements: current,
        canvas: currentCanvasBounds(),
      });
      setQrConflicts(result.conflicts.map((conflict) => conflict.conflictKey));
      return result.elements;
    });
    setSelectedElementKey(elementKey);
  };

  const patchElement = (index: number, patch: Partial<LabelTemplateElement>) => {
    setElements((current) => current.map((element, i) => (i === index ? { ...element, ...patch } : element)));
  };

  const currentCanvasBounds = () => ({
    widthMm: Number(form.getFieldValue('canvasWidthMm') ?? selectedTemplate?.canvasWidthMm ?? 85),
    heightMm: Number(form.getFieldValue('canvasHeightMm') ?? selectedTemplate?.canvasHeightMm ?? 88),
  });

  const addCustomField = () => {
    const schema = parseEditableCustomSchema(customSchemaText);
    const fieldId = `custom.field_${Date.now()}`;
    schema[fieldId] = { type: 'string', label: 'Новое поле', sourceField: 'detail.detail_name' };
    setCustomSchemaText(JSON.stringify(schema, null, 2));
  };

  const patchCustomField = (fieldId: string, patch: Partial<CustomFieldSchemaRow>) => {
    const schema = parseEditableCustomSchema(customSchemaText);
    const current = normalizeCustomFieldSchemaEntry(schema[fieldId]);
    const next = { ...current, ...patch };
    if (!next.sourceField) delete next.sourceField;
    schema[fieldId] = next;
    setCustomSchemaText(JSON.stringify(schema, null, 2));
  };

  const deleteCustomField = (fieldId: string) => {
    const schema = parseEditableCustomSchema(customSchemaText);
    delete schema[fieldId];
    setCustomSchemaText(JSON.stringify(schema, null, 2));
  };

  const moveElement = (elementKey: string, xMm: number, yMm: number) => {
    const target = elements.find((element) => element.elementKey === elementKey);
    if (target?.kind === 'qr') {
      applyQrGeometryPatch(elementKey, { xMm: roundMm(xMm), yMm: roundMm(yMm) });
      return;
    }
    setElements((current) =>
      current.map((element) =>
        element.elementKey === elementKey
          ? { ...element, xMm: roundMm(xMm), yMm: roundMm(yMm) }
          : element,
      ),
    );
  };

  const patchElementByKey = (elementKey: string, patch: Partial<LabelTemplateElement>) => {
    const target = elements.find((element) => element.elementKey === elementKey);
    if (target?.kind === 'qr' && (patch.xMm !== undefined || patch.yMm !== undefined || patch.widthMm !== undefined || patch.heightMm !== undefined)) {
      applyQrGeometryPatch(elementKey, patch);
      return;
    }
    setElements((current) =>
      current.map((element) =>
        element.elementKey === elementKey
          ? { ...element, ...patch }
          : element,
      ),
    );
  };

  const applyQrGeometryPatch = (elementKey: string, patch: Partial<LabelTemplateElement>) => {
    setElements((current) => {
      const currentQr = current.find((element) => element.elementKey === elementKey);
      if (!currentQr || currentQr.kind !== 'qr') {
        return current.map((element) => (element.elementKey === elementKey ? { ...element, ...patch } : element));
      }
      const qr = { ...currentQr, ...patch };
      const result = autoShiftForQr({
        qr,
        elements: current,
        canvas: currentCanvasBounds(),
      });
      setQrConflicts(result.conflicts.map((conflict) => conflict.conflictKey));
      return result.elements;
    });
  };

  const patchQrStyle = (index: number, patch: Record<string, unknown>) => {
    setElements((current) => current.map((element, i) => (
      i === index
        ? { ...element, style: { ...(element.style ?? {}), ...patch } }
        : element
    )));
  };

  const changeElementKind = (index: number, kind: LabelElementKind) => {
    const current = elements[index];
    if (!current) return;
    const patch: Partial<LabelTemplateElement> = {
      kind,
      sourceField: kind === 'text' ? current.sourceField ?? 'bazis.name' : null,
      staticText: kind === 'text' ? current.staticText ?? null : null,
      heightMm: kind === 'line' ? 0 : kind === 'qr' ? qrSideOf(current) : Math.max(6, Number(current.heightMm ?? 6)),
      widthMm: kind === 'qr' ? qrSideOf(current) : kind === 'line' ? Math.max(10, Number(current.widthMm ?? 60)) : Number(current.widthMm ?? 40),
      style: kind === 'qr'
        ? { ...(current.style ?? {}), qrTemplate: qrTemplateOf(current) || '{bazis.detail_id}', qrErrorCorrection: qrErrorCorrectionOf(current) }
        : { ...(current.style ?? {}), fontSize: Number(current.style?.fontSize ?? 12) },
    };
    if (kind === 'qr') {
      applyQrGeometryPatch(current.elementKey, patch);
      return;
    }
    patchElement(index, patch);
  };

  const deleteElementByKey = (elementKey: string) => {
    setElements((current) => current.filter((element) => element.elementKey !== elementKey));
    setSelectedElementKey((current) => (current === elementKey ? null : current));
  };

  const duplicateElementByKey = (elementKey: string) => {
    setElements((current) => {
      const source = current.find((element) => element.elementKey === elementKey);
      if (!source) return current;
      const nextKey = `${source.elementKey}-copy-${Date.now()}`;
      const copy: LabelTemplateElement = {
        ...source,
        labelTemplateElementId: undefined,
        elementKey: nextKey,
        xMm: roundMm(Number(source.xMm ?? 0) + 2),
        yMm: roundMm(Number(source.yMm ?? 0) + 2),
        zIndex: Math.max(0, ...current.map((element) => Number(element.zIndex ?? 0))) + 1,
        style: { ...(source.style ?? {}), locked: false },
      };
      setSelectedElementKey(nextKey);
      return [...current, copy];
    });
  };

  const addFieldElement = (field: LabelFieldCatalogItem, xMm: number, yMm: number) => {
    if (!canManage) return;
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
      zIndex: elements.length,
      style: { fontSize: 12 },
      condition: {},
    };
    setElements((current) => [...current, element]);
    setSelectedElementKey(elementKey);
  };

  const onDropDraggingQr = (payload: LabelQrTemplate, xMm: number, yMm: number) => {
    if (!canManage) return;
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
      elements,
    );
    el.elementKey = `qr-${Date.now()}`;
    const result = autoShiftForQr({
      qr: el,
      elements: [...elements, el],
      canvas: currentCanvasBounds(),
    });
    setQrConflicts(result.conflicts.map((conflict) => conflict.conflictKey));
    setElements(result.elements);
    setSelectedElementKey(el.elementKey);
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
    setSelectedTemplate(null);
    setElements(variant.elements);
    setCustomSchemaText('{}');
    form.setFieldsValue({
      name: variant.name,
      description: variant.description,
      canvasWidthMm: 85,
      canvasHeightMm: 88,
      dpi: 203,
      defaultExportFormats: ['bmp', 'png', 'emf'],
    });
  };

  const resetQrDraft = () => setQrDraft(EMPTY_QR_DRAFT);

  const editQrTemplateRow = (template: LabelQrTemplate) => {
    setQrDraft({
      id: template.labelQrTemplateId,
      version: template.version,
      name: template.name,
      chips: templateToChips(template.contentTemplate),
      errorCorrection: template.errorCorrection,
      sizeMm: template.defaultSizeMm,
    });
  };

  const addQrFieldChip = (field: LabelFieldCatalogItem) => {
    setQrDraft((current) => ({ ...current, chips: [...current.chips, { kind: 'field', fieldId: field.id }] }));
  };

  const addQrTextChip = () => {
    const text = sanitizeQrText(qrTextDraft).trim();
    if (!text) return;
    setQrDraft((current) => ({ ...current, chips: [...current.chips, { kind: 'text', text }] }));
    setQrTextDraft('');
  };

  const removeQrChip = (index: number) => {
    setQrDraft((current) => ({ ...current, chips: current.chips.filter((_, i) => i !== index) }));
  };

  const moveQrChip = (index: number, direction: -1 | 1) => {
    setQrDraft((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.chips.length) return current;
      const chips = [...current.chips];
      [chips[index], chips[target]] = [chips[target], chips[index]];
      return { ...current, chips };
    });
  };

  const saveQrTemplate = async (
    override?: { name: string; contentTemplate: string; errorCorrection: 'L' | 'M' | 'Q' | 'H'; defaultSizeMm: number },
  ): Promise<LabelQrTemplate | null> => {
    if (!canManage) return null;
    const name = (override?.name ?? qrDraft.name).trim();
    if (!name) {
      message.error('Введите название QR-шаблона');
      return null;
    }
    setQrSaving(true);
    try {
      const input: LabelQrTemplateInput = {
        name,
        contentTemplate: override?.contentTemplate ?? chipsToTemplate(qrDraft.chips),
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
    if (!canManage) return;
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

  const leftColumnSpan = visualExpanded ? 10 : 14;
  const rightColumnSpan = visualExpanded ? 14 : 10;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
        <Button type="primary" icon={<PlusOutlined />} disabled={!canManage} onClick={startNew}>
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
                    <Button icon={<ImportOutlined />} disabled={!canManage} onClick={() => applyImportVariant(variant)}>
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
            onClick: () => setSelectedTemplate(template),
            style: { cursor: 'pointer' },
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
              render: (active: boolean) => <Tag color={active ? 'green' : 'default'}>{active ? 'Активен' : 'Отключен'}</Tag>,
            },
            {
              title: '',
              width: 48,
              render: () => <Button icon={<EditOutlined />} size="small" disabled={!canManage} />,
            },
          ]}
        />
      </Card>

      <Collapse defaultActiveKey={['current-template-preview']}>
        <Panel header="Просмотр текущего шаблона" key="current-template-preview">
          <LabelTemplatePreview
            widthMm={Number(previewWidthMm ?? selectedTemplate?.canvasWidthMm ?? 85)}
            heightMm={Number(previewHeightMm ?? selectedTemplate?.canvasHeightMm ?? 88)}
            elements={elements}
            fields={sourceFields}
            selectedElementKey={selectedElementKey}
            canDrag={false}
          />
        </Panel>
      </Collapse>

      <Form form={form} layout="vertical" onFinish={saveTemplate} disabled={!canManage || saving}>
        <Row gutter={16} align="top">
          <Col xs={24} lg={leftColumnSpan}>
            <Card size="small" title={selectedTemplate ? 'Редактирование шаблона' : 'Новый шаблон'} style={{ marginBottom: 16 }}>
              <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }]}>
                <Input />
              </Form.Item>
              <div style={{ marginBottom: 16 }}>
                <Text strong>Поля бирки</Text>
                <div style={{ marginTop: 8 }}>
                  <FieldPalette
                    fields={sourceFields}
                    usedFieldIds={usedFieldIds}
                    disabled={!canManage}
                    search={fieldSearch}
                    onSearch={setFieldSearch}
                    onBeginDrag={setDraggingField}
                  />
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <Text strong>Пользовательские поля</Text>
                <div style={{ marginTop: 8 }}>
                  <Form.Item label="Пользовательские поля JSON">
                    <Input.TextArea value={customSchemaText} onChange={(event) => setCustomSchemaText(event.target.value)} autoSize={{ minRows: 3, maxRows: 6 }} />
                  </Form.Item>
                  <Table
                    rowKey="fieldId"
                    size="small"
                    pagination={false}
                    dataSource={customSchemaRows.rows}
                    title={() => (
                      <Space wrap>
                        <Text strong>Кастомные поля</Text>
                        <Button size="small" icon={<PlusOutlined />} disabled={!canManage || !customSchemaRows.valid} onClick={addCustomField}>
                          Поле
                        </Button>
                        {!customSchemaRows.valid && <Text type="danger">JSON некорректен</Text>}
                      </Space>
                    )}
                    columns={[
                      { title: 'Ключ', dataIndex: 'fieldId', width: 170 },
                      {
                        title: 'Название',
                        width: 170,
                        render: (_, row) => (
                          <Input
                            value={row.label}
                            disabled={!canManage}
                            onChange={(event) => patchCustomField(row.fieldId, { label: event.target.value })}
                          />
                        ),
                      },
                      {
                        title: 'Тип',
                        width: 110,
                        render: (_, row) => (
                          <Select
                            value={row.type}
                            disabled={!canManage}
                            style={{ width: '100%' }}
                            options={CUSTOM_FIELD_TYPE_OPTIONS}
                            onChange={(type) => patchCustomField(row.fieldId, { type })}
                          />
                        ),
                      },
                      {
                        title: 'Источник',
                        width: 220,
                        render: (_, row) => (
                          <Select
                            showSearch
                            allowClear
                            value={row.sourceField ?? undefined}
                            disabled={!canManage}
                            style={{ width: '100%' }}
                            options={fields.map((field) => ({ value: field.id, label: `${field.category}: ${field.label}` }))}
                            onChange={(sourceField) => patchCustomField(row.fieldId, { sourceField: sourceField ?? null })}
                          />
                        ),
                      },
                      {
                        title: '',
                        width: 48,
                        render: (_, row) => (
                          <Button danger size="small" icon={<DeleteOutlined />} disabled={!canManage} onClick={() => deleteCustomField(row.fieldId)} />
                        ),
                      },
                    ]}
                  />
                </div>
              </div>
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
                                      draggable={canManage}
                                      style={{ cursor: canManage ? 'grab' : 'default', fontSize: 16, userSelect: 'none' }}
                                      onDragStart={(event) => {
                                        if (!canManage) return;
                                        setDraggingQr(template);
                                        event.dataTransfer.setData('application/x-label-qr-template', String(template.labelQrTemplateId));
                                        event.dataTransfer.effectAllowed = 'copy';
                                      }}
                                      onDragEnd={() => setDraggingQr(null)}
                                      onMouseDown={(event) => {
                                        if (!canManage) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                      onMouseDownCapture={(event) => {
                                        if (!canManage) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                      onPointerDown={(event) => {
                                        if (!canManage) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                      onPointerDownCapture={(event) => {
                                        if (!canManage) return;
                                        event.preventDefault();
                                        setDraggingQr(template);
                                      }}
                                    />
                                    <Button size="small" icon={<EditOutlined />} disabled={!canManage} onClick={() => editQrTemplateRow(template)} />
                                    <Button size="small" danger icon={<DeleteOutlined />} disabled={!canManage} onClick={() => void deleteQrTemplateRow(template)} />
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
                                <Text type="secondary">Содержимое QR (перетащите поля из палитры ниже)</Text>
                                <div
                                  ref={qrDropZoneRef}
                                  data-qr-chip-dropzone
                                  style={{
                                    minHeight: 40,
                                    marginTop: 4,
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
                                    const fieldId = event.dataTransfer.getData('application/x-label-field') || event.dataTransfer.getData('text/plain');
                                    const field = qrPaletteFields.find((item) => item.id === fieldId);
                                    if (field) addQrFieldChip(field);
                                  }}
                                >
                                  {qrDraft.chips.length === 0 && (
                                    <Text type="secondary">Нет полей — перетащите поле или добавьте текст</Text>
                                  )}
                                  {qrDraft.chips.map((chip, index) => (
                                    <Tag key={`${chip.kind}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                      <span>
                                        {chip.kind === 'field'
                                          ? (qrPaletteFields.find((field) => field.id === chip.fieldId)?.label ?? chip.fieldId)
                                          : chip.text}
                                      </span>
                                      {canManage && (
                                        <>
                                          <Button
                                            type="text"
                                            size="small"
                                            style={{ padding: '0 2px' }}
                                            disabled={index === 0}
                                            onClick={() => moveQrChip(index, -1)}
                                          >
                                            ←
                                          </Button>
                                          <Button
                                            type="text"
                                            size="small"
                                            style={{ padding: '0 2px' }}
                                            disabled={index === qrDraft.chips.length - 1}
                                            onClick={() => moveQrChip(index, 1)}
                                          >
                                            →
                                          </Button>
                                          <Button
                                            type="text"
                                            size="small"
                                            style={{ padding: '0 2px' }}
                                            onClick={() => removeQrChip(index)}
                                          >
                                            ✕
                                          </Button>
                                        </>
                                      )}
                                    </Tag>
                                  ))}
                                </div>
                              </div>
                              <Space.Compact style={{ width: '100%' }}>
                                <Input
                                  placeholder="Статический текст"
                                  value={qrTextDraft}
                                  disabled={!canManage}
                                  onChange={(event) => setQrTextDraft(sanitizeQrText(event.target.value))}
                                  onPressEnter={addQrTextChip}
                                />
                                <Button disabled={!canManage} onClick={addQrTextChip}>Добавить текст</Button>
                              </Space.Compact>
                              <div>
                                <Text type="secondary">Поля для перетаскивания</Text>
                                <div style={{ marginTop: 4 }}>
                                  <FieldPalette
                                    fields={qrPaletteFields}
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
              <Space wrap>
                <Button htmlType="submit" type="primary" icon={<SaveOutlined />} loading={saving} disabled={!canManage}>
                  Сохранить шаблон
                </Button>
                <Button icon={<CopyOutlined />} loading={saving} disabled={!canManage || !selectedTemplate || elements.length === 0} onClick={() => void openSaveAs()}>
                  Сохранить как
                </Button>
              </Space>
            </Card>
            <Table
            rowKey="elementKey"
            title={() => (
              <Space wrap>
                <Text strong>Элементы</Text>
                <Tooltip title="Добавляет текстовый элемент. Можно привязать к полю заказа, детали, Базиса или кастомному полю, затем перетащить на визуале.">
                  <Button disabled={!canManage} onClick={() => addElement('text')}>Текст</Button>
                </Tooltip>
                <Tooltip title="Добавляет линию. Используйте для разделителей, подчеркиваний и простых графических границ внутри бирки.">
                  <Button disabled={!canManage} onClick={() => addElement('line')}>Линия</Button>
                </Tooltip>
                <Tooltip title="Добавляет прямоугольник. Используйте для рамок, блоков и визуального выделения областей бирки.">
                  <Button disabled={!canManage} onClick={() => addElement('rect')}>Прямоугольник</Button>
                </Tooltip>
                <Tooltip title="Добавляет QR-код. Данные собираются по шаблону из полей детали, заказа, Bazis и кастомных полей.">
                  <Button icon={<QrcodeOutlined />} disabled={!canManage} onClick={() => addElement('qr')}>QR-код</Button>
                </Tooltip>
              </Space>
            )}
            size="small"
            pagination={false}
            dataSource={elements}
            scroll={{ y: 360, x: 720 }}
            rowClassName={(element) => (selectedElementKey === element.elementKey ? 'ant-table-row-selected' : '')}
            onRow={(element) => ({
              onClick: () => setSelectedElementKey(element.elementKey),
              style: { cursor: 'pointer' },
            })}
            columns={[
              {
                title: 'Тип',
                width: 120,
                render: (_, element, index) => (
                  <Select
                    value={element.kind}
                    disabled={!canManage}
                    style={{ width: '100%' }}
                    onChange={(kind) => changeElementKind(index, kind)}
                    options={[
                      { value: 'text', label: 'Текст' },
                      { value: 'line', label: 'Линия' },
                      { value: 'rect', label: 'Прямоугольник' },
                      { value: 'qr', label: 'QR-код' },
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
                    disabled={!canManage || element.kind !== 'text'}
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
                    disabled={!canManage || element.kind !== 'text'}
                    onChange={(event) => patchElement(index, { staticText: event.target.value || null })}
                  />
                ),
              },
              {
                title: 'Имя QR',
                width: 140,
                render: (_, element, index) => (
                  <Input
                    value={String((element.style as Record<string, unknown> | undefined)?.qrName ?? '')}
                    disabled={!canManage || element.kind !== 'qr'}
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
                      disabled={!canManage || element.kind !== 'qr'}
                      onChange={(event) => patchQrStyle(index, { qrTemplate: event.target.value })}
                    />
                    <Select
                      value={qrErrorCorrectionOf(element)}
                      disabled={!canManage || element.kind !== 'qr'}
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
                        disabled={!canManage}
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
                title: key,
                width: 95,
                render: (_: unknown, element: LabelTemplateElement, index: number) => (
                  <InputNumber
                    value={element[key]}
                    min={0}
                    disabled={!canManage}
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
              extra={<Checkbox checked={visualExpanded} onChange={(event) => setVisualExpanded(event.target.checked)}>Увеличить визуал</Checkbox>}
              style={{ marginBottom: 16 }}
            >
              <LabelTemplatePreview
                widthMm={Number(previewWidthMm ?? selectedTemplate?.canvasWidthMm ?? 85)}
                heightMm={Number(previewHeightMm ?? selectedTemplate?.canvasHeightMm ?? 88)}
                elements={elements}
                fields={sourceFields}
                selectedElementKey={selectedElementKey}
                canDrag={canManage}
                initialZoom={visualExpanded ? 1.3 : 0.6}
                onSelectElement={setSelectedElementKey}
                onMoveElement={moveElement}
                onChangeElement={patchElementByKey}
                onDeleteElement={deleteElementByKey}
                onDuplicateElement={duplicateElementByKey}
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
              {qrConflicts.length > 0 && (
                <Alert
                  data-label-qr-conflict
                  type="warning"
                  showIcon
                  style={{ marginTop: 8 }}
                  message="QR-код пересекается с элементами или выходит за границы бирки"
                />
              )}
            </Card>
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

function LabelTemplatePreview({
  widthMm,
  heightMm,
  elements,
  fields,
  selectedElementKey,
  canDrag,
  onSelectElement,
  onMoveElement,
  onChangeElement,
  onDeleteElement,
  onDuplicateElement,
  onDropField,
  draggingField,
  onDropDraggingField,
  draggingQr,
  onDropDraggingQr,
  initialZoom = 1,
}: {
  widthMm: number;
  heightMm: number;
  elements: LabelTemplateElement[];
  fields: LabelFieldCatalogItem[];
  selectedElementKey?: string | null;
  canDrag?: boolean;
  onSelectElement?: (elementKey: string) => void;
  onMoveElement?: (elementKey: string, xMm: number, yMm: number) => void;
  onChangeElement?: (elementKey: string, patch: Partial<LabelTemplateElement>) => void;
  onDeleteElement?: (elementKey: string) => void;
  onDuplicateElement?: (elementKey: string) => void;
  onDropField?: (field: LabelFieldCatalogItem, xMm: number, yMm: number) => void;
  draggingField?: LabelFieldCatalogItem | null;
  onDropDraggingField?: (field: LabelFieldCatalogItem, xMm: number, yMm: number) => void;
  draggingQr?: LabelQrTemplate | null;
  onDropDraggingQr?: (payload: LabelQrTemplate, xMm: number, yMm: number) => void;
  initialZoom?: number;
}) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  const [zoom, setZoom] = useState(initialZoom);
  const [showGrid, setShowGrid] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [hoveredElement, setHoveredElement] = useState<{ element: LabelTemplateElement; x: number; y: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ field: LabelFieldCatalogItem; xMm: number; yMm: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ element: LabelTemplateElement; x: number; y: number } | null>(null);
  const safeWidth = Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 85;
  const safeHeight = Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 88;
  // True while an external drag (field or QR icon) is in flight over the canvas; used to
  // suspend normal element selection/dragging/context-menu so the drop target doesn't fight
  // with in-canvas interactions.
  const externalDragActive = Boolean(draggingField || draggingQr);
  const fieldLabels = useMemo(() => new Map(fields.map((field) => [field.id, field.label])), [fields]);
  const fieldInfo = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const sorted = elements.slice().sort((a, b) => Number(a.zIndex ?? 0) - Number(b.zIndex ?? 0));
  const previewWidth = Math.round(Math.min(760, Math.max(360, safeWidth * 7)) * zoom);
  const previewHeight = previewWidth * (safeHeight / safeWidth);
  const selectedElement = elements.find((element) => element.elementKey === selectedElementKey);
  const selectedElementLocked = Boolean(selectedElement && isLabelElementLocked(selectedElement));
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
    if (!canDrag || !selectedElementKey || selectedElementLocked || externalDragActive) {
      transformerRef.current?.nodes([]);
      transformerRef.current?.getLayer()?.batchDraw();
      return;
    }
    const node = nodeRefs.current.get(selectedElementKey);
    transformerRef.current?.nodes(node ? [node] : []);
    transformerRef.current?.getLayer()?.batchDraw();
  }, [canDrag, externalDragActive, elements, selectedElementKey, selectedElementLocked]);

  useEffect(() => {
    if (!draggingField || !onDropDraggingField) return;
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
  }, [draggingField, onDropDraggingField, previewHeight, previewWidth, safeHeight, safeWidth]);

  // Mirrors the draggingField global-drop effect above: a capture-phase window listener
  // resolves the drop (if released over the canvas container) before the outer component's
  // bubble-phase listener clears draggingQr.
  useEffect(() => {
    if (!draggingQr || !onDropDraggingQr) return;
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
      if (!inside) return;
      dropped = true;
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
  }, [draggingQr, onDropDraggingQr, previewHeight, previewWidth, safeHeight, safeWidth]);

  const applySnap = (value: number, event?: { altKey?: boolean }) => (
    snapToGrid && !event?.altKey ? Math.round(value) : value
  );

  const patchGeometry = (
    elementKey: string,
    patch: Partial<LabelTemplateElement>,
    event?: { altKey?: boolean },
  ) => {
    const next: Partial<LabelTemplateElement> = {};
    if (patch.xMm !== undefined) next.xMm = roundMm(applySnap(Number(patch.xMm), event));
    if (patch.yMm !== undefined) next.yMm = roundMm(applySnap(Number(patch.yMm), event));
    if (patch.widthMm !== undefined) next.widthMm = roundMm(Math.max(0.1, applySnap(Number(patch.widthMm), event)));
    if (patch.heightMm !== undefined) next.heightMm = roundMm(Math.max(0, applySnap(Number(patch.heightMm), event)));
    if (patch.rotationDeg !== undefined) next.rotationDeg = roundMm(Number(patch.rotationDeg));
    onChangeElement?.(elementKey, next);
  };

  const handleMoveElement = (elementKey: string, xMm: number, yMm: number, event?: { altKey?: boolean }) => {
    const element = elements.find((item) => item.elementKey === elementKey);
    if (!element || isLabelElementLocked(element)) return;
    const maxX = Math.max(0, safeWidth - Number(element.widthMm ?? 0));
    const maxY = Math.max(0, safeHeight - Number(element.heightMm ?? 0));
    const nextX = clamp(applySnap(xMm, event), 0, maxX);
    const nextY = clamp(applySnap(yMm, event), 0, maxY);
    onMoveElement?.(elementKey, nextX, nextY);
  };

  const handleTransformEnd = (
    element: LabelTemplateElement,
    node: Konva.Node,
    event: Konva.KonvaEventObject<Event>,
  ) => {
    if (isLabelElementLocked(element)) return;
    const rotationStep = (event.evt as MouseEvent | KeyboardEvent | PointerEvent | undefined)?.shiftKey ? 15 : 1;
    const nextRotation = Math.round(Number(node.rotation() ?? 0) / rotationStep) * rotationStep;
    const nextSize = normalizeTransformedNode(element, node);
    patchGeometry(
      element.elementKey,
      {
        xMm: clamp(node.x(), 0, safeWidth),
        yMm: clamp(node.y(), 0, safeHeight),
        widthMm: nextSize.widthMm,
        heightMm: nextSize.heightMm,
        rotationDeg: nextRotation,
      },
      event.evt as MouseEvent | PointerEvent,
    );
  };

  const handleTransform = (
    element: LabelTemplateElement,
    node: Konva.Node,
    event: Konva.KonvaEventObject<Event>,
  ) => {
    if (element.kind === 'line' || isLabelElementLocked(element)) return;
    const nextSize = normalizeTransformedNode(element, node);
    patchGeometry(
      element.elementKey,
      {
        xMm: clamp(node.x(), 0, safeWidth),
        yMm: clamp(node.y(), 0, safeHeight),
        widthMm: nextSize.widthMm,
        heightMm: nextSize.heightMm,
        rotationDeg: Number(node.rotation() ?? 0),
      },
      event.evt as MouseEvent | PointerEvent,
    );
  };

  const toggleElementLock = (element: LabelTemplateElement, locked: boolean) => {
    onChangeElement?.(element.elementKey, {
      style: {
        ...(element.style ?? {}),
        locked,
      },
    });
    setContextMenu(null);
  };

  const setElementTextAlign = (element: LabelTemplateElement, textAlign: LabelTextAlign) => {
    if (element.kind !== 'text' || isLabelElementLocked(element)) return;
    const style = { ...(element.style ?? {}) };
    if (textAlign === 'center') {
      delete style.textAlign;
    } else {
      style.textAlign = textAlign;
    }
    onChangeElement?.(element.elementKey, { style });
    setContextMenu(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canDrag || !selectedElement) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && !isLabelElementLocked(selectedElement)) {
      event.preventDefault();
      onDeleteElement?.(selectedElement.elementKey);
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
    if (!offset) return;
    event.preventDefault();
    handleMoveElement(
      selectedElement.elementKey,
      Number(selectedElement.xMm ?? 0) + offset[0],
      Number(selectedElement.yMm ?? 0) + offset[1],
      event,
    );
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
    onSelectElement?.(element.elementKey);
    setContextMenu({
      element,
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
          <Tooltip title="Привязывает перемещение и изменение размера к шагу 1 мм. Удерживайте клавишу свободного перемещения во время перетаскивания или изменения размера, чтобы временно отключить привязку.">
            <Space size={6}>
              <Text type="secondary">Привязка</Text>
              <Switch size="small" checked={snapToGrid} onChange={setSnapToGrid} />
            </Space>
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
        data-label-dragging-field={draggingField?.id}
        data-label-dragging-qr={draggingQr?.labelQrTemplateId}
        tabIndex={canDrag ? 0 : undefined}
        style={{
          width: '100%',
          maxWidth: previewWidth,
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
                selected: !externalDragActive && selectedElementKey === element.elementKey,
                interactive: Boolean(canDrag && !externalDragActive),
                draggable: Boolean(canDrag && !externalDragActive && !isLabelElementLocked(element)),
                safeWidth,
                safeHeight,
                onSelectElement: externalDragActive ? undefined : onSelectElement,
                onMoveElement: handleMoveElement,
                nodeRef: (node) => {
                  if (node) nodeRefs.current.set(element.elementKey, node);
                  else nodeRefs.current.delete(element.elementKey);
                },
                onTransform: (node, event) => handleTransform(element, node, event),
                onTransformEnd: (node, event) => handleTransformEnd(element, node, event),
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
                  onSelectElement?.(menuElement.elementKey);
                  setContextMenu({
                    element: menuElement,
                    x: pointer?.x ?? 0,
                    y: pointer?.y ?? 0,
                  });
                },
              }),
            )}
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
                enabledAnchors={selectedElement?.kind === 'line' ? ['middle-left', 'middle-right'] : undefined}
                boundBoxFunc={(oldBox, newBox) => (
                  newBox.width < 2 || newBox.height < 2 ? oldBox : newBox
                )}
              />
            )}
          </Layer>
        </Stage>
        {contextMenu && (
          <div
            data-label-context-menu
            style={{
              position: 'absolute',
              left: Math.min(contextMenu.x + 6, Math.max(8, previewWidth - 190)),
              top: Math.min(contextMenu.y + 6, Math.max(8, previewHeight - 230)),
              zIndex: 3,
              minWidth: 180,
              padding: 4,
              background: '#fff',
              border: '1px solid #d9d9d9',
              borderRadius: 4,
              boxShadow: '0 6px 16px rgba(0, 0, 0, 0.16)',
            }}
            onMouseLeave={() => setContextMenu(null)}
          >
            {contextMenu.element.kind === 'text' && (
              <div style={{ padding: '4px 4px 6px' }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                  Выравнивание значения
                </Text>
                <Space.Compact block>
                  <Tooltip title="Выровнять значение по левой стороне поля">
                    <Button
                      size="small"
                      icon={<AlignLeftOutlined />}
                      type={getLabelTextAlign(contextMenu.element) === 'left' ? 'primary' : 'default'}
                      disabled={isLabelElementLocked(contextMenu.element)}
                      onClick={() => setElementTextAlign(contextMenu.element, 'left')}
                    />
                  </Tooltip>
                  <Tooltip title="Выровнять значение по центру поля">
                    <Button
                      size="small"
                      icon={<AlignCenterOutlined />}
                      type={getLabelTextAlign(contextMenu.element) === 'center' ? 'primary' : 'default'}
                      disabled={isLabelElementLocked(contextMenu.element)}
                      onClick={() => setElementTextAlign(contextMenu.element, 'center')}
                    />
                  </Tooltip>
                  <Tooltip title="Выровнять значение по правой стороне поля">
                    <Button
                      size="small"
                      icon={<AlignRightOutlined />}
                      type={getLabelTextAlign(contextMenu.element) === 'right' ? 'primary' : 'default'}
                      disabled={isLabelElementLocked(contextMenu.element)}
                      onClick={() => setElementTextAlign(contextMenu.element, 'right')}
                    />
                  </Tooltip>
                </Space.Compact>
              </div>
            )}
            <Button
              type="text"
              size="small"
              block
              onClick={() => toggleElementLock(contextMenu.element, !isLabelElementLocked(contextMenu.element))}
            >
              {isLabelElementLocked(contextMenu.element) ? 'Разблокировать' : 'Заблокировать'}
            </Button>
            <Button
              type="text"
              size="small"
              block
              onClick={() => {
                onDuplicateElement?.(contextMenu.element.elementKey);
                setContextMenu(null);
              }}
            >
              Сделать копию
            </Button>
            <Button
              danger
              type="text"
              size="small"
              block
              onClick={() => {
                onDeleteElement?.(contextMenu.element.elementKey);
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
    </Space>
  );
}

function FieldPalette({
  fields,
  usedFieldIds,
  disabled,
  search,
  onSearch,
  onBeginDrag,
}: {
  fields: LabelFieldCatalogItem[];
  usedFieldIds?: Set<string>;
  disabled?: boolean;
  search: string;
  onSearch: (value: string) => void;
  onBeginDrag?: (field: LabelFieldCatalogItem) => void;
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
      <div style={{ maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {grouped.map(([category, categoryFields]) => (
            <div key={category}>
              <Text type="secondary">{category}</Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {categoryFields.map((field) => {
                  const used = usedFieldIds?.has(field.id) ?? false;
                  return (
                    <Tag
                      key={field.id}
                      color={used ? 'processing' : undefined}
                      draggable={!disabled}
                      onDragStart={(event) => {
                        if (!disabled) onBeginDrag?.(field);
                        event.dataTransfer.setData('application/x-label-field', field.id);
                        event.dataTransfer.setData('text/plain', field.id);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      onMouseDown={(event) => {
                        if (disabled) return;
                        event.preventDefault();
                        onBeginDrag?.(field);
                      }}
                      onMouseDownCapture={(event) => {
                        if (disabled) return;
                        event.preventDefault();
                        onBeginDrag?.(field);
                      }}
                      onPointerDown={(event) => {
                        if (disabled) return;
                        event.preventDefault();
                        onBeginDrag?.(field);
                      }}
                      onPointerDownCapture={(event) => {
                        if (disabled) return;
                        event.preventDefault();
                        onBeginDrag?.(field);
                      }}
                      style={{
                        cursor: disabled ? 'default' : 'grab',
                        userSelect: 'none',
                        fontWeight: used ? 600 : 400,
                      }}
                    >
                      <span
                        onMouseDown={(event) => {
                          if (disabled) return;
                          event.preventDefault();
                          onBeginDrag?.(field);
                        }}
                        onPointerDown={(event) => {
                          if (disabled) return;
                          event.preventDefault();
                          onBeginDrag?.(field);
                        }}
                        style={{ display: 'inline-block' }}
                      >
                        {field.label}
                      </span>
                    </Tag>
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

function groupFieldsByCategory(fields: LabelFieldCatalogItem[]): Array<[string, LabelFieldCatalogItem[]]> {
  const grouped = new Map<string, LabelFieldCatalogItem[]>();
  for (const field of fields) {
    grouped.set(field.category, [...(grouped.get(field.category) ?? []), field]);
  }
  return Array.from(grouped.entries()).sort(([a], [b]) => {
    const order = ['Кастомные', 'Деталь', 'Заказ', 'Динамические'];
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.localeCompare(b, 'ru');
  });
}

function renderKonvaPreviewElement({
  element,
  fieldLabels,
  selected,
  interactive,
  draggable,
  safeWidth,
  safeHeight,
  onSelectElement,
  onMoveElement,
  nodeRef,
  onTransform,
  onTransformEnd,
  onHoverElement,
  onLeaveElement,
  onContextMenu,
}: {
  element: LabelTemplateElement;
  fieldLabels: Map<string, string>;
  selected: boolean;
  interactive: boolean;
  draggable: boolean;
  safeWidth: number;
  safeHeight: number;
  onSelectElement?: (elementKey: string) => void;
  onMoveElement?: (elementKey: string, xMm: number, yMm: number, event?: { altKey?: boolean }) => void;
  nodeRef?: (node: Konva.Node | null) => void;
  onTransform?: (node: Konva.Node, event: Konva.KonvaEventObject<Event>) => void;
  onTransformEnd?: (node: Konva.Node, event: Konva.KonvaEventObject<Event>) => void;
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
  const select = () => onSelectElement?.(key);
  const dragEnd = (event: Konva.KonvaEventObject<DragEvent>) => {
    if (!onMoveElement) return;
    onMoveElement(key, clamp(event.target.x(), 0, maxX), clamp(event.target.y(), 0, maxY), event.evt);
  };
  const common = {
    ref: nodeRef,
    x,
    y,
    rotation,
    listening: interactive,
    draggable,
    onClick: select,
    onTap: select,
    onMouseDown: (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 2) return;
      event.evt.preventDefault();
      onContextMenu?.(element, event);
    },
    onDragStart: select,
    onDragEnd: dragEnd,
    onTransform: (event: Konva.KonvaEventObject<Event>) => onTransform?.(event.target, event),
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => onTransformEnd?.(event.target, event),
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
      stroke="#1677ff"
      strokeWidth={0.35}
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
        <KonvaRect
          {...common}
          width={side}
          height={side}
          fill="white"
          stroke="black"
          strokeWidth={0.35}
        />
        {modules.map(([col, row], index) => (
          <KonvaRect
            key={`${key}-module-${index}`}
            x={x + col * moduleSide}
            y={y + row * moduleSide}
            width={moduleSide}
            height={moduleSide}
            fill="black"
            listening={false}
          />
        ))}
        <KonvaText
          x={x}
          y={y + side / 2 - 2}
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
        {selectionBox}
      </React.Fragment>
    );
  }

  const fontSize = Math.max(1.8, Number(element.style?.fontSize ?? 10) * 0.35);
  const textAlign = getLabelTextAlign(element);
  const text = element.sourceField
    ? PREVIEW_FIELD_VALUES[element.sourceField] ?? fieldLabels.get(element.sourceField) ?? element.sourceField
    : element.staticText ?? '';
  return (
    <React.Fragment key={key}>
      <KonvaText
        {...common}
        width={Math.max(w, 1)}
        height={Math.max(h, fontSize + 1)}
        text={text}
        fontFamily="Arial"
        fontSize={fontSize}
        fontStyle={String(element.style?.fontWeight ?? 'normal') === 'bold' ? 'bold' : 'normal'}
        fill="black"
        align={textAlign}
        wrap="none"
        ellipsis={false}
      />
      {selectionBox}
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

function normalizeTransformedNode(
  element: LabelTemplateElement,
  node: Konva.Node,
): { widthMm: number; heightMm: number } {
  const scaleX = node.scaleX();
  const scaleY = node.scaleY();
  if (element.kind === 'line') {
    node.scaleX(1);
    node.scaleY(1);
    return {
      widthMm: Number(element.widthMm ?? 0) * scaleX,
      heightMm: Number(element.heightMm ?? 0) * scaleY,
    };
  }

  const sizedNode = node as Konva.Node & {
    width: (value?: number) => number;
    height: (value?: number) => number;
  };
  const widthMm = Math.max(0.1, Number(sizedNode.width()) * scaleX);
  const heightMm = Math.max(0.1, Number(sizedNode.height()) * scaleY);
  sizedNode.scaleX(1);
  sizedNode.scaleY(1);
  sizedNode.width(widthMm);
  sizedNode.height(heightMm);
  return { widthMm, heightMm };
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

function parseCustomSchemaRows(value: string): { valid: boolean; rows: CustomFieldSchemaRow[] } {
  try {
    const schema = parseCustomSchema(value);
    return {
      valid: true,
      rows: Object.entries(schema).map(([fieldId, entry]) => ({
        fieldId,
        ...normalizeCustomFieldSchemaEntry(entry),
      })),
    };
  } catch {
    return { valid: false, rows: [] };
  }
}

function parseEditableCustomSchema(value: string): Record<string, unknown> {
  try {
    return parseCustomSchema(value);
  } catch {
    message.error('Сначала исправьте JSON пользовательских полей');
    return {};
  }
}

function normalizeCustomFieldSchemaEntry(entry: unknown): Omit<CustomFieldSchemaRow, 'fieldId'> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { label: '', type: 'string', sourceField: null };
  }
  const value = entry as Record<string, unknown>;
  return {
    label: typeof value.label === 'string' ? value.label : '',
    type: typeof value.type === 'string' ? value.type : 'string',
    sourceField: typeof value.sourceField === 'string' && value.sourceField ? value.sourceField : null,
  };
}

function parseCustomSchema(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('custom schema must be object');
  }
  return parsed as Record<string, unknown>;
}
