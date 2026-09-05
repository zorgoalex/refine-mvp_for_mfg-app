import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import { VACUUM_CUT_NUMBER_PREFIX, normalizeCutJobDisplayNumber } from '../application/cut-numbering';

export type CutJobDisplayNumberKind = 'regular' | 'vacuum';

interface NextDisplayNumberRow extends QueryResultRow {
  next_no: string | number | null;
}
export function cutJobDisplayNumberKind(value: string | number | null | undefined): CutJobDisplayNumberKind | null {
  const normalized = normalizeCutJobDisplayNumber(value);
  if (normalized === null) return null;
  return normalized.startsWith(VACUUM_CUT_NUMBER_PREFIX) ? 'vacuum' : 'regular';
}

export function formatCutJobSourceDisplayNumber(kind: CutJobDisplayNumberKind, number: number): string {
  return kind === 'vacuum' ? `${VACUUM_CUT_NUMBER_PREFIX}${number}` : String(number);
}

export async function allocateCutJobSourceDisplayNumber(
  tx: TransactionClient,
  kind: CutJobDisplayNumberKind,
): Promise<string> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cut_job_display_number:${kind}`]);
  const result = await tx.query<NextDisplayNumberRow>(
    kind === 'vacuum'
      ? `
        SELECT COALESCE(MAX(substring(NULLIF(btrim(source_display_number), '') FROM 3)::numeric), 0) + 1 AS next_no
        FROM cut_job
        WHERE NULLIF(btrim(source_display_number), '') ~ '^В-[0-9]+$'
        `
      : `
        SELECT COALESCE(MAX(NULLIF(btrim(source_display_number), '')::numeric), 0) + 1 AS next_no
        FROM cut_job
        WHERE NULLIF(btrim(source_display_number), '') ~ '^[0-9]+$'
        `,
  );
  const next = Number(result.rows[0]?.next_no ?? 1);
  if (!Number.isSafeInteger(next) || next <= 0) {
    throw new ApiError(409, 'CUT_JOB_NUMBER_EXHAUSTED', 'Автоматическая нумерация раскроев достигла предела');
  }
  return formatCutJobSourceDisplayNumber(kind, next);
}
