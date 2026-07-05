import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { GroupOrderReportQuery, GroupOrderReportResponseDto } from './group-order-report.dto';
import { appendGroupReportPredicate } from './group-report-predicates';

interface CountRow extends QueryResultRow {
  total: string | number;
}

interface OrderRow extends QueryResultRow {
  order_id: string | number;
}

export interface GroupOrderReportRepositoryPort {
  listOrderIds(query: GroupOrderReportQuery): Promise<GroupOrderReportResponseDto>;
}

export class PgGroupOrderReportRepository implements GroupOrderReportRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listOrderIds(query: GroupOrderReportQuery): Promise<GroupOrderReportResponseDto> {
    const params: unknown[] = [];
    const predicate = appendGroupReportPredicate({
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

export class UnavailableGroupOrderReportRepository implements GroupOrderReportRepositoryPort {
  async listOrderIds(): Promise<GroupOrderReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}
