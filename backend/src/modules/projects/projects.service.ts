import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { PermissionsService } from '../../permissions/permissions.service';
import type {
  CreateProjectRequestDto,
  ProjectMembersResponseDto,
  ProjectDto,
  ProjectListQuery,
  ProjectListResponseDto,
  ProjectLookupResponseDto,
  ReplaceProjectMembersRequestDto,
  UpdateProjectRequestDto,
} from './dto/project.dto';
import type { PermissionName } from '../../permissions/permissions';

export interface ProjectLookupQuery {
  search?: string;
  limit: number;
}

export interface ProjectRepositoryPort {
  listProjects(query: ProjectListQuery): Promise<ProjectListResponseDto>;
  lookupProjects(query: ProjectLookupQuery): Promise<ProjectLookupResponseDto>;
  getProjectById(projectId: string): Promise<ProjectDto | null>;
  createProject(command: CreateProjectCommand): Promise<ProjectDto>;
  updateProject(command: UpdateProjectCommand): Promise<ProjectDto>;
  archiveProject(command: ArchiveProjectCommand): Promise<ProjectDto>;
  listProjectMembers(command: ListProjectMembersCommand): Promise<ProjectMembersResponseDto>;
  replaceProjectMembers(command: ReplaceProjectMembersCommand): Promise<ProjectMembersResponseDto>;
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

export interface CreateProjectCommand {
  currentUser: CurrentUser;
  dto: CreateProjectRequestDto;
  requestId?: string;
}

export interface UpdateProjectCommand {
  currentUser: CurrentUser;
  projectId: string;
  dto: UpdateProjectRequestDto;
  requestId?: string;
}

export interface ArchiveProjectCommand {
  currentUser: CurrentUser;
  projectId: string;
  requestId?: string;
}

export interface ListProjectMembersCommand {
  currentUser: CurrentUser;
  projectId: string;
  requestId?: string;
}

export interface ReplaceProjectMembersCommand {
  currentUser: CurrentUser;
  projectId: string;
  dto: ReplaceProjectMembersRequestDto;
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

  async create(command: CreateProjectCommand): Promise<ProjectDto> {
    this.requirePermission(command.currentUser, 'projects.create');
    return this.ports.projects.createProject(command);
  }

  async update(command: UpdateProjectCommand): Promise<ProjectDto> {
    this.requirePermission(command.currentUser, 'projects.update');
    return this.ports.projects.updateProject(command);
  }

  async archive(command: ArchiveProjectCommand): Promise<ProjectDto> {
    this.requirePermission(command.currentUser, 'projects.archive');
    return this.ports.projects.archiveProject(command);
  }

  async listMembers(command: ListProjectMembersCommand): Promise<ProjectMembersResponseDto> {
    this.requirePermission(command.currentUser, 'projects.members.view');
    return this.ports.projects.listProjectMembers(command);
  }

  async replaceMembers(command: ReplaceProjectMembersCommand): Promise<ProjectMembersResponseDto> {
    this.requirePermission(command.currentUser, 'projects.members.manage');
    return this.ports.projects.replaceProjectMembers(command);
  }

  private requireView(currentUser: CurrentUser): void {
    this.requirePermission(currentUser, 'projects.view');
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}

export class ProjectNotFoundError extends ApiError {
  constructor(projectId: string) {
    super(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
  }
}
