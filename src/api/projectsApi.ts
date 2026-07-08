import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { validateOrderId, withQuery } from './ordersApi';

export interface ProjectDto {
  projectId: number;
  code: string;
  name: string;
  clientId: number;
  clientName?: string;
  notes: string | null;
  version: number;
  ordersCount?: number;
  totalFinalAmount?: string;
  totalPaidAmount?: string;
}

export interface ProjectOrderSummary {
  orderId: number;
  orderName: string;
  fullNumber: string;
  finalAmount: string | null;
  paidAmount: string | null;
  orderStatusName: string | null;
  deleteFlag: boolean;
}

export interface ProjectCard extends ProjectDto {
  orders: ProjectOrderSummary[];
}

export interface MoveOrderResult {
  orderId: number;
  projectId: number;
  code: string;
  archivedSourceProjectId: number | null;
  auditId: number;
  requestId: string;
}

export interface MergeResult {
  targetProjectId: number;
  sourceProjectId: number;
  movedOrdersCount: number;
  auditId: number;
  requestId: string;
}

export interface ListProjectsParams {
  search?: string;
  clientId?: number;
}

export interface UpdateProjectRequest {
  code?: string;
  name?: string;
  notes?: string | null;
  expectedVersion: number;
}

export interface MoveOrderRequest {
  targetProjectId?: number;
  createNew?: boolean;
  idempotencyKey: string;
}

export interface MergeProjectsRequest {
  sourceProjectId: number;
  idempotencyKey: string;
}

export const projectsApi = {
  list(params: ListProjectsParams = {}): Promise<ProjectDto[]> {
    return httpClient.get<ProjectDto[]>(withQuery(apiRoutes.projects.list, params));
  },

  getById(projectId: number): Promise<ProjectCard> {
    return httpClient.get<ProjectCard>(apiRoutes.projects.byId(validateProjectId(projectId)));
  },

  update(projectId: number, dto: UpdateProjectRequest): Promise<ProjectDto> {
    return httpClient.patch<ProjectDto>(
      apiRoutes.projects.byId(validateProjectId(projectId)),
      dto,
    );
  },

  move(orderId: number, dto: MoveOrderRequest): Promise<MoveOrderResult> {
    return httpClient.post<MoveOrderResult>(
      apiRoutes.projects.moveOrder(validateOrderId(orderId)),
      dto,
    );
  },

  merge(projectId: number, dto: MergeProjectsRequest): Promise<MergeResult> {
    return httpClient.post<MergeResult>(
      apiRoutes.projects.merge(validateProjectId(projectId)),
      dto,
    );
  },
};

function validateProjectId(projectId: number): number {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new Error('Invalid projectId');
  }

  return projectId;
}
