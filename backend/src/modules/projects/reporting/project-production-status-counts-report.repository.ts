import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  ProjectProductionStatusCountsReportQuery,
  ProjectProductionStatusCountsReportResponseDto,
} from './project-production-status-counts-report.dto';
import { appendProjectReportPredicate } from './project-report-predicates';

interface ProductionStatusCountRow extends QueryResultRow {
  production_status_id: string | number | null;
  production_status_code: string | null;
  production_status_name: string;
  order_count: string | number;
}

export interface ProjectProductionStatusCountsReportRepositoryPort {
  listProductionStatusCounts(
    query: ProjectProductionStatusCountsReportQuery,
  ): Promise<ProjectProductionStatusCountsReportResponseDto>;
}

export class PgProjectProductionStatusCountsReportRepository
  implements ProjectProductionStatusCountsReportRepositoryPort
{
  constructor(private readonly database: DatabaseClient) {}

  async listProductionStatusCounts(
    query: ProjectProductionStatusCountsReportQuery,
  ): Promise<ProjectProductionStatusCountsReportResponseDto> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: query.predicateFilter,
    });

    const result = await this.database.query<ProductionStatusCountRow>(
      `
      SELECT
        ps.production_status_id,
        ps.production_status_code,
        COALESCE(ps.production_status_name, 'Без статуса') AS production_status_name,
        COUNT(*)::int AS order_count
      FROM public.orders o
      LEFT JOIN public.production_statuses ps ON ps.production_status_id = o.production_status_id
      WHERE ${predicate}
      GROUP BY ps.production_status_id, ps.production_status_code, ps.production_status_name, ps.sort_order
      ORDER BY ps.sort_order ASC NULLS LAST, ps.production_status_id ASC
      `,
      params,
    );

    return {
      data: result.rows.map((row) => ({
        productionStatusId:
          row.production_status_id === null || row.production_status_id === undefined
            ? null
            : Number(row.production_status_id),
        productionStatusCode: row.production_status_code,
        productionStatusName: row.production_status_name,
        orderCount: Number(row.order_count),
      })),
      filter: query.responseFilter,
    };
  }
}

export class UnavailableProjectProductionStatusCountsReportRepository
  implements ProjectProductionStatusCountsReportRepositoryPort
{
  async listProductionStatusCounts(): Promise<ProjectProductionStatusCountsReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}
