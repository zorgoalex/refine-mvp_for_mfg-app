import { createHash } from 'node:crypto';
import type { LabelTemplateDto, OrderLabelDataDetailDto } from './labels.types';
import { parseBasisData } from './parse-basis-data';

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
  template: Pick<LabelTemplateDto, 'customFieldSchema'>;
  details: OrderLabelDataDetailDto[];
  today?: string;
}): LabelRow[] {
  const expanded: LabelRow[] = [];
  for (const detail of input.details) {
    const copyCount = Math.max(0, Math.trunc(detail.quantity || 0));
    for (let copyIndex = 1; copyIndex <= copyCount; copyIndex += 1) {
      expanded.push({
        rowIndex: expanded.length + 1,
        detailId: detail.detailId,
        orderId: detail.orderId,
        copyIndex,
        copyCount,
        values: buildBaseValues(input.orderName, detail),
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

export function hashLabelRows(rows: LabelRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function buildBaseValues(
  orderName: string | null,
  detail: OrderLabelDataDetailDto,
): Record<string, string | number | boolean | null> {
  const parsed = parseBasisData(detail.basisData);
  const values: Record<string, string | number | boolean | null> = {
    'bazis.order_number': orderName ?? '',
    'bazis.detail_id': detail.detailId,
    'bazis.material': detail.materialName ?? '',
    'bazis.position': parsed.position ?? detail.detailNumber ?? '',
    'bazis.position_number': parsed.position ?? detail.detailNumber ?? '',
    'bazis.position_in_product': parsed.position ?? detail.detailNumber ?? '',
    'bazis.designation': parsed.designation ?? '',
    'bazis.designation_in_product': parsed.designation ?? '',
    'bazis.name': detail.detailName ?? parsed.name ?? '',
    'bazis.quantity': detail.quantity,
    'bazis.detail_length': detail.height,
    'bazis.detail_width': detail.width,
    'bazis.cut_length': detail.height,
    'bazis.cut_width': detail.width,
    'bazis.comment': detail.note ?? '',
    'bazis.note': detail.note ?? '',
    'bazis.project': detail.basisProject ?? '',
  };

  for (const [key, value] of Object.entries(detail.bazisFields)) {
    values[key] = normalizeValue(value);
  }
  for (const [key, value] of Object.entries(detail.customFields)) {
    values[key] = normalizeValue(value);
  }
  return values;
}

function normalizeValue(value: unknown): string | number | boolean | null {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value ?? null;
  }
  return JSON.stringify(value);
}
