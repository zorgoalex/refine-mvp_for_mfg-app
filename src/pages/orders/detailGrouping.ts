// src/pages/orders/detailGrouping.ts
import type { OrderDetail } from '../../types/orders';
import { calculateOrderTotalArea } from '../../utils/orderArea';

export type GroupField =
  | 'detail_number'
  | 'area'
  | 'milling'
  | 'hdf_parameter'
  | 'edge'
  | 'material'
  | 'note'
  | 'price'
  | 'detail_cost'
  | 'film'
  | 'production_status'
  | 'doweling'
  | 'cut_job'
  | 'bath_cut_job'
  | 'basis_project'
  | 'bazis_cut_sets';

export interface GroupFieldDef {
  field: GroupField;
  label: string;
}

export const GROUP_FIELDS: GroupFieldDef[] = [
  { field: 'detail_number', label: 'по №' },
  { field: 'area', label: 'по площади' },
  { field: 'milling', label: 'по фрезеровке' },
  { field: 'hdf_parameter', label: 'по ХДФ параметру' },
  { field: 'edge', label: 'по обкату' },
  { field: 'material', label: 'по материалам' },
  { field: 'note', label: 'по примечанию' },
  { field: 'price', label: 'по ценам' },
  { field: 'detail_cost', label: 'по сумме' },
  { field: 'film', label: 'по пленкам' },
  { field: 'production_status', label: 'по статусу' },
  { field: 'doweling', label: 'по присадке' },
  { field: 'cut_job', label: 'по раскрою' },
  { field: 'bath_cut_job', label: 'по расчету ванны' },
  { field: 'basis_project', label: 'по Базис проекту' },
  { field: 'bazis_cut_sets', label: 'по Базис-раскрою' },
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

const numberValue = (raw: unknown): string => {
  if (raw === null || raw === undefined || raw === '') return EMPTY_GROUP_KEY;
  const num = Number(raw);
  return Number.isFinite(num) ? String(num) : EMPTY_GROUP_KEY;
};

const positiveNumberValue = (raw: unknown): string => {
  if (raw === null || raw === undefined || raw === '') return EMPTY_GROUP_KEY;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? String(num) : EMPTY_GROUP_KEY;
};

const textValue = (raw: unknown): string => {
  const trimmed = String(raw ?? '').trim();
  return trimmed === '' ? EMPTY_GROUP_KEY : trimmed;
};

export function extractCutJobGroupValue(ref: OrderDetail['cut_job'] | undefined): string {
  if (!ref) return EMPTY_GROUP_KEY;
  const cutJobId = Number(ref.cutJobId);
  const resultNo = Number(ref.resultNo);
  if (!Number.isFinite(cutJobId) || cutJobId <= 0) return EMPTY_GROUP_KEY;
  return `${cutJobId}:${Number.isFinite(resultNo) ? resultNo : 0}`;
}

export function formatCutJobGroupLabel(ref: OrderDetail['cut_job'] | undefined): string {
  if (!ref) return '—';
  const name = String(ref.name || '').trim();
  const cutNumber = String(ref.cutNumber || '').trim();
  if (cutNumber && name) return `${cutNumber}: ${name}`;
  return name || cutNumber || `Раскрой ${ref.cutJobId}`;
}

export function extractBazisCutSetsGroupValue(cutSets: OrderDetail['bazis_cut_sets'] | undefined): string {
  const values = (cutSets ?? [])
    .map((cutSet) => {
      const id = Number(cutSet?.bazisCutSetId);
      if (Number.isFinite(id) && id > 0) return `id:${id}`;
      const name = textValue(cutSet?.name);
      return name === EMPTY_GROUP_KEY ? null : `name:${name}`;
    })
    .filter((value): value is string => value !== null)
    .sort();
  return values.length > 0 ? values.join('|') : EMPTY_GROUP_KEY;
}

export function formatBazisCutSetsGroupLabel(cutSets: OrderDetail['bazis_cut_sets'] | undefined): string {
  const labels = (cutSets ?? [])
    .map((cutSet) => {
      const id = Number(cutSet?.bazisCutSetId);
      if (Number.isFinite(id) && id > 0) return `БР-${id}`;
      return String(cutSet?.name ?? '').trim();
    })
    .filter(Boolean);
  return labels.length > 0 ? labels.join(', ') : '—';
}

export function extractBasisProjectGroupValue(detail: OrderDetail): string {
  const projectId = Number(detail.bazis_project_id ?? detail.bazis_projects?.[0]?.bazisProjectId);
  if (Number.isFinite(projectId) && projectId > 0) return `id:${projectId}`;
  return textValue(detail.basis_project ?? detail.bazis_projects?.[0]?.name);
}

export function formatBasisProjectGroupLabel(detail: OrderDetail): string {
  return String(detail.basis_project || detail.bazis_projects?.[0]?.name || '').trim() || '—';
}

export function extractGroupValue(detail: OrderDetail, field: GroupField): string {
  switch (field) {
    case 'detail_number': return positiveNumberValue(detail.detail_number);
    case 'area': return numberValue(detail.area);
    case 'milling': return idValue(detail.milling_type_id);
    case 'hdf_parameter': return numberValue(detail.hdf_parameter_override_mm);
    case 'edge': return idValue(detail.edge_type_id);
    case 'material': return idValue(detail.sheet_material_type_id);
    case 'film': return idValue(detail.film_id);
    case 'price': {
      return numberValue(detail.milling_cost_per_sqm);
    }
    case 'detail_cost': return numberValue(detail.detail_cost);
    case 'note': {
      const trimmed = (detail.note || '').trim();
      return trimmed === '' ? EMPTY_GROUP_KEY : trimmed;
    }
    case 'production_status': return idValue(detail.production_status_id);
    // Boolean: детали с присадкой — своя группа, остальные падают в «пустую»
    // (EMPTY сортируется последней, присадочные оказываются сверху).
    case 'doweling': return detail.doweling === true ? 'yes' : EMPTY_GROUP_KEY;
    case 'cut_job': return extractCutJobGroupValue(detail.cut_job);
    case 'bath_cut_job': return extractCutJobGroupValue(detail.bath_cut_job);
    case 'basis_project': return extractBasisProjectGroupValue(detail);
    case 'bazis_cut_sets': return extractBazisCutSetsGroupValue(detail.bazis_cut_sets);
    default: return EMPTY_GROUP_KEY;
  }
}

export type GroupedRow =
  | { kind: 'detail'; detail: OrderDetail; groupIndex: number }
  | { kind: 'separator'; groupIndex: number; key: string; selectionKeys: Array<number | string>; label: string }
  | {
      kind: 'summary';
      groupIndex: number;
      key: string;
      totals: {
        count: number;
        quantity: number;
        area: number;
        detailCost: number;
      };
    };

export interface BuildGroupedRowsOptions {
  includeLeadingSeparator?: boolean;
  groupKeyOf?: (detail: OrderDetail) => number | string | null;
  groupValueOf?: (detail: OrderDetail, field: GroupField) => string | null | undefined;
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
    const customKey = options?.groupValueOf?.(detail, field);
    const key = customKey === null || customKey === undefined || customKey === ''
      ? extractGroupValue(detail, field)
      : customKey;
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
    rows.push({
      kind: 'summary',
      groupIndex,
      key: `__summary__:${field}:${key}:${groupIndex}`,
      totals: {
        count: groupDetails.length,
        quantity: groupDetails.reduce((sum, detail) => sum + (Number(detail.quantity) || 0), 0),
        area: calculateOrderTotalArea(groupDetails),
        detailCost: groupDetails.reduce((sum, detail) => sum + (Number(detail.detail_cost) || 0), 0),
      },
    });
  });
  return rows;
}

export function selectedGroupLabelForCut(
  details: ReadonlyArray<OrderDetail>,
  selectedDetailIds: ReadonlyArray<number>,
  field: GroupField | null | undefined,
  groupLabelOf: (sampleDetail: OrderDetail, field: GroupField) => string,
  groupValueOf?: (detail: OrderDetail, field: GroupField) => string | null | undefined,
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
    const customGroupValue = groupValueOf?.(detail, field);
    const groupValue = customGroupValue === null || customGroupValue === undefined || customGroupValue === ''
      ? extractGroupValue(detail, field)
      : customGroupValue;
    if (seenGroups.has(groupValue)) continue;
    seenGroups.add(groupValue);

    const label = groupLabelOf(detail, field).trim();
    if (!label || ['—', '-', '–'].includes(label) || seenLabels.has(label)) continue;
    seenLabels.add(label);
    labels.push(label);
  }

  return labels.length > 0 ? labels.join(', ') : null;
}
