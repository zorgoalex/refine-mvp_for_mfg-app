import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { formatCutJobNumber, normalizeCutJobDisplayNumber } from '../application/cut-numbering';

interface IdentityRow extends QueryResultRow {
  cut_job_id: string | number;
  name: string | null;
  source_display_number: string | number | null;
  uses_vacuum?: boolean;
}

/** Resolve by immutable PK, never by a display number (deleted numbers may be reused). */
export async function loadCutJobAuditIdentities(client: DatabaseClient, ids: readonly number[]) {
  if (ids.length === 0) return new Map<number, CutJobAuditIdentity>();
  const result = await client.query<IdentityRow>(
    `SELECT j.cut_job_id, j.name, j.source_display_number,
            (COALESCE(p.params->>'layout_mode', '') = 'vacuum_table'
             OR COALESCE(j.last_calc_params->>'layout_mode', '') = 'vacuum_table') AS uses_vacuum
     FROM cut_job j
     LEFT JOIN cut_param_profiles p ON p.cut_param_profile_id = j.param_profile_id
     WHERE j.cut_job_id = ANY($1::bigint[])`,
    [[...new Set(ids)]],
  );
  return new Map(result.rows.map((row) => {
    const id = Number(row.cut_job_id);
    const number = normalizeCutJobDisplayNumber(row.source_display_number);
    return [id, {
      cutJobId: id,
      cutJobDisplayNumber: formatCutJobNumber(id, number === null && row.uses_vacuum === true, number),
      cutJobName: row.name,
    }];
  }));
}

export interface CutJobAuditIdentity {
  cutJobId: number;
  cutJobDisplayNumber: string;
  cutJobName: string | null;
}
