import type { CurrentUser } from '../../../permissions/current-user';

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

export interface ProjectOrderRow {
  orderId: number;
  orderName: string;
  fullNumber: string;
  finalAmount: string | null;
  paidAmount: string | null;
  orderStatusName: string | null;
  deleteFlag: boolean;
}

export interface ProjectCard extends ProjectDto {
  orders: ProjectOrderRow[];
}

export interface ListProjectsQuery {
  search?: string;
  clientId?: number;
  includeArchived?: boolean;
}

export interface UpdateProjectDtoBody {
  code?: string;
  name?: string;
  notes?: string | null;
}

export interface MoveOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  targetProjectId?: number;
  createNew?: boolean;
  idempotencyKey: string;
  requestId?: string;
}

export interface MoveOrderResult {
  orderId: number;
  projectId: number;
  code: string;
  archivedSourceProjectId: number | null;
  auditId: number;
  requestId: string;
}

export interface MergeCommand {
  currentUser: CurrentUser;
  targetProjectId: number;
  sourceProjectId: number;
  idempotencyKey: string;
  requestId?: string;
}

export interface MergeResult {
  targetProjectId: number;
  sourceProjectId: number;
  movedOrdersCount: number;
  auditId: number;
  requestId: string;
}

export interface UpdateProjectCommand {
  currentUser: CurrentUser;
  projectId: number;
  dto: UpdateProjectDtoBody;
  expectedVersion: number;
  requestId?: string;
}

export interface ProjectsRepositoryPort {
  list(query: ListProjectsQuery): Promise<ProjectDto[]>;
  getById(projectId: number): Promise<ProjectCard>;
  update(command: UpdateProjectCommand): Promise<ProjectDto>;
  moveOrder(command: MoveOrderCommand): Promise<MoveOrderResult>;
  merge(command: MergeCommand): Promise<MergeResult>;
}
