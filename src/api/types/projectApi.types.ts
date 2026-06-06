export type ProjectStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';

export interface ProjectDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  startsAt: string | null;
  endsAt: string | null;
  ownerUserId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: number | null;
}

export interface ProjectListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: ProjectStatus;
  ownerUserId?: number;
  includeArchived?: boolean;
}

export interface ProjectLookupQuery {
  search?: string;
  limit?: number;
}

type ProjectOverviewCreatedRangeQuery = {
  createdFrom?: string;
  createdTo?: string;
};

export type ProjectOverviewQuery =
  | ({ temporalMode?: 'current' } & ProjectOverviewCreatedRangeQuery)
  | ({ temporalMode: 'asOf'; asOf: string } & ProjectOverviewCreatedRangeQuery)
  | ({ temporalMode: 'overlap'; from: string; to: string } & ProjectOverviewCreatedRangeQuery);

export interface ProjectListResponse {
  data: ProjectDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ProjectLookupItem {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
}

export interface ProjectLookupResponse {
  data: ProjectLookupItem[];
}

export interface ProjectResponse {
  project: ProjectDto;
}

export interface ProjectOverviewResponse {
  project: Omit<ProjectDto, 'metadata' | 'createdBy'>;
  orders: {
    totalCount: number;
    statusCounts: Array<{ statusId: number; statusName: string; orderCount: number }>;
    relationCounts: Array<{
      relationType: OrderProjectRelationType;
      isPrimary: boolean;
      orderCount: number;
    }>;
    createdMonthCounts: Array<{ month: string; orderCount: number }>;
  };
  linkedEntityCounts: Array<{
    entityType: ProjectEntityTypeCode;
    currentCount: number;
  }>;
  participants: {
    currentSummary: Array<{
      roleCode: string;
      roleLabel: string;
      participantCount: number;
    }>;
  };
  filter: {
    projectId: string;
    temporalMode: 'current' | 'asOf' | 'overlap';
    asOf?: string;
    from?: string;
    to?: string;
    createdFrom?: string;
    createdTo?: string;
  };
  omitted: Array<
    | 'finance'
    | 'payments'
    | 'clientPhones'
    | 'audit'
    | 'deadline'
    | 'production'
    | 'members'
    | 'users'
    | 'orderDetails'
    | 'activityTimeline'
  >;
}

export interface CreateProjectRequest {
  code: string;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  startsAt?: string | null;
  endsAt?: string | null;
  ownerUserId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateProjectRequest {
  code?: string;
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  startsAt?: string | null;
  endsAt?: string | null;
  ownerUserId?: number | null;
  metadata?: Record<string, unknown>;
}

export type OrderProjectRelationType = 'main' | 'secondary' | 'reporting' | 'billing' | 'derived';

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
}

export interface EntityProjectLink extends ProjectRef {
  relationType: OrderProjectRelationType;
  isPrimary: boolean;
  validFrom: string;
}

export interface OrderProjectsResponse {
  orderId: number;
  version: number;
  primaryProject: EntityProjectLink | null;
  projects: EntityProjectLink[];
  requestId: string;
}

export interface ReplaceOrderProjectLink {
  projectId: string;
  relationType: OrderProjectRelationType;
  isPrimary: boolean;
}

export interface ReplaceOrderProjectsRequest {
  idempotencyKey: string;
  version: number;
  primaryProjectId?: string | null;
  projects: ReplaceOrderProjectLink[];
  reason?: string | null;
}

export interface ReplaceOrderProjectsResponse extends OrderProjectsResponse {
  changed: boolean;
  auditId?: string;
}

export type ProjectEntityTypeCode =
  | 'order'
  | 'user'
  | 'employee'
  | 'client'
  | 'workshop'
  | 'deadline_instance';

export interface ProjectEntityLinkDto {
  id: string;
  entityType: ProjectEntityTypeCode;
  entityId: string;
  displayLabel: string | null;
  relationType: string;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface ProjectEntityLinksResponse {
  projectId: string;
  links: ProjectEntityLinkDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface ReplaceProjectEntityLink {
  entityType: ProjectEntityTypeCode;
  entityId: string;
  relationType: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceProjectEntityLinksRequest {
  idempotencyKey: string;
  links: ReplaceProjectEntityLink[];
  reason?: string | null;
}

export type ProjectParticipantType = 'user' | 'employee';

export interface ProjectParticipantRoleDto {
  code: string;
  label: string;
}

export interface ProjectParticipantDto {
  id: string;
  participantType: ProjectParticipantType;
  participantId: string | null;
  displayName: string | null;
  role: ProjectParticipantRoleDto;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface ProjectParticipantsResponse {
  projectId: string;
  participants: ProjectParticipantDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface ReplaceProjectParticipant {
  participantType: ProjectParticipantType;
  participantId: string;
  roleCode: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceProjectParticipantsRequest {
  idempotencyKey: string;
  participants: ReplaceProjectParticipant[];
  reason?: string | null;
}

export interface ProjectParticipantRolesResponse {
  roles: ProjectParticipantRoleDto[];
  requestId: string;
}

export type ProjectDeadlineStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'overdue' | string;

export type ProjectDeadlineStatusCountsQuery =
  | { projectMode: 'none'; temporalMode?: 'current' }
  | { projectMode: 'any' | 'all'; projectIds: string[]; temporalMode?: 'current' };

export interface ProjectDeadlineStatusCountsResponse {
  data: Array<{
    deadlineStatus: ProjectDeadlineStatus;
    deadlineCount: number;
  }>;
  filter:
    | { projectMode: 'none'; temporalMode: 'current' }
    | { projectMode: 'any' | 'all'; projectIds: string[]; temporalMode: 'current' };
}
