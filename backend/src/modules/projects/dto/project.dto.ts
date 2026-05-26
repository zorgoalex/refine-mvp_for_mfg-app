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
  page: number;
  pageSize: number;
  search?: string;
  status?: ProjectStatus;
  ownerUserId?: number;
  includeArchived?: boolean;
}

export interface ProjectListResponseDto {
  data: ProjectDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ProjectLookupItemDto {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
}

export interface ProjectLookupResponseDto {
  data: ProjectLookupItemDto[];
}

export interface ProjectResponseDto {
  project: ProjectDto;
}
