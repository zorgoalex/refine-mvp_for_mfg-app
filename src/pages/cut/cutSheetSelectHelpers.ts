import type { CutSheetTypeOption } from '../../api/types/cutApi.types';

/**
 * Returns the set of material type ids present among the job's details,
 * resolved via the given sheet-type options list.
 */
export function jobMaterialTypeIds(
  jobItemSheetTypeIds: Array<number | null>,
  options: CutSheetTypeOption[],
): Set<number> {
  const byId = new Map(options.map((o) => [o.sheetMaterialTypeId, o.materialTypeId]));
  const out = new Set<number>();
  for (const id of jobItemSheetTypeIds) {
    if (id == null) continue;
    const mt = byId.get(id);
    if (mt != null) out.add(mt);
  }
  return out;
}

/**
 * Partitions options into two groups:
 * - preferred: options whose materialTypeId is in the job's material set
 * - others: the rest
 */
export function partitionSheetOptions(
  options: CutSheetTypeOption[],
  materialTypeIds: Set<number>,
): { preferred: CutSheetTypeOption[]; others: CutSheetTypeOption[] } {
  const preferred: CutSheetTypeOption[] = [];
  const others: CutSheetTypeOption[] = [];
  for (const o of options) {
    (materialTypeIds.has(o.materialTypeId) ? preferred : others).push(o);
  }
  return { preferred, others };
}

/**
 * Returns true when the chosen sheet does not cover all of the job's material
 * types — i.e. some job detail's material type ≠ chosen sheet's material type.
 * Returns false when chosenId is null (no override = no warning needed).
 */
export function isMixedMaterialSelection(
  chosenId: number | null,
  options: CutSheetTypeOption[],
  materialTypeIds: Set<number>,
): boolean {
  if (chosenId == null) return false;
  const chosen = options.find((o) => o.sheetMaterialTypeId === chosenId);
  if (!chosen) return false;
  for (const mt of materialTypeIds) {
    if (mt !== chosen.materialTypeId) return true;
  }
  return false;
}

/**
 * Formats a sheet option for display: "<name> · <thickness>мм · <w>×<h>"
 */
export function formatSheetOptionLabel(o: CutSheetTypeOption): string {
  return `${o.name} · ${o.thicknessMm}мм · ${o.widthMm}×${o.heightMm}`;
}
