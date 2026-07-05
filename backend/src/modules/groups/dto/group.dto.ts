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
  page: number;
  pageSize: number;
  search?: string;
  status?: GroupStatus;
  ownerUserId?: number;
  includeArchived?: boolean;
}

export interface GroupListResponseDto {
  data: GroupDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface GroupLookupItemDto {
  id: string;
  code: string;
  name: string;
  status: GroupStatus;
}

export interface GroupLookupResponseDto {
  data: GroupLookupItemDto[];
}

export interface GroupResponseDto {
  group: GroupDto;
}

export interface GroupMemberDto {
  id: string;
  userId: number;
  username: string;
  employeeId: number | null;
  displayName: string | null;
  role: string;
  validFrom: string;
  metadata: Record<string, unknown>;
}

export interface ReplaceGroupMemberDto {
  userId: number;
  role: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceGroupMembersRequestDto {
  idempotencyKey: string;
  members: ReplaceGroupMemberDto[];
  reason?: string | null;
}

export interface GroupMembersResponseDto {
  groupId: string;
  members: GroupMemberDto[];
  requestId: string;
  changed?: boolean;
  auditId?: string;
}

export interface CreateGroupRequestDto {
  code: string;
  name: string;
  description?: string | null;
  status?: GroupStatus;
  startsAt?: string | null;
  endsAt?: string | null;
  ownerUserId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateGroupRequestDto {
  code?: string;
  name?: string;
  description?: string | null;
  status?: GroupStatus;
  startsAt?: string | null;
  endsAt?: string | null;
  ownerUserId?: number | null;
  metadata?: Record<string, unknown>;
}
