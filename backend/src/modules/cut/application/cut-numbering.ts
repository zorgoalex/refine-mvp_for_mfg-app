import type { CutJobDto } from '../dto/cut.dto';

export const VACUUM_CUT_NUMBER_PREFIX = 'В-' as const;

export function normalizeCutJobDisplayNumber(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized === '' ? null : normalized;
}

export function formatCutNumber(
  cutJobId: number,
  resultNo: number,
  isVacuum = false,
  sourceDisplayNumber?: string | number | null,
): string {
  const jobNumber = normalizeCutJobDisplayNumber(sourceDisplayNumber) ?? String(cutJobId);
  const base = `${jobNumber}-${resultNo}`;
  return prefixVacuumCutNumber(base, isVacuum);
}

export function formatCutJobNumber(
  cutJobId: number,
  isVacuum = false,
  sourceDisplayNumber?: string | number | null,
): string {
  const jobNumber = normalizeCutJobDisplayNumber(sourceDisplayNumber) ?? String(cutJobId);
  return prefixVacuumCutNumber(jobNumber, isVacuum);
}

function prefixVacuumCutNumber(value: string, isVacuum: boolean): string {
  if (!isVacuum || value.startsWith(VACUUM_CUT_NUMBER_PREFIX)) return value;
  return `${VACUUM_CUT_NUMBER_PREFIX}${value}`;
}

export function cutJobSnapshotUsesVacuumTable(snapshot: Pick<CutJobDto, 'groups'> | null | undefined): boolean {
  return snapshot?.groups?.some((group) => cutGroupSummaryUsesVacuumTable(group.summary)) ?? false;
}

function cutGroupSummaryUsesVacuumTable(summary: Record<string, unknown> | null | undefined): boolean {
  return summary?.engine_used === 'vacuum_table' || summary?.layout_mode === 'vacuum_table';
}
