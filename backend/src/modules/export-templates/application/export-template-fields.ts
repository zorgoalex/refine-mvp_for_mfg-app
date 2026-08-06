import type {
  BazisExportDetail,
  ExportEvaluationContext,
  ExportFieldDefinition,
  ExportScalar,
} from './export-template.types';
import { buildBazisCutQrCode } from '../../bazis-cut/application/bazis-cut-identity';

const DETAIL_FIELDS: ExportFieldDefinition[] = [
  ['cutEnabled', 'Кроить', 'boolean'], ['materialType', 'Тип материала', 'string'],
  ['materialName', 'Материал', 'string'], ['materialArticle', 'Артикул материала', 'string'],
  ['thicknessMm', 'Толщина', 'number'], ['position', 'Позиция', 'string'],
  ['partName', 'Наименование', 'string'], ['finishedLengthMm', 'Длина готовая', 'number'],
  ['finishedWidthMm', 'Ширина готовая', 'number'], ['cutLengthMm', 'Длина распиловочная', 'number'],
  ['cutWidthMm', 'Ширина распиловочная', 'number'], ['quantity', 'Количество', 'number'],
  ['orientation', 'Ориентация', 'string'], ['groove', 'Паз', 'string'],
  ['l1Name', 'L1 — наименование', 'string'], ['l1Designation', 'L1 — обозначение', 'string'],
  ['l1ThicknessMm', 'L1 — толщина', 'number'], ['l2Name', 'L2 — наименование', 'string'],
  ['l2Designation', 'L2 — обозначение', 'string'], ['l2ThicknessMm', 'L2 — толщина', 'number'],
  ['w1Name', 'W1 — наименование', 'string'], ['w1Designation', 'W1 — обозначение', 'string'],
  ['w1ThicknessMm', 'W1 — толщина', 'number'], ['w2Name', 'W2 — наименование', 'string'],
  ['w2Designation', 'W2 — обозначение', 'string'], ['w2ThicknessMm', 'W2 — толщина', 'number'],
  ['priority', 'Приоритет', 'number'], ['comment', 'Комментарий', 'string'],
  ['customProperty', 'Пользовательское свойство', 'string'], ['glue', 'Склейка', 'string'],
  ['milling', 'Фрезировка', 'string'], ['route', 'Маршрут', 'string'], ['film', 'Пленка', 'string'],
].map(([key, label, valueType]) => ({ key: `detail.${key}`, label, group: 'Поля детали', valueType })) as ExportFieldDefinition[];

const SOURCE_FIELDS: ExportFieldDefinition[] = [
  ['sourceBazisProjectName', 'Базис-проект', 'string'], ['sourceBazisOrderNo', 'Базис-заказ', 'string'],
  ['sourceBazisProductName', 'Изделие', 'string'], ['sourceBathCutNumber', 'Ванна', 'string'],
  ['sourceOrderName', 'ERP-заказ: название', 'string'], ['sourceOrderFullNumber', 'ERP-заказ: полный номер', 'string'],
  ['sourceProjectCode', 'Проект: код', 'string'], ['sourceOrderDetailId', 'ID детали ERP', 'number'],
  ['sourceOrderId', 'ID ERP-заказа', 'number'], ['sourceProjectId', 'ID проекта', 'number'],
  ['sourceBazisProjectId', 'ID Базис-проекта', 'number'], ['sourceBazisRevisionId', 'ID ревизии', 'number'],
  ['sourceBazisNodeId', 'ID панели', 'number'],
].map(([key, label, valueType]) => ({ key: `source.${key}`, label, group: 'Источник', valueType })) as ExportFieldDefinition[];

const LEGACY_FIELDS: ExportFieldDefinition[] = [
  ['cutEnabled', 'XLS: Кроить', 'string'], ['order', 'XLS: Заказ', 'string'],
  ['product', 'XLS: Изделие', 'string'], ['position', 'XLS: Позиция', 'string'],
  ['qr', 'XLS: QR-code', 'string'],
].map(([key, label, valueType]) => ({ key: `legacy.${key}`, label, group: 'Совместимость', valueType })) as ExportFieldDefinition[];

const DYNAMIC_FIELDS: ExportFieldDefinition[] = [
  { key: 'row.number', label: 'Номер строки', group: 'Динамические', valueType: 'number' },
  { key: 'export.date', label: 'Дата экспорта', group: 'Динамические', valueType: 'string' },
  { key: 'export.datetime', label: 'Дата и время экспорта', group: 'Динамические', valueType: 'date-time' },
  { key: 'template.name', label: 'Название шаблона', group: 'Динамические', valueType: 'string' },
];

export const EXPORT_FIELD_CATALOG: ExportFieldDefinition[] = [
  ...DETAIL_FIELDS,
  ...SOURCE_FIELDS,
  ...LEGACY_FIELDS,
  ...DYNAMIC_FIELDS,
];

export const EXPORT_FIELD_KEYS = new Set(EXPORT_FIELD_CATALOG.map((field) => field.key));

export function resolveExportField(
  key: string,
  detail: BazisExportDetail,
  context: ExportEvaluationContext,
): ExportScalar {
  if (key.startsWith('detail.')) {
    return normalizeScalar(detail[key.slice('detail.'.length) as keyof BazisExportDetail]);
  }
  if (key.startsWith('source.')) {
    return normalizeScalar(detail[key.slice('source.'.length) as keyof BazisExportDetail]);
  }
  const order = detail.xlsOrder?.trim() ?? detail.sourceBazisOrderNo?.trim() ?? '';
  switch (key) {
    case 'legacy.cutEnabled': return detail.cutEnabled ? 'Да' : 'Нет';
    case 'legacy.order': return order;
    case 'legacy.product': return detail.sourceBazisProductName ?? '';
    case 'legacy.position': return detail.position.trim();
    case 'legacy.qr': return buildBazisCutQrCode(detail);
    case 'row.number': return context.rowNumber;
    case 'export.date': return context.exportedAt.toISOString().slice(0, 10);
    case 'export.datetime': return context.exportedAt.toISOString();
    case 'template.name': return context.templateName;
    default: return null;
  }
}

function normalizeScalar(value: unknown): ExportScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}
