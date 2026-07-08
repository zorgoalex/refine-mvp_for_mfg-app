import type {
  CreateProjectCommand,
  CreateProjectResult,
  ListProjectsQuery,
  MergeCommand,
  MergeResult,
  MoveOrderCommand,
  MoveOrderResult,
  ProjectCard,
  ProjectDto,
  ProjectsRepositoryPort,
  UpdateProjectCommand,
} from '../application/projects.types';
import { ProjectDatabaseUnavailableError } from '../errors/projects.errors';

export class UnavailableProjectsRepository implements ProjectsRepositoryPort {
  list(_query: ListProjectsQuery): Promise<ProjectDto[]> {
    return Promise.reject(new ProjectDatabaseUnavailableError());
  }

  getById(_projectId: number): Promise<ProjectCard> {
    return Promise.reject(new ProjectDatabaseUnavailableError());
  }

  create(_command: CreateProjectCommand): Promise<CreateProjectResult> {
    return Promise.reject(new ProjectDatabaseUnavailableError());
  }

  update(_command: UpdateProjectCommand): Promise<ProjectDto> {
    return Promise.reject(new ProjectDatabaseUnavailableError());
  }

  moveOrder(_command: MoveOrderCommand): Promise<MoveOrderResult> {
    return Promise.reject(new ProjectDatabaseUnavailableError());
  }

  merge(_command: MergeCommand): Promise<MergeResult> {
    return Promise.reject(new ProjectDatabaseUnavailableError());
  }
}
