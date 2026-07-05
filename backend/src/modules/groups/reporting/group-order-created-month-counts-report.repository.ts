import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  GroupOrderCreatedMonthCountsReportQuery,
  GroupOrderCreatedMonthCountsReportResponseDto,
} from './group-order-created-month-counts-report.dto';
import { appendGroupReportPredicate } from './group-report-predicates';

interface OrderCreatedMonthCountRow extends QueryResultRow {
  month: string;
  order_count: string | number;
}

export interface GroupOrderCreatedMonthCountsReportRepositoryPort {
  listOrderCreatedMonthCounts(
    query: GroupOrderCreatedMonthCountsReportQuery,
  ): Promise<GroupOrderCreatedMonthCountsReportResponseDto>;
}

export class PgGroupOrderCreatedMonthCountsReportRepository
  implements GroupOrderCreatedMonthCountsReportRepositoryPort
{
  constructor(private readonly database: DatabaseClient) {}

  async listOrderCreatedMonthCounts(
    query: GroupOrderCreatedMonthCountsReportQuery,
  ): Promise<GroupOrderCreatedMonthCountsReportResponseDto> {
    const params: unknown[] = [];
    const predicate = appendGroupReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: query.predicateFilter,
    });
    const createdFromIndex = query.createdRange.from ? params.push(query.createdRange.from) : undefined;
    const createdToIndex = query.createdRange.to ? params.push(query.createdRange.to) : undefined;

    const monthBucketExpression = "date_trunc('month', o.created_at AT TIME ZONE 'UTC')";

    const result = await this.database.query<OrderCreatedMonthCountRow>(
      `
      SELECT
        to_char(${monthBucketExpression}, 'YYYY-MM-01') AS month,
        COUNT(*)::int AS order_count
      FROM public.orders o
      WHERE ${predicate}
        ${createdFromIndex ? `AND o.created_at >= $${createdFromIndex}::timestamptz` : ''}
        ${createdToIndex ? `AND o.created_at < $${createdToIndex}::timestamptz` : ''}
      GROUP BY ${monthBucketExpression}
      ORDER BY ${monthBucketExpression} ASC
      `,
      params,
    );

    return {
      data: result.rows.map((row) => ({
        month: row.month,
        orderCount: Number(row.order_count),
      })),
      filter: query.responseFilter,
    };
  }
}

export class UnavailableGroupOrderCreatedMonthCountsReportRepository
  implements GroupOrderCreatedMonthCountsReportRepositoryPort
{
  async listOrderCreatedMonthCounts(): Promise<GroupOrderCreatedMonthCountsReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}
