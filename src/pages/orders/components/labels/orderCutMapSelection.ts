import type {
  LabelCutMapSource,
  LabelCutMapOption,
  LabelCutMapSelection,
  OrderLabelCutMapOptions,
} from '../../../../api/types/labelsApi.types';

export interface OrderCutMapLabelRow {
  key: string;
  detailId: number;
  copyIndex: number;
  label: string;
  cutJobCutNumber: string | null;
  bathCutJobCutNumber: string | null;
  options: LabelCutMapOption[];
}

export type OrderCutMapSelectionState = Record<string, number>;
export type OrderCutMapSelectionSource = LabelCutMapSource;

export function buildOrderCutMapLabelRows(data: OrderLabelCutMapOptions | null): OrderCutMapLabelRow[] {
  if (!data) return [];
  return data.details.flatMap((detail) => Array.from({ length: Math.max(0, detail.quantity) }, (_, index) => {
    const copyIndex = index + 1;
    return {
      key: cutMapRowKey(detail.detailId, copyIndex),
      detailId: detail.detailId,
      copyIndex,
      label: `${detail.detailNumber ?? detail.detailId}: ${detail.detailName ?? 'Деталь'} · экз. ${copyIndex}`,
      cutJobCutNumber: detail.cutJobCutNumber,
      bathCutJobCutNumber: detail.bathCutJobCutNumber,
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

export function pickDefaultOrderCutMapSource(rows: OrderCutMapLabelRow[]): OrderCutMapSelectionSource {
  if (rows.some((row) => orderCutMapRowHasSourceOption(row, 'regular'))) return 'regular';
  if (rows.some((row) => orderCutMapRowHasSourceOption(row, 'bath'))) return 'bath';
  return 'regular';
}

export function buildOrderCutMapSelectionForSource(
  rows: OrderCutMapLabelRow[],
  source: OrderCutMapSelectionSource,
): OrderCutMapSelectionState {
  const selected: OrderCutMapSelectionState = {};
  for (const row of rows) {
    const option = pickSourceOption(row, source);
    if (option) selected[row.key] = option.cutResultPlacementId;
  }
  return selected;
}

export function filterOrderCutMapRowOptions(
  row: OrderCutMapLabelRow,
  source: OrderCutMapSelectionSource,
): LabelCutMapOption[] {
  return row.options.filter((option) => cutMapOptionMatchesSource(row, option, source));
}

export function orderCutMapRowHasSourceOption(
  row: OrderCutMapLabelRow,
  source: OrderCutMapSelectionSource,
): boolean {
  return row.options.some((option) => cutMapOptionMatchesSource(row, option, source));
}

export function orderCutMapSourceCutNumbers(
  rows: OrderCutMapLabelRow[],
  source: OrderCutMapSelectionSource,
): string[] {
  const numbers = new Set<string>();
  for (const row of rows) {
    const cutNumber = cutMapSourceCutNumber(row, source);
    if (cutNumber) numbers.add(cutNumber);
  }
  return [...numbers].sort((a, b) => a.localeCompare(b, 'ru'));
}

export function orderCutMapRawOptionMatchesSource(
  detail: OrderLabelCutMapOptions['details'][number],
  option: LabelCutMapOption,
  source: OrderCutMapSelectionSource,
): boolean {
  const cutNumber = source === 'regular' ? detail.cutJobCutNumber : detail.bathCutJobCutNumber;
  if (!cutNumber || option.cutNumber !== cutNumber) return false;
  return source === 'bath' ? option.isVacuum === true : option.isVacuum !== true;
}

function pickSourceOption(row: OrderCutMapLabelRow, source: OrderCutMapSelectionSource): LabelCutMapOption | undefined {
  const options = filterOrderCutMapRowOptions(row, source);
  return options.find((option) => option.isCurrent) ?? options[0];
}

function cutMapOptionMatchesSource(
  row: OrderCutMapLabelRow,
  option: LabelCutMapOption,
  source: OrderCutMapSelectionSource,
): boolean {
  const cutNumber = cutMapSourceCutNumber(row, source);
  if (!cutNumber || option.cutNumber !== cutNumber) return false;
  return source === 'bath' ? option.isVacuum === true : option.isVacuum !== true;
}

function cutMapSourceCutNumber(row: OrderCutMapLabelRow, source: OrderCutMapSelectionSource): string | null {
  return source === 'regular' ? row.cutJobCutNumber : row.bathCutJobCutNumber;
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
