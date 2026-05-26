import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { PermissionsService } from '../../permissions/permissions.service';
import type {
  ProjectDto,
  ProjectListQuery,
  ProjectListResponseDto,
  ProjectLookupResponseDto,
} from './dto/project.dto';

export interface ProjectLookupQuery {
  search?: string;
  limit: number;
}

export interface ProjectRepositoryPort {
  listProjects(query: ProjectListQuery): Promise<ProjectListResponseDto>;
  lookupProjects(query: ProjectLookupQuery): Promise<ProjectLookupResponseDto>;
  getProjectById(projectId: string): Promise<ProjectDto | null>;
}

export interface ProjectsServicePorts {
  projects: ProjectRepositoryPort;
  permissions?: PermissionsService;
}

export interface ListProjectsCommand {
  currentUser: CurrentUser;
  query: ProjectListQuery;
  requestId?: string;
}

export interface LookupProjectsCommand {
  currentUser: CurrentUser;
  query: ProjectLookupQuery;
  requestId?: string;
}

export interface GetProjectByIdCommand {
  currentUser: CurrentUser;
  projectId: string;
  requestId?: string;
}

export class ProjectsService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProjectsServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListProjectsCommand): Promise<ProjectListResponseDto> {
    this.requireView(command.currentUser);
    return this.ports.projects.listProjects(command.query);
  }

  async lookup(command: LookupProjectsCommand): Promise<ProjectLookupResponseDto> {
    this.requireView(command.currentUser);
    return this.ports.projects.lookupProjects(command.query);
  }

  async getById(command: GetProjectByIdCommand): Promise<ProjectDto> {
    this.requireView(command.currentUser);

    const project = await this.ports.projects.getProjectById(command.projectId);
    if (!project) {
      throw new ProjectNotFoundError(command.projectId);
    }

    return project;
  }

  private requireView(currentUser: CurrentUser): void {
    if (!this.permissions.canUser(currentUser, 'projects.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['projects.view'],
      });
    }
  }
}

export class ProjectNotFoundError extends ApiError {
  constructor(projectId: string) {
    super(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
  }
}
