import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  ProjectOrderStatusReportQuery,
  ProjectOrderStatusReportResponseDto,
} from './project-order-status-report.dto';
import { appendProjectReportPredicate } from './project-report-predicates';

interface StatusCountRow extends QueryResultRow {
  status_id: string | number;
  status_name: string;
  order_count: string | number;
}

export interface ProjectOrderStatusReportRepositoryPort {
  listOrderStatusCounts(query: ProjectOrderStatusReportQuery): Promise<ProjectOrderStatusReportResponseDto>;
}

export class PgProjectOrderStatusReportRepository implements ProjectOrderStatusReportRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listOrderStatusCounts(query: ProjectOrderStatusReportQuery): Promise<ProjectOrderStatusReportResponseDto> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: query.predicateFilter,
    });

    const result = await this.database.query<StatusCountRow>(
      `
      SELECT
        os.order_status_id AS status_id,
        os.order_status_name AS status_name,
        COUNT(*)::int AS order_count
      FROM public.orders o
      JOIN public.order_statuses os ON os.order_status_id = o.order_status_id
      WHERE ${predicate}
      GROUP BY os.order_status_id, os.order_status_name, os.sort_order
      ORDER BY os.sort_order ASC NULLS LAST, os.order_status_id ASC
      `,
      params,
    );

    return {
      data: result.rows.map((row) => ({
        statusId: Number(row.status_id),
        statusName: row.status_name,
        orderCount: Number(row.order_count),
      })),
      filter: query.responseFilter,
    };
  }
}

export class UnavailableProjectOrderStatusReportRepository implements ProjectOrderStatusReportRepositoryPort {
  async listOrderStatusCounts(): Promise<ProjectOrderStatusReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}
