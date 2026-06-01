import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { ProjectOrderReportQuery, ProjectOrderReportResponseDto } from './project-order-report.dto';
import { appendProjectReportPredicate } from './project-report-predicates';

interface CountRow extends QueryResultRow {
  total: string | number;
}

interface OrderRow extends QueryResultRow {
  order_id: string | number;
}

export interface ProjectOrderReportRepositoryPort {
  listOrderIds(query: ProjectOrderReportQuery): Promise<ProjectOrderReportResponseDto>;
}

export class PgProjectOrderReportRepository implements ProjectOrderReportRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listOrderIds(query: ProjectOrderReportQuery): Promise<ProjectOrderReportResponseDto> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: query.filter,
    });
    const where = `WHERE ${predicate}`;

    const countResult = await this.database.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM public.orders o
      ${where}
      `,
      [...params],
    );

    const limitIndex = params.push(query.pageSize);
    const offsetIndex = params.push((query.page - 1) * query.pageSize);
    const ordersResult = await this.database.query<OrderRow>(
      `
      SELECT o.order_id
      FROM public.orders o
      ${where}
      ORDER BY o.order_id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    return {
      data: ordersResult.rows.map((row) => ({ orderId: Number(row.order_id) })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
      filter: query.filter,
    };
  }
}

export class UnavailableProjectOrderReportRepository implements ProjectOrderReportRepositoryPort {
  async listOrderIds(): Promise<ProjectOrderReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}
