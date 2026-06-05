import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { ProjectStatus } from '../dto/project.dto';
import type { ProjectOrderRelationType } from '../reporting/project-order-relation-counts-report.dto';
import { appendProjectReportPredicate, type ProjectReportFilter } from '../reporting/project-report-predicates';
import type { ProjectEntityTypeCode } from '../entity-links/project-entity-links.dto';
import {
  PROJECT_OVERVIEW_OMITTED,
  type ProjectOverviewQuery,
  type ProjectOverviewResponseDto,
} from './project-overview.dto';

const PROJECT_ORDER_RELATION_TYPES = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;

interface ProjectOverviewInput {
  projectId: string;
  query: ProjectOverviewQuery;
  visibleEntityTypes?: ProjectEntityTypeCode[];
  canViewParticipants?: boolean;
}

interface ProjectRow extends QueryResultRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  starts_at: unknown;
  ends_at: unknown;
  owner_user_id: string | number | null;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
}

interface TotalCountRow extends QueryResultRow {
  total_count: string | number;
}

interface StatusCountRow extends QueryResultRow {
  status_id: string | number;
  status_name: string;
  order_count: string | number;
}

interface RelationCountRow extends QueryResultRow {
  relation_type: unknown;
  is_primary: unknown;
  order_count: string | number;
}

interface OrderCreatedMonthCountRow extends QueryResultRow {
  month: string;
  order_count: string | number;
}

interface LinkedEntityCountRow extends QueryResultRow {
  entity_type_code: ProjectEntityTypeCode;
  current_count: string | number;
}

interface ParticipantSummaryRow extends QueryResultRow {
  role_code: string;
  role_label: string;
  participant_count: string | number;
}

export interface ProjectOverviewRepositoryPort {
  getOverview(input: ProjectOverviewInput): Promise<ProjectOverviewResponseDto>;
}

export class PgProjectOverviewRepository implements ProjectOverviewRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async getOverview(input: ProjectOverviewInput): Promise<ProjectOverviewResponseDto> {
    const project = await this.getProject(input.projectId);
    const predicateFilter = {
      mode: 'any',
      projectIds: [input.projectId],
      temporal: input.query.temporal,
    } as const satisfies ProjectReportFilter;

    const [totalCount, statusCounts, relationCounts, createdMonthCounts, linkedEntityCounts, participantSummary] = await Promise.all([
      this.getTotalCount(predicateFilter),
      this.getStatusCounts(predicateFilter),
      this.getRelationCounts(predicateFilter, input.projectId),
      this.getCreatedMonthCounts(predicateFilter, input.query),
      this.getLinkedEntityCounts(input.projectId, input.visibleEntityTypes ?? []),
      input.canViewParticipants ? this.getParticipantSummary(input.projectId) : Promise.resolve([]),
    ]);

    return {
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        description: project.description,
        status: project.status,
        startsAt: toIsoOrNull(project.starts_at),
        endsAt: toIsoOrNull(project.ends_at),
        ownerUserId: project.owner_user_id === null ? null : Number(project.owner_user_id),
        createdAt: toIso(project.created_at),
        updatedAt: toIso(project.updated_at),
        archivedAt: toIsoOrNull(project.archived_at),
      },
      orders: {
        totalCount,
        statusCounts,
        relationCounts,
        createdMonthCounts,
      },
      linkedEntityCounts,
      participants: {
        currentSummary: participantSummary,
      },
      filter: { projectId: input.projectId, ...input.query.filter },
      omitted: PROJECT_OVERVIEW_OMITTED,
    };
  }

  private async getProject(projectId: string): Promise<ProjectRow> {
    const result = await this.database.query<ProjectRow>(
      `
      SELECT
        id,
        code,
        name,
        description,
        status,
        starts_at,
        ends_at,
        owner_user_id,
        created_at,
        updated_at,
        archived_at
      FROM public.project_projects
      WHERE id = $1::uuid
      `,
      [projectId],
    );
    const project = result.rows[0];
    if (!project) {
      throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
    }

    return project;
  }

  private async getTotalCount(filter: ProjectReportFilter): Promise<number> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter,
    });

    const result = await this.database.query<TotalCountRow>(
      `
      SELECT COUNT(*)::int AS total_count
      FROM public.orders o
      WHERE ${predicate}
      `,
      params,
    );

    return Number(result.rows[0]?.total_count ?? 0);
  }

  private async getStatusCounts(filter: ProjectReportFilter): Promise<ProjectOverviewResponseDto['orders']['statusCounts']> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter,
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

    return result.rows.map((row) => ({
      statusId: Number(row.status_id),
      statusName: row.status_name,
      orderCount: Number(row.order_count),
    }));
  }

  private async getRelationCounts(
    filter: ProjectReportFilter,
    projectId: string,
  ): Promise<ProjectOverviewResponseDto['orders']['relationCounts']> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter,
    });
    const relationProjectIdIndex = params.push(projectId);

    const result = await this.database.query<RelationCountRow>(
      `
      SELECT
        pop_relation.relation_type,
        pop_relation.is_primary,
        COUNT(DISTINCT o.order_id)::int AS order_count
      FROM public.orders o
      JOIN public.project_order_projects pop_relation ON pop_relation.order_id = o.order_id
      WHERE ${predicate}
        AND pop_relation.project_id = $${relationProjectIdIndex}::uuid
        AND pop_relation.valid_to IS NULL
      GROUP BY pop_relation.relation_type, pop_relation.is_primary
      ORDER BY pop_relation.relation_type ASC, pop_relation.is_primary DESC
      `,
      params,
    );

    return result.rows.map((row) => ({
      relationType: toRelationType(row.relation_type),
      isPrimary: Boolean(row.is_primary),
      orderCount: Number(row.order_count),
    }));
  }

  private async getCreatedMonthCounts(
    filter: ProjectReportFilter,
    query: ProjectOverviewQuery,
  ): Promise<ProjectOverviewResponseDto['orders']['createdMonthCounts']> {
    const params: unknown[] = [];
    const predicate = appendProjectReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter,
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

    return result.rows.map((row) => ({
      month: row.month,
      orderCount: Number(row.order_count),
    }));
  }

  private async getLinkedEntityCounts(
    projectId: string,
    visibleEntityTypes: ProjectEntityTypeCode[],
  ): Promise<ProjectOverviewResponseDto['linkedEntityCounts']> {
    if (visibleEntityTypes.length === 0) return [];
    const result = await this.database.query<LinkedEntityCountRow>(
      `
      SELECT entity_type_code, COUNT(*)::int AS current_count
      FROM public.project_entity_links
      WHERE project_id = $1::uuid
        AND valid_to IS NULL
        AND entity_type_code = ANY($2::text[])
      GROUP BY entity_type_code
      ORDER BY entity_type_code ASC
      `,
      [projectId, visibleEntityTypes],
    );
    return result.rows.map((row) => ({
      entityType: row.entity_type_code,
      currentCount: Number(row.current_count),
    }));
  }

  private async getParticipantSummary(projectId: string): Promise<ProjectOverviewResponseDto['participants']['currentSummary']> {
    const result = await this.database.query<ParticipantSummaryRow>(
      `
      SELECT pp.role_code, r.label AS role_label, COUNT(*)::int AS participant_count
      FROM public.project_participants pp
      INNER JOIN public.project_participant_roles r ON r.code = pp.role_code
      WHERE pp.project_id = $1::uuid
        AND pp.valid_to IS NULL
        AND r.is_active = true
      GROUP BY pp.role_code, r.label, r.sort_order
      ORDER BY r.sort_order ASC, pp.role_code ASC
      `,
      [projectId],
    );
    return result.rows.map((row) => ({
      roleCode: row.role_code,
      roleLabel: row.role_label,
      participantCount: Number(row.participant_count),
    }));
  }
}

export class UnavailableProjectOverviewRepository implements ProjectOverviewRepositoryPort {
  async getOverview(): Promise<ProjectOverviewResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}

function toRelationType(value: unknown): ProjectOrderRelationType {
  if (typeof value === 'string' && PROJECT_ORDER_RELATION_TYPES.includes(value as ProjectOrderRelationType)) {
    return value as ProjectOrderRelationType;
  }

  throw new ApiError(500, 'PROJECT_OVERVIEW_RELATION_TYPE_INVALID', 'Unexpected project order relation type');
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
