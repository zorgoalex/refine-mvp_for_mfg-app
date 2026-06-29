// src/pages/orders/detailGrouping.ts
import type { OrderDetail } from '../../types/orders';

export type GroupField = 'milling' | 'material' | 'film' | 'edge' | 'price' | 'note';

export interface GroupFieldDef {
  field: GroupField;
  label: string;
}

export const GROUP_FIELDS: GroupFieldDef[] = [
  { field: 'milling', label: 'по фрезеровке' },
  { field: 'material', label: 'по материалам' },
  { field: 'film', label: 'по пленкам' },
  { field: 'edge', label: 'по обкату' },
  { field: 'price', label: 'по ценам' },
  { field: 'note', label: 'по примечанию' },
];

export const EMPTY_GROUP_KEY = '__EMPTY__';

// Number of distinct per-group tint classes (.detail-group-tint-0..N-1) defined in
// app.css. Group index cycles through them so each group gets its own light hue
// (NOT a two-colour zebra). Keep in sync with the palette in app.css.
export const GROUP_TINT_COUNT = 8;

const idValue = (raw: unknown): string => {
  if (raw === null || raw === undefined) return EMPTY_GROUP_KEY;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? String(num) : EMPTY_GROUP_KEY;
};

export function extractGroupValue(detail: OrderDetail, field: GroupField): string {
  switch (field) {
    case 'milling': return idValue(detail.milling_type_id);
    case 'material': return idValue(detail.sheet_material_type_id);
    case 'film': return idValue(detail.film_id);
    case 'edge': return idValue(detail.edge_type_id);
    case 'price': {
      const raw = detail.milling_cost_per_sqm;
      if (raw === null || raw === undefined) return EMPTY_GROUP_KEY;
      const num = Number(raw);
      return Number.isFinite(num) ? String(num) : EMPTY_GROUP_KEY;
    }
    case 'note': {
      const trimmed = (detail.note || '').trim();
      return trimmed === '' ? EMPTY_GROUP_KEY : trimmed;
    }
    default: return EMPTY_GROUP_KEY;
  }
}

export type GroupedRow =
  | { kind: 'detail'; detail: OrderDetail; groupIndex: number }
  | { kind: 'separator'; groupIndex: number; key: string; selectionKeys: Array<number | string>; label: string };

export interface BuildGroupedRowsOptions {
  includeLeadingSeparator?: boolean;
  groupKeyOf?: (detail: OrderDetail) => number | string | null;
  groupLabelOf?: (sampleDetail: OrderDetail, field: GroupField) => string;
}

export function buildGroupedRows(
  details: OrderDetail[],
  field: GroupField,
  options?: BuildGroupedRowsOptions,
): GroupedRow[] {
  const order: string[] = [];
  const buckets = new Map<string, OrderDetail[]>();
  for (const detail of details) {
    const key = extractGroupValue(detail, field);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      if (key !== EMPTY_GROUP_KEY) order.push(key);
    }
    buckets.get(key)!.push(detail);
  }
  if (buckets.has(EMPTY_GROUP_KEY)) order.push(EMPTY_GROUP_KEY);

  const includeLeading = options?.includeLeadingSeparator ?? false;
  const keyOf = options?.groupKeyOf ?? ((dd: OrderDetail) => (dd as any).detail_id ?? null);
  const labelOf = options?.groupLabelOf ?? (() => '');

  const rows: GroupedRow[] = [];
  order.forEach((key, groupIndex) => {
    const groupDetails = buckets.get(key)!;
    if (groupIndex > 0 || includeLeading) {
      const selectionKeys = groupDetails
        .map((dd) => keyOf(dd))
        .filter((k): k is number | string => k !== null && k !== undefined);
      rows.push({
        kind: 'separator',
        groupIndex,
        key: `__sep__:${field}:${key}:${groupIndex}`,
        selectionKeys,
        label: labelOf(groupDetails[0], field),
      });
    }
    for (const detail of groupDetails) {
      rows.push({ kind: 'detail', detail, groupIndex });
    }
  });
  return rows;
}

export function selectedGroupLabelForCut(
  details: ReadonlyArray<OrderDetail>,
  selectedDetailIds: ReadonlyArray<number>,
  field: GroupField | null | undefined,
  groupLabelOf: (sampleDetail: OrderDetail, field: GroupField) => string,
): string | null {
  if (!field || selectedDetailIds.length === 0) return null;

  const selected = new Set(selectedDetailIds);
  const selectedDetails = details.filter(
    (detail) => detail.detail_id != null && selected.has(detail.detail_id),
  );
  if (selectedDetails.length === 0) return null;

  const labels: string[] = [];
  const seenGroups = new Set<string>();
  const seenLabels = new Set<string>();

  for (const detail of selectedDetails) {
    const groupValue = extractGroupValue(detail, field);
    if (seenGroups.has(groupValue)) continue;
    seenGroups.add(groupValue);

    const label = groupLabelOf(detail, field).trim();
    if (!label || ['—', '-', '–'].includes(label) || seenLabels.has(label)) continue;
    seenLabels.add(label);
    labels.push(label);
  }

  return labels.length > 0 ? labels.join(', ') : null;
}
