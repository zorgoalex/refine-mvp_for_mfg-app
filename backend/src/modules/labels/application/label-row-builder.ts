import { createHash } from 'node:crypto';
import type { LabelTemplateDto, OrderLabelDataDetailDto } from './labels.types';
import { parseBasisData, type ParsedBasisData } from './parse-basis-data';

export interface LabelRow {
  rowIndex: number;
  detailId: number;
  orderId: number;
  copyIndex: number;
  copyCount: number;
  values: Record<string, string | number | boolean | null>;
}

export function buildLabelRows(input: {
  orderName: string | null;
  orderFields?: Record<string, unknown>;
  template: Pick<LabelTemplateDto, 'customFieldSchema'>;
  details: OrderLabelDataDetailDto[];
  useBasisFields?: boolean;
  today?: string;
}): LabelRow[] {
  const expanded: LabelRow[] = [];
  for (const detail of input.details) {
    const copyCount = Math.max(0, Math.trunc(detail.quantity || 0));
    const detailOrderFields = detail.orderFields && Object.keys(detail.orderFields).length > 0
      ? detail.orderFields
      : input.orderFields ?? {};
    const detailOrderName = readOrderNameFromFields(detailOrderFields) ?? input.orderName;
    for (let copyIndex = 1; copyIndex <= copyCount; copyIndex += 1) {
      expanded.push({
        rowIndex: expanded.length + 1,
        detailId: detail.detailId,
        orderId: detail.orderId,
        copyIndex,
        copyCount,
        values: buildBaseValues(detailOrderName, detailOrderFields, input.template.customFieldSchema, detail, input.useBasisFields ?? true),
      });
    }
  }

  const total = expanded.length;
  for (const row of expanded) {
    row.values['date.today'] = input.today ?? new Date().toISOString().slice(0, 10);
    row.values['label.counter'] = row.rowIndex;
    row.values['label.counter_total'] = total;
    row.values['label.counter_text'] = `Бир. № ${row.rowIndex} / ${total}`;
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
  customFieldSchema: Record<string, unknown>,
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
  for (const [key, schema] of Object.entries(customFieldSchema)) {
    const defaultValue = readCustomDefaultValue(schema);
    if (defaultValue !== undefined) {
      values[key] = normalizeValue(defaultValue);
    }
    const sourceField = readCustomSourceField(schema);
    if (sourceField && values[sourceField] !== undefined) {
      values[key] = values[sourceField];
    }
  }
  for (const [key, value] of Object.entries(detail.customFields)) {
    values[key] = normalizeValue(value);
  }
  return values;
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
