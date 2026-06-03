import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type {
  ProjectOrderRelationCountsReportQuery,
  ProjectOrderRelationCountsReportResponseDto,
  ProjectOrderRelationType,
} from './project-order-relation-counts-report.dto';
import { appendProjectReportPredicate } from './project-report-predicates';

const PROJECT_ORDER_RELATION_TYPES = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;

interface RelationCountRow extends QueryResultRow {
  relation_type: unknown;
  is_primary: unknown;
  order_count: string | number;
}

export interface ProjectOrderRelationCountsReportRepositoryPort {
  listOrderRelationCounts(
    query: ProjectOrderRelationCountsReportQuery,
  ): Promise<ProjectOrderRelationCountsReportResponseDto>;
}

export class PgProjectOrderRelationCountsReportRepository implements ProjectOrderRelationCountsReportRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listOrderRelationCounts(
    query: ProjectOrderRelationCountsReportQuery,
  ): Promise<ProjectOrderRelationCountsReportResponseDto> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
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
      JOIN public.project_order_projects pop_relation ON pop_relation.order_id = o.order_id
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

export class UnavailableProjectOrderRelationCountsReportRepository
  implements ProjectOrderRelationCountsReportRepositoryPort
{
  async listOrderRelationCounts(): Promise<ProjectOrderRelationCountsReportResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}

function toRelationType(value: unknown): ProjectOrderRelationType {
  if (typeof value === 'string' && PROJECT_ORDER_RELATION_TYPES.includes(value as ProjectOrderRelationType)) {
    return value as ProjectOrderRelationType;
  }

  throw new ApiError(500, 'PROJECT_REPORT_RELATION_TYPE_INVALID', 'Unexpected project order relation type');
}
