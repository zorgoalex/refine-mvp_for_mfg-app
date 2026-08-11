import type { CutJobDto } from '../dto/cut.dto';

export const VACUUM_CUT_NUMBER_PREFIX = 'В-' as const;

export function formatCutNumber(cutJobId: number, resultNo: number, isVacuum = false): string {
  const base = `${cutJobId}-${resultNo}`;
  return isVacuum ? `${VACUUM_CUT_NUMBER_PREFIX}${base}` : base;
}

export function formatCutJobNumber(cutJobId: number, isVacuum = false): string {
  return isVacuum ? `${VACUUM_CUT_NUMBER_PREFIX}${cutJobId}` : String(cutJobId);
}

export function cutJobSnapshotUsesVacuumTable(snapshot: Pick<CutJobDto, 'groups'> | null | undefined): boolean {
  return snapshot?.groups?.some((group) => cutGroupSummaryUsesVacuumTable(group.summary)) ?? false;
}

function cutGroupSummaryUsesVacuumTable(summary: Record<string, unknown> | null | undefined): boolean {
  return summary?.engine_used === 'vacuum_table' || summary?.layout_mode === 'vacuum_table';
}
