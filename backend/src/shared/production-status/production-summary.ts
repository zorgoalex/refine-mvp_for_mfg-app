/** Fresh composition for automation; HDF is a separate workflow. */
export interface ProductionComposition {
  detailCount: number;
  unassignedCount: number;
  statusIds: readonly number[];
}

export function uniformProductionStatus(summary: ProductionComposition | undefined): number | null {
  return summary && summary.detailCount > 0 && summary.unassignedCount === 0
    && summary.statusIds.length === 1 && summary.statusIds[0] > 0
    ? summary.statusIds[0] : null;
}

export interface ProductionSummaryFields {
  productionDetailCount?: number;
  productionUnassignedCount?: number;
  productionDistinctStatusCount?: number;
}

export interface ProductionSummaryRow {
  production_detail_count?: number | string;
  production_unassigned_count?: number | string;
  production_distinct_status_count?: number | string;
}

/** Human-readable information only; never an automation predicate. */
export function productionSummaryLabel(summary: ProductionSummaryFields & { productionStatusName?: string | null }): string {
  const { productionDetailCount: total, productionUnassignedCount: missing,
    productionDistinctStatusCount: distinct, productionStatusName: name } = summary;
  if (total === undefined || missing === undefined || distinct === undefined) return 'Состав не проверен';
  if (total === 0) return 'Нет деталей';
  if (missing === total) return `Без статуса: ${missing} из ${total}`;
  if (missing > 0) return `Разные этапы · без статуса: ${missing} из ${total}`;
  if (distinct > 1) return `Разные этапы · самый ранний: ${name || 'не определён'}`;
  return name || 'Без статуса';
}

export function mapProductionSummary(row: ProductionSummaryRow): ProductionSummaryFields {
  if (row.production_detail_count === undefined) return {};
  return {
    productionDetailCount: Number(row.production_detail_count),
    productionUnassignedCount: Number(row.production_unassigned_count),
    productionDistinctStatusCount: Number(row.production_distinct_status_count),
  };
}
