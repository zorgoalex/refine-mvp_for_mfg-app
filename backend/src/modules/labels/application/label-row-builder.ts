import { createHash } from 'node:crypto';
import type { LabelTemplateDto, OrderLabelDataDetailDto } from './labels.types';
import {
  assertRenderableCustomFieldSchema,
  evaluateCustomFieldExpression,
  type LabelCustomExpressionContext,
  readCustomFieldExpressionV1,
} from './label-custom-field-expression';
import { parseBasisData, type ParsedBasisData } from './parse-basis-data';

export interface LabelRow {
  rowIndex: number;
  detailId: number;
  orderId: number;
  copyIndex: number;
  copyCount: number;
  values: Record<string, string | number | boolean | null>;
  cutMap?: LabelRowCutMapSnapshot;
}

export interface CutResultLabelRowCutMapSnapshot {
  source?: 'cut_result';
  assetKey?: string;
  cutResultPlacementId: number;
  cutResultSheetMapId: number;
  cutResultId: number;
  cutJobId: number;
  cutNumber: string;
  cutJobName: string;
  variant: 'auto' | 'manual';
  sheetIndex: number;
  sheetNumber: number;
  sheetWidthMm: number;
  sheetHeightMm: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface TelegramSvgLabelRowCutMapSnapshot {
  source: 'telegram_svg';
  assetKey: string;
  telegramLabelSheetMapId: number;
  telegramLabelPlacementId: number;
  packetId: string;
  sourceVersion: number;
  sourceMessageId: number | null;
  sourceDigest: string;
  cutNumber: string;
  cutJobName: string;
  variant: 'telegram';
  sheetIndex: number;
  sheetNumber: number;
  sheetWidthMm: number;
  sheetHeightMm: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface TelegramImageLabelRowCutMapSnapshot {
  source: 'telegram_image';
  assetKey: string;
  packetId: string;
  sourceVersion: number;
  sourceMessageId: number | null;
  sourceDigest: string;
  rawSha256: string;
  normalizedSha256: string;
  cutNumber: string;
  cutJobName: string;
  variant: 'telegram';
  sheetIndex: number;
  sheetNumber: number;
}

export type LabelRowCutMapSnapshot =
  | CutResultLabelRowCutMapSnapshot
  | TelegramSvgLabelRowCutMapSnapshot
  | TelegramImageLabelRowCutMapSnapshot;

export function buildLabelRows(input: {
  orderName: string | null;
  orderFields?: Record<string, unknown>;
  template: Pick<LabelTemplateDto, 'customFieldSchema'>;
  details: OrderLabelDataDetailDto[];
  useBasisFields?: boolean;
  today?: string;
}): LabelRow[] {
  assertRenderableCustomFieldSchema(input.template.customFieldSchema);
  const expanded: LabelRow[] = [];
  const orderDetailCollection = input.details.map((detail) => {
    const detailOrderFields = detail.orderFields && Object.keys(detail.orderFields).length > 0
      ? detail.orderFields
      : input.orderFields ?? {};
    const detailOrderName = readOrderNameFromFields(detailOrderFields) ?? input.orderName;
    return buildBaseValues(detailOrderName, detailOrderFields, detail, input.useBasisFields ?? true);
  });
  const expressionContext: LabelCustomExpressionContext = {
    getCollectionValues: (source, fieldId) => (
      source === 'order.details'
        ? orderDetailCollection.map((row) => row[fieldId] ?? null)
        : undefined
    ),
  };
  const total = input.details.reduce(
    (sum, detail) => sum + Math.max(0, Math.trunc(detail.quantity || 0)),
    0,
  );
  for (const detail of input.details) {
    const copyCount = Math.max(0, Math.trunc(detail.quantity || 0));
    const detailOrderFields = detail.orderFields && Object.keys(detail.orderFields).length > 0
      ? detail.orderFields
      : input.orderFields ?? {};
    const detailOrderName = readOrderNameFromFields(detailOrderFields) ?? input.orderName;
    for (let copyIndex = 1; copyIndex <= copyCount; copyIndex += 1) {
      const rowIndex = expanded.length + 1;
      const values = buildBaseValues(detailOrderName, detailOrderFields, detail, input.useBasisFields ?? true);
      values['date.today'] = input.today ?? new Date().toISOString().slice(0, 10);
      values['label.counter'] = rowIndex;
      values['label.counter_total'] = total;
      values['label.counter_text'] = `Бир. № ${rowIndex} / ${total}`;
      applyCustomFieldValues(values, input.template.customFieldSchema, detail.customFields, expressionContext);
      expanded.push({
        rowIndex,
        detailId: detail.detailId,
        orderId: detail.orderId,
        copyIndex,
        copyCount,
        values,
      });
    }
  }
  return expanded;
}

function readOrderNameFromFields(orderFields: Record<string, unknown>): string | null {
  const value = orderFields.order_name;
  return value == null ? null : String(value);
}

export function hashLabelRows(rows: LabelRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function buildBaseValues(
  orderName: string | null,
  orderFields: Record<string, unknown>,
  detail: OrderLabelDataDetailDto,
  useBasisFields: boolean,
): Record<string, string | number | boolean | null> {
  const parsed: ParsedBasisData = useBasisFields ? parseBasisData(detail.basisData) : { raw: '' };
  const position = useBasisFields
    ? parsed.position ?? detail.detailNumber ?? ''
    : detail.detailNumber ?? '';
  const detailName = useBasisFields
    ? detail.detailName ?? parsed.name ?? ''
    : detail.detailName ?? '';
  const values: Record<string, string | number | boolean | null> = {
    'bazis.order_number': useBasisFields ? detail.basisProject ?? orderName ?? '' : orderName ?? '',
    'bazis.detail_id': detail.detailId,
    'bazis.material': detail.materialName ?? '',
    'bazis.position': position,
    'bazis.position_number': position,
    'bazis.position_in_product': position,
    'bazis.designation': useBasisFields ? parsed.designation ?? '' : '',
    'bazis.designation_in_product': useBasisFields ? parsed.designation ?? '' : '',
    'bazis.name': detailName,
    'bazis.quantity': detail.quantity,
    'bazis.detail_length': detail.height,
    'bazis.detail_width': detail.width,
    'bazis.cut_length': detail.height,
    'bazis.cut_width': detail.width,
    'bazis.comment': detail.note ?? '',
    'bazis.note': detail.note ?? '',
    'bazis.project': useBasisFields ? detail.basisProject ?? '' : '',
  };

  for (const [key, value] of Object.entries(detail.bazisFields)) {
    values[key] = normalizeValue(value);
  }
  for (const [key, value] of Object.entries(detail.detailFields)) {
    values[`detail.${key}`] = normalizeValue(value);
  }
  for (const [key, value] of Object.entries(orderFields)) {
    values[`order.${key}`] = normalizeValue(value);
  }
  return values;
}

function applyCustomFieldValues(
  values: Record<string, string | number | boolean | null>,
  customFieldSchema: Record<string, unknown>,
  manualValues: Record<string, unknown>,
  expressionContext: LabelCustomExpressionContext = {},
): void {
  const manualFieldIds = new Set(Object.keys(manualValues));
  for (const [fieldId, value] of Object.entries(manualValues)) {
    values[fieldId] = normalizeValue(value);
  }

  const resolved = new Set(manualFieldIds);
  const resolving = new Set<string>();
  const resolveCustomField = (fieldId: string): string | number | boolean | null | undefined => {
    if (resolved.has(fieldId)) return values[fieldId];
    const schema = customFieldSchema[fieldId];
    if (schema === undefined) return values[fieldId];
    if (resolving.has(fieldId)) return '';
    resolving.add(fieldId);

    const expression = readCustomFieldExpressionV1(schema);
    if (expression) {
      values[fieldId] = evaluateCustomFieldExpression(expression, (dependency) => (
        Object.prototype.hasOwnProperty.call(customFieldSchema, dependency)
          ? resolveCustomField(dependency)
          : values[dependency]
      ), expressionContext);
    } else {
      const defaultValue = readCustomDefaultValue(schema);
      if (defaultValue !== undefined) values[fieldId] = normalizeValue(defaultValue);
      const sourceField = readCustomSourceField(schema);
      if (sourceField && values[sourceField] !== undefined) values[fieldId] = values[sourceField];
    }

    resolving.delete(fieldId);
    resolved.add(fieldId);
    return values[fieldId];
  };

  for (const fieldId of Object.keys(customFieldSchema)) resolveCustomField(fieldId);
}

function readCustomSourceField(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const value = (schema as Record<string, unknown>).sourceField;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readCustomDefaultValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const value = schema as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(value, 'defaultValue')
    ? value.defaultValue
    : undefined;
}

function normalizeValue(value: unknown): string | number | boolean | null {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value ?? null;
  }
  return JSON.stringify(value);
}
