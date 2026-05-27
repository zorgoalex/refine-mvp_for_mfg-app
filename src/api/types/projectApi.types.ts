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
