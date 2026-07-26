import { ApiError } from '../../../common/errors/api-error';
import { assertRenderableCustomFieldSchema } from '../../labels/application/label-custom-field-expression';
import { LABEL_FIELD_CATALOG, type LabelFieldCatalogItem } from '../../labels/application/bazis-field-catalog';

export type CutPdfTemplateElementType =
  | 'text'
  | 'field'
  | 'custom'
  | 'qr'
  | 'line'
  | 'rect'
  | 'sheet_thumbnail'
  | 'detail_table';

export interface CutPdfFieldCatalogItem {
  id: string;
  source: LabelFieldCatalogItem['source'] | 'job' | 'group' | 'sheet' | 'cut' | 'custom';
  sourceColumn: string | null;
  label: string;
  type: LabelFieldCatalogItem['type'];
  category: string;
}

const ELEMENT_TYPES = new Set<CutPdfTemplateElementType>([
  'text',
  'field',
  'custom',
  'qr',
  'line',
  'rect',
  'sheet_thumbnail',
  'detail_table',
]);

const TEXT_ALIGN = new Set(['left', 'center', 'right']);
const TABLE_SORT_DIRECTIONS = new Set(['asc', 'desc']);

export function cutPdfFieldCatalog(): CutPdfFieldCatalogItem[] {
  return [
    ...CUT_SPECIFIC_FIELD_CATALOG,
    ...LABEL_FIELD_CATALOG.map((field) => ({ ...field })),
  ];
}

export function validateCutPdfTemplateLayout(layout: Record<string, unknown>): Record<string, unknown> {
  const version = Number(layout.version ?? 1);
  if (!Number.isFinite(version) || version < 3) return layout;
  if (!isRecord(layout.page)) throw invalidLayout('page');
  boundedNumber(layout.page.width, 'page.width', 20, 2000);
  boundedNumber(layout.page.height, 'page.height', 20, 2000);

  const customFieldSchema = isRecord(layout.customFieldSchema) ? layout.customFieldSchema : {};
  assertRenderableCustomFieldSchema(customFieldSchema);

  if (!Array.isArray(layout.elements)) throw invalidLayout('elements');
  if (layout.elements.length > 300) throw invalidLayout('elements', { max: 300 });
  for (const [index, rawElement] of layout.elements.entries()) {
    validateElement(rawElement, index, customFieldSchema);
  }
  return layout;
}

function validateElement(rawElement: unknown, index: number, customFieldSchema: Record<string, unknown>): void {
  if (!isRecord(rawElement)) throw invalidLayout(`elements.${index}`);
  if (!ELEMENT_TYPES.has(rawElement.type as CutPdfTemplateElementType)) {
    throw invalidLayout(`elements.${index}.type`, { type: rawElement.type });
  }
  boundedNumber(rawElement.x, `elements.${index}.x`, -2000, 2000);
  boundedNumber(rawElement.y, `elements.${index}.y`, -2000, 2000);
  boundedNumber(rawElement.w, `elements.${index}.w`, 0, 2000);
  boundedNumber(rawElement.h, `elements.${index}.h`, 0, 2000);
  if (rawElement.rotation !== undefined) boundedNumber(rawElement.rotation, `elements.${index}.rotation`, -3600, 3600);
  if (rawElement.zIndex !== undefined) boundedNumber(rawElement.zIndex, `elements.${index}.zIndex`, -10_000, 10_000);
  if (rawElement.align !== undefined && !TEXT_ALIGN.has(String(rawElement.align))) {
    throw invalidLayout(`elements.${index}.align`);
  }
  if (rawElement.source !== undefined && rawElement.source !== null) {
    const source = String(rawElement.source);
    if (!isSupportedPdfField(source, customFieldSchema)) throw invalidLayout(`elements.${index}.source`, { source });
  }
  const style = isRecord(rawElement.style) ? rawElement.style : {};
  validateStyle(style, index, customFieldSchema);
}

function validateStyle(style: Record<string, unknown>, index: number, customFieldSchema: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(style)) {
    if (['table', 'sort', 'columns', 'typography', 'qr', 'textWrap', 'fit', 'locked'].includes(key) || !isRecord(value)) continue;
    if (Object.prototype.hasOwnProperty.call(value, 'version')) {
      throw invalidLayout(`elements.${index}.style.${key}`, { reason: 'unknown versioned namespace' });
    }
  }

  const columns = style.columns;
  if (columns !== undefined) validateTableColumns(columns, index, customFieldSchema);
  const table = style.table;
  if (isRecord(table)) {
    if (table.columns !== undefined) validateTableColumns(table.columns, index, customFieldSchema);
    validateTableSort(table.sort, index, customFieldSchema);
  }
  validateTableSort(style.sort, index, customFieldSchema);
}

function validateTableColumns(rawColumns: unknown, index: number, customFieldSchema: Record<string, unknown>): void {
  if (!Array.isArray(rawColumns) || rawColumns.length === 0 || rawColumns.length > 24) {
    throw invalidLayout(`elements.${index}.style.columns`);
  }
  for (const [columnIndex, rawColumn] of rawColumns.entries()) {
    if (!isRecord(rawColumn)) throw invalidLayout(`elements.${index}.style.columns.${columnIndex}`);
    const field = String(rawColumn.field ?? '');
    if (!isSupportedPdfDetailTableField(field, customFieldSchema)) {
      throw invalidLayout(`elements.${index}.style.columns.${columnIndex}.field`, { field });
    }
    if (rawColumn.width !== undefined) boundedNumber(rawColumn.width, `elements.${index}.style.columns.${columnIndex}.width`, 0.1, 100);
    if (rawColumn.visible !== undefined && typeof rawColumn.visible !== 'boolean') {
      throw invalidLayout(`elements.${index}.style.columns.${columnIndex}.visible`);
    }
  }
}

function validateTableSort(rawSort: unknown, index: number, customFieldSchema: Record<string, unknown>): void {
  if (rawSort === undefined || rawSort === null) return;
  if (!isRecord(rawSort)) throw invalidLayout(`elements.${index}.style.sort`);
  if (!isSupportedPdfDetailTableField(String(rawSort.field), customFieldSchema) || !TABLE_SORT_DIRECTIONS.has(String(rawSort.direction ?? 'asc'))) {
    throw invalidLayout(`elements.${index}.style.sort`);
  }
}

function isSupportedPdfField(fieldId: string, customFieldSchema: Record<string, unknown>): boolean {
  if (builtInPdfFieldIds().has(fieldId)) return true;
  return Object.prototype.hasOwnProperty.call(customFieldSchema, fieldId) || Object.prototype.hasOwnProperty.call(customFieldSchema, fieldId.replace(/^custom\./, ''));
}

function builtInPdfFieldIds(): Set<string> {
  return new Set([...LABEL_FIELD_CATALOG.map((field) => field.id), ...CUT_SPECIFIC_FIELD_CATALOG.map((field) => field.id)]);
}

function isSupportedPdfDetailTableField(fieldId: string, customFieldSchema: Record<string, unknown>): boolean {
  const detailFieldId = fieldId.startsWith('detail.') ? fieldId : `detail.${fieldId}`;
  if (detailFieldId === 'detail.table') return false;
  return detailFieldId.startsWith('detail.') && isSupportedPdfField(detailFieldId, customFieldSchema);
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalidLayout(field);
  }
  return value;
}

function invalidLayout(field: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(422, 'CUT_PDF_TEMPLATE_LAYOUT_INVALID', 'Некорректный layout шаблона PDF раскроя', {
    field,
    ...details,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CUT_SPECIFIC_FIELD_CATALOG: CutPdfFieldCatalogItem[] = [
  { id: 'job.name', source: 'job', sourceColumn: null, label: 'Название задания', category: 'Задание раскроя', type: 'string' },
  { id: 'job.number', source: 'job', sourceColumn: null, label: 'Номер задания', category: 'Задание раскроя', type: 'number' },
  { id: 'job.pdf_template', source: 'job', sourceColumn: null, label: 'Шаблон PDF', category: 'Задание раскроя', type: 'string' },
  { id: 'group.number', source: 'group', sourceColumn: null, label: 'Номер группы', category: 'Группа раскроя', type: 'number' },
  { id: 'group.material', source: 'group', sourceColumn: null, label: 'Материал группы', category: 'Группа раскроя', type: 'string' },
  { id: 'group.film', source: 'group', sourceColumn: null, label: 'Пленка группы', category: 'Группа раскроя', type: 'string' },
  { id: 'sheet.number', source: 'sheet', sourceColumn: null, label: 'Номер листа', category: 'Лист раскроя', type: 'number' },
  { id: 'sheet.page_count', source: 'sheet', sourceColumn: null, label: 'Количество листов', category: 'Лист раскроя', type: 'number' },
  { id: 'sheet.size', source: 'sheet', sourceColumn: null, label: 'Размер листа', category: 'Лист раскроя', type: 'string' },
  { id: 'sheet.details_count', source: 'sheet', sourceColumn: null, label: 'Количество деталей на листе', category: 'Лист раскроя', type: 'number' },
  { id: 'sheet.area', source: 'sheet', sourceColumn: null, label: 'Площадь деталей', category: 'Лист раскроя', type: 'number' },
  { id: 'sheet.thumbnail', source: 'sheet', sourceColumn: null, label: 'Миниатюра листа раскроя', category: 'Лист раскроя', type: 'string' },
  { id: 'detail.materials', source: 'detail', sourceColumn: null, label: 'Материалы деталей', category: 'Детали листа', type: 'string' },
  { id: 'detail.films', source: 'detail', sourceColumn: null, label: 'Пленки деталей', category: 'Детали листа', type: 'string' },
  { id: 'detail.thicknesses', source: 'detail', sourceColumn: null, label: 'Толщины деталей', category: 'Детали листа', type: 'string' },
  { id: 'detail.table', source: 'detail', sourceColumn: null, label: 'Таблица деталей листа', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.row_number', source: 'detail', sourceColumn: null, label: 'Номер строки', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.order', source: 'detail', sourceColumn: null, label: 'Заказ', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.position', source: 'detail', sourceColumn: null, label: 'Позиция', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.lengthMm', source: 'detail', sourceColumn: null, label: 'Длина', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.widthMm', source: 'detail', sourceColumn: null, label: 'Ширина', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.quantity', source: 'detail', sourceColumn: null, label: 'Количество', category: 'Таблица деталей', type: 'number' },
  { id: 'detail.material', source: 'detail', sourceColumn: null, label: 'Материал', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.film', source: 'detail', sourceColumn: null, label: 'Пленка', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.client', source: 'detail', sourceColumn: null, label: 'Клиент', category: 'Таблица деталей', type: 'string' },
  { id: 'detail.orderDate', source: 'detail', sourceColumn: null, label: 'Дата заказа', category: 'Таблица деталей', type: 'date' },
  { id: 'detail.readyDate', source: 'detail', sourceColumn: null, label: 'Дата готовности', category: 'Таблица деталей', type: 'date' },
  { id: 'detail.thickness', source: 'detail', sourceColumn: null, label: 'Толщина', category: 'Таблица деталей', type: 'number' },
  { id: 'computed.today', source: 'cut', sourceColumn: null, label: 'Текущая дата', category: 'Вычисляемые', type: 'date' },
  { id: 'computed.page_number', source: 'cut', sourceColumn: null, label: 'Номер страницы', category: 'Вычисляемые', type: 'number' },
  { id: 'computed.page_count', source: 'cut', sourceColumn: null, label: 'Всего страниц', category: 'Вычисляемые', type: 'number' },
];
