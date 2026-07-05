export type GroupStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';

export interface GroupDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: GroupStatus;
  startsAt: string | null;
  endsAt: string | null;
  ownerUserId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: number | null;
}

export interface GroupListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: GroupStatus;
  ownerUserId?: number;
  includeArchived?: boolean;
}

export interface GroupLookupQuery {
  search?: string;
  limit?: number;
}

type GroupOverviewCreatedRangeQuery = {
  createdFrom?: string;
  createdTo?: string;
};

export type GroupOverviewQuery =
  | ({ temporalMode?: 'current' } & GroupOverviewCreatedRangeQuery)
  | ({ temporalMode: 'asOf'; asOf: string } & GroupOverviewCreatedRangeQuery)
  | ({ temporalMode: 'overlap'; from: string; to: string } & GroupOverviewCreatedRangeQuery);

export interface GroupListResponse {
  data: GroupDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface GroupLookupItem {
  id: string;
  code: string;
  name: string;
  status: GroupStatus;
}

export interface GroupLookupResponse {
  data: GroupLookupItem[];
}

export interface GroupResponse {
  group: GroupDto;
}

export interface GroupOverviewResponse {
  group: Omit<GroupDto, 'metadata' | 'createdBy'>;
  orders: {
    totalCount: number;
    statusCounts: Array<{ statusId: number; statusName: string; orderCount: number }>;
    relationCounts: Array<{
      relationType: OrderGroupRelationType;
      isPrimary: boolean;
      orderCount: number;
    }>;
    createdMonthCounts: Array<{ month: string; orderCount: number }>;
  };
  linkedEntityCounts: Array<{
    entityType: GroupEntityTypeCode;
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
    groupId: string;
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

export interface CreateGroupRequest {
  code: string;
  name: string;
  description?: string | null;
  status?: GroupStatus;
  startsAt?: string | null;
  endsAt?: string | null;
  ownerUserId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateGroupRequest {
  code?: string;
  name?: string;
  description?: string | null;
  status?: GroupStatus;
  startsAt?: string | null;
  endsAt?: string | null;
  ownerUserId?: number | null;
  metadata?: Record<string, unknown>;
}

export type OrderGroupRelationType = 'main' | 'secondary' | 'reporting' | 'billing' | 'derived';

export interface GroupRef {
  id: string;
  code: string;
  name: string;
}

export interface EntityGroupLink extends GroupRef {
  relationType: OrderGroupRelationType;
  isPrimary: boolean;
  validFrom: string;
}

export interface OrderGroupsResponse {
  orderId: number;
  version: number;
  primaryGroup: EntityGroupLink | null;
  groups: EntityGroupLink[];
  requestId: string;
}

export interface ReplaceOrderGroupLink {
  groupId: string;
  relationType: OrderGroupRelationType;
  isPrimary: boolean;
}

export interface ReplaceOrderGroupsRequest {
  idempotencyKey: string;
  version: number;
  primaryGroupId?: string | null;
  groups: ReplaceOrderGroupLink[];
  reason?: string | null;
}

export interface ReplaceOrderGroupsResponse extends OrderGroupsResponse {
  changed: boolean;
  auditId?: string;
}

export type GroupEntityTypeCode =
  | 'order'
  | 'user'
  | 'employee'
  | 'client'
  | 'workshop'
  | 'deadline_instance';

export interface GroupEntityLinkDto {
  id: string;
  entityType: GroupEntityTypeCode;
  entityId: string;
  displayLabel: string | null;
  relationType: string;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface GroupEntityLinksResponse {
  groupId: string;
  links: GroupEntityLinkDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface ReplaceGroupEntityLink {
  entityType: GroupEntityTypeCode;
  entityId: string;
  relationType: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceGroupEntityLinksRequest {
  idempotencyKey: string;
  links: ReplaceGroupEntityLink[];
  reason?: string | null;
}

export interface GroupBatchLinkRequest {
  mode: 'dry-run' | 'write';
  writeIntent?: 'explicit-selected-ids';
  fixtureKey: string;
  idempotencyKey: string;
  entityType: GroupEntityTypeCode;
  relationType: string;
  source: {
    type: string;
    reference: string;
  };
  items: Array<{
    entityId: string;
    reason: string;
    confidence: string;
    sourceRow?: string;
  }>;
}

export interface GroupBatchLinkResponse {
  groupId: string;
  mode: 'dry-run' | 'write';
  summary: {
    proposed: number;
    created?: number;
    existing?: number;
    skipped: number;
    conflicts: number;
    sampledEvidenceRows: number;
  };
  proposals: Array<{
    entityType: GroupEntityTypeCode;
    entityId: string;
    action: 'link';
    source: string;
    confidence: string;
    reason: string;
  }>;
  created?: GroupBatchLinkResponse['proposals'];
  existing?: GroupBatchLinkResponse['proposals'];
  skipped: Array<{
    entityType: GroupEntityTypeCode;
    entityId: string;
    source: string;
    sourceRow: string | null;
    confidence: string;
    reasonCode: 'entity_not_found';
    reasonText: string;
    evidence: Record<string, unknown>;
  }>;
  sampleEvidence: Array<Record<string, unknown>>;
  changed?: boolean;
  auditId?: string | null;
  outboxEventId?: string | null;
  requestId?: string | null;
  writeEnabled: boolean;
}

export type GroupParticipantType = 'user' | 'employee';

export interface GroupParticipantRoleDto {
  code: string;
  label: string;
}

export interface GroupParticipantDto {
  id: string;
  participantType: GroupParticipantType;
  participantId: string | null;
  displayName: string | null;
  role: GroupParticipantRoleDto;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface GroupParticipantsResponse {
  groupId: string;
  participants: GroupParticipantDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface ReplaceGroupParticipant {
  participantType: GroupParticipantType;
  participantId: string;
  roleCode: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceGroupParticipantsRequest {
  idempotencyKey: string;
  participants: ReplaceGroupParticipant[];
  reason?: string | null;
}

export interface GroupParticipantRolesResponse {
  roles: GroupParticipantRoleDto[];
  requestId: string;
}

export type GroupDeadlineStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'overdue' | string;

export type GroupDeadlineStatusCountsQuery =
  | { groupMode: 'none'; temporalMode?: 'current' }
  | { groupMode: 'any' | 'all'; groupIds: string[]; temporalMode?: 'current' };

export interface GroupDeadlineStatusCountsResponse {
  data: Array<{
    deadlineStatus: GroupDeadlineStatus;
    deadlineCount: number;
  }>;
  filter:
    | { groupMode: 'none'; temporalMode: 'current' }
    | { groupMode: 'any' | 'all'; groupIds: string[]; temporalMode: 'current' };
}

export type ProjectStatus = GroupStatus;
export type ProjectDto = GroupDto;
export type ProjectListQuery = GroupListQuery;
export type ProjectLookupQuery = GroupLookupQuery;
export type ProjectOverviewQuery = GroupOverviewQuery;
export type ProjectListResponse = GroupListResponse;
export type ProjectLookupItem = GroupLookupItem;
export type ProjectLookupResponse = GroupLookupResponse;
export type CreateProjectRequest = CreateGroupRequest;
export type UpdateProjectRequest = UpdateGroupRequest;
export type OrderProjectRelationType = OrderGroupRelationType;
export type ProjectRef = GroupRef;
export type EntityProjectLink = EntityGroupLink;
export type ProjectEntityTypeCode = GroupEntityTypeCode;
export type ProjectEntityLinkDto = GroupEntityLinkDto;
export type ReplaceProjectEntityLink = ReplaceGroupEntityLink;
export type ProjectBatchLinkRequest = GroupBatchLinkRequest;
export type ProjectParticipantType = GroupParticipantType;
export type ProjectParticipantRoleDto = GroupParticipantRoleDto;
export type ProjectParticipantDto = GroupParticipantDto;
export type ReplaceProjectParticipant = ReplaceGroupParticipant;
export type ProjectParticipantRolesResponse = GroupParticipantRolesResponse;
export type ProjectDeadlineStatus = GroupDeadlineStatus;

export interface ProjectResponse {
  project: ProjectDto;
}

export interface ProjectOverviewResponse extends Omit<GroupOverviewResponse, 'group' | 'filter'> {
  project: GroupOverviewResponse['group'];
  filter: {
    projectId: string;
    temporalMode: 'current' | 'asOf' | 'overlap';
    asOf?: string;
    from?: string;
    to?: string;
    createdFrom?: string;
    createdTo?: string;
  };
}

export interface OrderProjectsResponse extends Omit<OrderGroupsResponse, 'primaryGroup' | 'groups'> {
  primaryProject: EntityProjectLink | null;
  projects: EntityProjectLink[];
}

export interface ReplaceOrderProjectLink extends Omit<ReplaceOrderGroupLink, 'groupId'> {
  projectId: string;
}

export interface ReplaceOrderProjectsRequest extends Omit<ReplaceOrderGroupsRequest, 'primaryGroupId' | 'groups'> {
  primaryProjectId?: string | null;
  projects: ReplaceOrderProjectLink[];
}

export interface ReplaceOrderProjectsResponse extends OrderProjectsResponse {
  changed: boolean;
  auditId?: string;
}

export interface ProjectEntityLinksResponse extends Omit<GroupEntityLinksResponse, 'groupId'> {
  projectId: string;
}

export interface ReplaceProjectEntityLinksRequest extends Omit<ReplaceGroupEntityLinksRequest, 'links'> {
  links: ReplaceProjectEntityLink[];
}

export interface ProjectBatchLinkResponse extends Omit<GroupBatchLinkResponse, 'groupId'> {
  projectId: string;
}

export interface ProjectParticipantsResponse extends Omit<GroupParticipantsResponse, 'groupId'> {
  projectId: string;
}

export interface ReplaceProjectParticipantsRequest extends Omit<ReplaceGroupParticipantsRequest, 'participants'> {
  participants: ReplaceProjectParticipant[];
}

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
