import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { GroupStatus } from '../dto/group.dto';
import type { GroupOrderRelationType } from '../reporting/group-order-relation-counts-report.dto';
import { appendGroupReportPredicate, type GroupReportFilter } from '../reporting/group-report-predicates';
import type { GroupEntityTypeCode } from '../entity-links/group-entity-links.dto';
import {
  GROUP_OVERVIEW_OMITTED,
  type GroupOverviewQuery,
  type GroupOverviewResponseDto,
} from './group-overview.dto';

const GROUP_ORDER_RELATION_TYPES = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;

interface GroupOverviewInput {
  groupId: string;
  query: GroupOverviewQuery;
  visibleEntityTypes?: GroupEntityTypeCode[];
  canViewParticipants?: boolean;
}

interface GroupRow extends QueryResultRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: GroupStatus;
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
  entity_type_code: GroupEntityTypeCode;
  current_count: string | number;
}

interface ParticipantSummaryRow extends QueryResultRow {
  role_code: string;
  role_label: string;
  participant_count: string | number;
}

export interface GroupOverviewRepositoryPort {
  getOverview(input: GroupOverviewInput): Promise<GroupOverviewResponseDto>;
}

export class PgGroupOverviewRepository implements GroupOverviewRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async getOverview(input: GroupOverviewInput): Promise<GroupOverviewResponseDto> {
    const group = await this.getGroup(input.groupId);
    const predicateFilter = {
      mode: 'any',
      groupIds: [input.groupId],
      temporal: input.query.temporal,
    } as const satisfies GroupReportFilter;

    const [totalCount, statusCounts, relationCounts, createdMonthCounts, linkedEntityCounts, participantSummary] = await Promise.all([
      this.getTotalCount(predicateFilter),
      this.getStatusCounts(predicateFilter),
      this.getRelationCounts(predicateFilter, input.groupId),
      this.getCreatedMonthCounts(predicateFilter, input.query),
      this.getLinkedEntityCounts(input.groupId, input.visibleEntityTypes ?? []),
      input.canViewParticipants ? this.getParticipantSummary(input.groupId) : Promise.resolve([]),
    ]);

    return {
      group: {
        id: group.id,
        code: group.code,
        name: group.name,
        description: group.description,
        status: group.status,
        startsAt: toIsoOrNull(group.starts_at),
        endsAt: toIsoOrNull(group.ends_at),
        ownerUserId: group.owner_user_id === null ? null : Number(group.owner_user_id),
        createdAt: toIso(group.created_at),
        updatedAt: toIso(group.updated_at),
        archivedAt: toIsoOrNull(group.archived_at),
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
      filter: { groupId: input.groupId, ...input.query.filter },
      omitted: GROUP_OVERVIEW_OMITTED,
    };
  }

  private async getGroup(groupId: string): Promise<GroupRow> {
    const result = await this.database.query<GroupRow>(
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
      FROM public.group_groups
      WHERE id = $1::uuid
      `,
      [groupId],
    );
    const group = result.rows[0];
    if (!group) {
      throw new ApiError(404, 'GROUP_NOT_FOUND', 'Group not found', { groupId });
    }

    return group;
  }

  private async getTotalCount(filter: GroupReportFilter): Promise<number> {
    const params: unknown[] = [];
    const predicate = appendGroupReportPredicate({
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

  private async getStatusCounts(filter: GroupReportFilter): Promise<GroupOverviewResponseDto['orders']['statusCounts']> {
    const params: unknown[] = [];
    const predicate = appendGroupReportPredicate({
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
    filter: GroupReportFilter,
    groupId: string,
  ): Promise<GroupOverviewResponseDto['orders']['relationCounts']> {
    const params: unknown[] = [];
    const predicate = appendGroupReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter,
    });
    const relationGroupIdIndex = params.push(groupId);

    const result = await this.database.query<RelationCountRow>(
      `
      SELECT
        pop_relation.relation_type,
        pop_relation.is_primary,
        COUNT(DISTINCT o.order_id)::int AS order_count
      FROM public.orders o
      JOIN public.group_order_groups pop_relation ON pop_relation.order_id = o.order_id
      WHERE ${predicate}
        AND pop_relation.group_id = $${relationGroupIdIndex}::uuid
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
    filter: GroupReportFilter,
    query: GroupOverviewQuery,
  ): Promise<GroupOverviewResponseDto['orders']['createdMonthCounts']> {
    const params: unknown[] = [];
    const predicate = appendGroupReportPredicate({
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
    groupId: string,
    visibleEntityTypes: GroupEntityTypeCode[],
  ): Promise<GroupOverviewResponseDto['linkedEntityCounts']> {
    if (visibleEntityTypes.length === 0) return [];
    const result = await this.database.query<LinkedEntityCountRow>(
      `
      SELECT entity_type_code, COUNT(*)::int AS current_count
      FROM public.group_entity_links
      WHERE group_id = $1::uuid
        AND valid_to IS NULL
        AND entity_type_code = ANY($2::text[])
      GROUP BY entity_type_code
      ORDER BY entity_type_code ASC
      `,
      [groupId, visibleEntityTypes],
    );
    return result.rows.map((row) => ({
      entityType: row.entity_type_code,
      currentCount: Number(row.current_count),
    }));
  }

  private async getParticipantSummary(groupId: string): Promise<GroupOverviewResponseDto['participants']['currentSummary']> {
    const result = await this.database.query<ParticipantSummaryRow>(
      `
      SELECT pp.role_code, r.label AS role_label, COUNT(*)::int AS participant_count
      FROM public.group_participants pp
      INNER JOIN public.group_participant_roles r ON r.code = pp.role_code
      WHERE pp.group_id = $1::uuid
        AND pp.valid_to IS NULL
        AND r.is_active = true
      GROUP BY pp.role_code, r.label, r.sort_order
      ORDER BY r.sort_order ASC, pp.role_code ASC
      `,
      [groupId],
    );
    return result.rows.map((row) => ({
      roleCode: row.role_code,
      roleLabel: row.role_label,
      participantCount: Number(row.participant_count),
    }));
  }
}

export class UnavailableGroupOverviewRepository implements GroupOverviewRepositoryPort {
  async getOverview(): Promise<GroupOverviewResponseDto> {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
  }
}

function toRelationType(value: unknown): GroupOrderRelationType {
  if (typeof value === 'string' && GROUP_ORDER_RELATION_TYPES.includes(value as GroupOrderRelationType)) {
    return value as GroupOrderRelationType;
  }

  throw new ApiError(500, 'GROUP_OVERVIEW_RELATION_TYPE_INVALID', 'Unexpected group order relation type');
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
