import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { DeadlineStatus } from '../../deadlines/domain/deadline-status';
import type {
  GroupDeadlineStatusCountsReportQuery,
  GroupDeadlineStatusCountsReportResponseDto,
} from './group-deadline-status-counts-report.dto';

interface DeadlineStatusCountRow extends QueryResultRow {
  deadline_status: DeadlineStatus;
  deadline_count: string | number;
}

export interface GroupDeadlineStatusCountsReportRepositoryPort {
  listDeadlineStatusCounts(
    query: GroupDeadlineStatusCountsReportQuery,
  ): Promise<GroupDeadlineStatusCountsReportResponseDto>;
}

export function buildGroupDeadlineStatusCountsSql(query: GroupDeadlineStatusCountsReportQuery): {
  text: string;
  params: unknown[];
} {
  const filter = query.predicateFilter;
  const groupIds = filter.mode === 'none' ? [] : filter.groupIds;
  const params: unknown[] = [groupIds, filter.mode];

  return {
    params,
    text: `
WITH explicit_deadline_groups AS (
  SELECT DISTINCT
    d.deadline_id,
    pel.group_id
  FROM public.deadline_instances d
  JOIN public.group_entity_links pel
    ON pel.entity_type_code = 'deadline_instance'
   AND pel.entity_id_text = d.deadline_id::text
   AND pel.valid_to IS NULL
),
derived_deadline_groups AS (
  SELECT DISTINCT
    d.deadline_id,
    pop.group_id
  FROM public.deadline_instances d
  JOIN public.group_order_groups pop
    ON pop.order_id = d.order_id
   AND pop.valid_to IS NULL
  WHERE d.order_id IS NOT NULL
  UNION
  SELECT DISTINCT
    d.deadline_id,
    pop.group_id
  FROM public.deadline_instances d
  JOIN public.order_workshops ow
    ON ow.order_workshop_id = d.order_workshop_id
   AND COALESCE(ow.delete_flag, false) = false
  JOIN public.group_order_groups pop
    ON pop.order_id = ow.order_id
   AND pop.valid_to IS NULL
  WHERE d.order_workshop_id IS NOT NULL
),
effective_deadline_groups AS (
  SELECT edp.deadline_id, edp.group_id
  FROM explicit_deadline_groups edp
  UNION
  SELECT ddp.deadline_id, ddp.group_id
  FROM derived_deadline_groups ddp
  WHERE NOT EXISTS (
    SELECT 1
    FROM explicit_deadline_groups edp
    WHERE edp.deadline_id = ddp.deadline_id
  )
)
SELECT
  d.status AS deadline_status,
  COUNT(DISTINCT d.deadline_id)::int AS deadline_count
FROM public.deadline_instances d
WHERE
  CASE
    WHEN $2::text = 'none' THEN NOT EXISTS (
  SELECT 1
  FROM effective_deadline_groups edp
      WHERE edp.deadline_id = d.deadline_id
    )
    WHEN $2::text = 'any' THEN EXISTS (
  SELECT 1
  FROM effective_deadline_groups edp
      WHERE edp.deadline_id = d.deadline_id
        AND edp.group_id = ANY($1::uuid[])
    )
    WHEN $2::text = 'all' THEN (
      SELECT COUNT(DISTINCT edp.group_id)::int
      FROM effective_deadline_groups edp
      WHERE edp.deadline_id = d.deadline_id
        AND edp.group_id = ANY($1::uuid[])
    ) = cardinality($1::uuid[])
    ELSE false
  END
GROUP BY d.status
ORDER BY d.status ASC
`,
  };
}

export class PgGroupDeadlineStatusCountsReportRepository
  implements GroupDeadlineStatusCountsReportRepositoryPort
{
  constructor(private readonly database: DatabaseClient) {}

  async listDeadlineStatusCounts(
    query: GroupDeadlineStatusCountsReportQuery,
  ): Promise<GroupDeadlineStatusCountsReportResponseDto> {
    const sql = buildGroupDeadlineStatusCountsSql(query);
    const result = await this.database.query<DeadlineStatusCountRow>(sql.text, sql.params);

    return {
      data: result.rows.map((row) => ({
        deadlineStatus: row.deadline_status,
        deadlineCount: Number(row.deadline_count),
      })),
      filter: query.responseFilter,
    };
  }
}

export class UnavailableGroupDeadlineStatusCountsReportRepository
  implements GroupDeadlineStatusCountsReportRepositoryPort
{
  async listDeadlineStatusCounts(): Promise<GroupDeadlineStatusCountsReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}
