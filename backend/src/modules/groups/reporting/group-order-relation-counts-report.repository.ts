import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  GroupOrderRelationCountsReportQuery,
  GroupOrderRelationCountsReportResponseDto,
  GroupOrderRelationType,
} from './group-order-relation-counts-report.dto';
import { appendGroupReportPredicate } from './group-report-predicates';

const GROUP_ORDER_RELATION_TYPES = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;

interface RelationCountRow extends QueryResultRow {
  relation_type: unknown;
  is_primary: unknown;
  order_count: string | number;
}

export interface GroupOrderRelationCountsReportRepositoryPort {
  listOrderRelationCounts(
    query: GroupOrderRelationCountsReportQuery,
  ): Promise<GroupOrderRelationCountsReportResponseDto>;
}

export class PgGroupOrderRelationCountsReportRepository implements GroupOrderRelationCountsReportRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listOrderRelationCounts(
    query: GroupOrderRelationCountsReportQuery,
  ): Promise<GroupOrderRelationCountsReportResponseDto> {
    const params: unknown[] = [];
    const predicate = appendGroupReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: query.predicateFilter,
    });

    const result = await this.database.query<RelationCountRow>(
      `
      SELECT
        pop_relation.relation_type,
        pop_relation.is_primary,
        COUNT(DISTINCT o.order_id)::int AS order_count
      FROM public.orders o
      JOIN public.group_order_groups pop_relation ON pop_relation.order_id = o.order_id
      WHERE ${predicate}
        AND pop_relation.valid_to IS NULL
      GROUP BY pop_relation.relation_type, pop_relation.is_primary
      ORDER BY pop_relation.relation_type ASC, pop_relation.is_primary DESC
      `,
      params,
    );

    return {
      data: result.rows.map((row) => ({
        relationType: toRelationType(row.relation_type),
        isPrimary: Boolean(row.is_primary),
        orderCount: Number(row.order_count),
      })),
      filter: query.responseFilter,
    };
  }
}

export class UnavailableGroupOrderRelationCountsReportRepository
  implements GroupOrderRelationCountsReportRepositoryPort
{
  async listOrderRelationCounts(): Promise<GroupOrderRelationCountsReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}

function toRelationType(value: unknown): GroupOrderRelationType {
  if (typeof value === 'string' && GROUP_ORDER_RELATION_TYPES.includes(value as GroupOrderRelationType)) {
    return value as GroupOrderRelationType;
  }

  throw new ApiError(500, 'GROUP_REPORT_RELATION_TYPE_INVALID', 'Unexpected group order relation type');
}
