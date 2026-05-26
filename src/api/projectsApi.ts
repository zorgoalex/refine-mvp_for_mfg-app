import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CreateProjectRequest,
  ProjectDto,
  ProjectListQuery,
  ProjectListResponse,
  ProjectLookupQuery,
  ProjectLookupResponse,
  ProjectResponse,
  UpdateProjectRequest,
} from './types/projectApi.types';

const PROJECT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const projectsApi = {
  listProjects(params: ProjectListQuery = {}): Promise<ProjectListResponse> {
    return httpClient.get<ProjectListResponse>(withQuery(apiRoutes.projects.list, params));
  },

  lookupProjects(params: ProjectLookupQuery = {}): Promise<ProjectLookupResponse> {
    return httpClient.get<ProjectLookupResponse>(withQuery(apiRoutes.projects.lookup, params));
  },

  async getProject(projectId: string): Promise<ProjectDto> {
    const response = await httpClient.get<ProjectResponse>(
      apiRoutes.projects.byId(validateProjectId(projectId)),
    );
    return response.project;
  },

  createProject(request: CreateProjectRequest): Promise<ProjectResponse> {
    return httpClient.post<ProjectResponse>(apiRoutes.projects.list, request);
  },

  updateProject(projectId: string, request: UpdateProjectRequest): Promise<ProjectResponse> {
    return httpClient.patch<ProjectResponse>(
      apiRoutes.projects.byId(validateProjectId(projectId)),
      request,
    );
  },

  archiveProject(projectId: string): Promise<ProjectResponse> {
    return httpClient.delete<ProjectResponse>(apiRoutes.projects.byId(validateProjectId(projectId)));
  },
};

export function validateProjectId(projectId: string): string {
  if (!PROJECT_UUID_PATTERN.test(projectId)) {
    throw new Error('Invalid projectId');
  }

  return projectId;
}
