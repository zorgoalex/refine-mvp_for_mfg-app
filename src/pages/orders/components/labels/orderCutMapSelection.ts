import type {
  LabelCutMapOption,
  LabelCutMapSelection,
  OrderLabelCutMapOptions,
} from '../../../../api/types/labelsApi.types';

export interface OrderCutMapLabelRow {
  key: string;
  detailId: number;
  copyIndex: number;
  label: string;
  options: LabelCutMapOption[];
}

export type OrderCutMapSelectionState = Record<string, number>;

export function buildOrderCutMapLabelRows(data: OrderLabelCutMapOptions | null): OrderCutMapLabelRow[] {
  if (!data) return [];
  return data.details.flatMap((detail) => Array.from({ length: Math.max(0, detail.quantity) }, (_, index) => {
    const copyIndex = index + 1;
    return {
      key: cutMapRowKey(detail.detailId, copyIndex),
      detailId: detail.detailId,
      copyIndex,
      label: `${detail.detailNumber ?? detail.detailId}: ${detail.detailName ?? 'Деталь'} · экз. ${copyIndex}`,
      options: detail.options.filter((option) => option.instance === copyIndex && option.dimensionsMatch && !option.isArchived),
    };
  }));
}

export function buildDefaultOrderCutMapSelection(rows: OrderCutMapLabelRow[]): OrderCutMapSelectionState {
  const selected: OrderCutMapSelectionState = {};
  const byDetail = new Map<number, OrderCutMapLabelRow[]>();
  for (const row of rows) {
    const detailRows = byDetail.get(row.detailId);
    if (detailRows) detailRows.push(row);
    else byDetail.set(row.detailId, [row]);
  }
  for (const detailRows of byDetail.values()) {
    const first = detailRows[0];
    if (!first) continue;
    const candidates = [...new Set(first.options.map(cutMapOptionCandidateKey))];
    const completeCandidates = candidates.filter((candidate) => detailRows.every((row) => (
      row.options.some((option) => cutMapOptionCandidateKey(option) === candidate)
    )));
    const completeCandidate = pickDefaultCutMapCandidate(completeCandidates, detailRows);
    if (!completeCandidate) continue;
    for (const row of detailRows) {
      const option = row.options.find((item) => cutMapOptionCandidateKey(item) === completeCandidate);
      if (option) selected[row.key] = option.cutResultPlacementId;
    }
  }
  return selected;
}

function pickDefaultCutMapCandidate(
  candidates: string[],
  rows: OrderCutMapLabelRow[],
): string | undefined {
  return candidates.find((candidate) => everyCandidateOption(candidate, rows, (option) => (
    option.isCurrent && option.isVacuum !== true
  )))
    ?? candidates.find((candidate) => everyCandidateOption(candidate, rows, (option) => option.isVacuum !== true))
    ?? candidates.find((candidate) => everyCandidateOption(candidate, rows, (option) => option.isCurrent))
    ?? candidates[0];
}

function everyCandidateOption(
  candidate: string,
  rows: OrderCutMapLabelRow[],
  predicate: (option: LabelCutMapOption) => boolean,
): boolean {
  return rows.every((row) => {
    const option = row.options.find((item) => cutMapOptionCandidateKey(item) === candidate);
    return option !== undefined && predicate(option);
  });
}

function cutMapOptionCandidateKey(option: LabelCutMapOption): string {
  return `${option.cutResultId}:${option.variant}`;
}

export function buildOrderCutMapSelections(
  rows: OrderCutMapLabelRow[],
  selected: OrderCutMapSelectionState,
  detailId?: number | null,
): LabelCutMapSelection[] {
  return rows
    .filter((row) => detailId == null || row.detailId === detailId)
    .flatMap((row) => {
      const placementId = selected[row.key];
      return placementId
        ? [{ detailId: row.detailId, copyIndex: row.copyIndex, cutResultPlacementId: placementId }]
        : [];
    });
}

export function missingOrderCutMapRows(
  rows: OrderCutMapLabelRow[],
  selected: OrderCutMapSelectionState,
  detailId?: number | null,
): OrderCutMapLabelRow[] {
  return rows.filter((row) => (
    (detailId == null || row.detailId === detailId)
    && !row.options.some((option) => option.cutResultPlacementId === selected[row.key])
  ));
}

export function cutMapRowKey(detailId: number, copyIndex: number): string {
  return `${detailId}:${copyIndex}`;
}
