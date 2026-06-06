import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { validateOrderId, withQuery } from './ordersApi';
import type {
  CreateProjectRequest,
  OrderProjectsResponse,
  ProjectDeadlineStatusCountsQuery,
  ProjectDeadlineStatusCountsResponse,
  ProjectDto,
  ProjectEntityLinksResponse,
  ProjectBatchLinkRequest,
  ProjectBatchLinkResponse,
  ProjectListQuery,
  ProjectListResponse,
  ProjectLookupQuery,
  ProjectLookupResponse,
  ProjectOverviewQuery,
  ProjectOverviewResponse,
  ProjectParticipantRolesResponse,
  ProjectParticipantsResponse,
  ProjectResponse,
  ReplaceProjectEntityLinksRequest,
  ReplaceOrderProjectsRequest,
  ReplaceOrderProjectsResponse,
  ReplaceProjectParticipantsRequest,
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

  getProjectOverview(
    projectId: string,
    params: ProjectOverviewQuery = {},
  ): Promise<ProjectOverviewResponse> {
    return httpClient.get<ProjectOverviewResponse>(
      withQuery(apiRoutes.projects.overview(validateProjectId(projectId)), params),
    );
  },

  getProjectEntityLinks(projectId: string): Promise<ProjectEntityLinksResponse> {
    return httpClient.get<ProjectEntityLinksResponse>(
      apiRoutes.projects.entityLinks(validateProjectId(projectId)),
    );
  },

  replaceProjectEntityLinks(
    projectId: string,
    request: ReplaceProjectEntityLinksRequest,
  ): Promise<ProjectEntityLinksResponse> {
    return httpClient.put<ProjectEntityLinksResponse>(
      apiRoutes.projects.entityLinks(validateProjectId(projectId)),
      normalizeEntityLinksRequest(request),
    );
  },

  appendProjectEntityLinks(
    projectId: string,
    request: ReplaceProjectEntityLinksRequest,
  ): Promise<ProjectEntityLinksResponse> {
    return httpClient.post<ProjectEntityLinksResponse>(
      apiRoutes.projects.entityLinks(validateProjectId(projectId)),
      normalizeEntityLinksRequest(request),
    );
  },

  batchLinkProjectEntities(
    projectId: string,
    request: ProjectBatchLinkRequest,
  ): Promise<ProjectBatchLinkResponse> {
    return httpClient.post<ProjectBatchLinkResponse>(
      apiRoutes.projects.batchLink(validateProjectId(projectId)),
      request,
    );
  },

  getProjectParticipants(projectId: string): Promise<ProjectParticipantsResponse> {
    return httpClient.get<ProjectParticipantsResponse>(
      apiRoutes.projects.participants(validateProjectId(projectId)),
    );
  },

  replaceProjectParticipants(
    projectId: string,
    request: ReplaceProjectParticipantsRequest,
  ): Promise<ProjectParticipantsResponse> {
    return httpClient.put<ProjectParticipantsResponse>(
      apiRoutes.projects.participants(validateProjectId(projectId)),
      normalizeParticipantsRequest(request),
    );
  },

  getProjectParticipantRoles(): Promise<ProjectParticipantRolesResponse> {
    return httpClient.get<ProjectParticipantRolesResponse>(apiRoutes.projects.participantRoles);
  },

  getProjectDeadlineStatusCounts(
    params: ProjectDeadlineStatusCountsQuery,
  ): Promise<ProjectDeadlineStatusCountsResponse> {
    const projectIds = 'projectIds' in params ? params.projectIds.map(validateProjectId) : undefined;
    if ('projectIds' in params && projectIds.length === 0) {
      throw new Error('projectIds are required');
    }

    return httpClient.get<ProjectDeadlineStatusCountsResponse>(
      withQuery(apiRoutes.projects.reports.deadlineStatusCounts, {
        ...params,
        temporalMode: params.temporalMode ?? 'current',
        projectIds: projectIds?.join(','),
      }),
    );
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

  getOrderProjects(orderId: number): Promise<OrderProjectsResponse> {
    return httpClient.get<OrderProjectsResponse>(apiRoutes.orders.projects(validateOrderId(orderId)));
  },

  replaceOrderProjects(
    orderId: number,
    request: ReplaceOrderProjectsRequest,
  ): Promise<ReplaceOrderProjectsResponse> {
    return httpClient.put<ReplaceOrderProjectsResponse>(
      apiRoutes.orders.projects(validateOrderId(orderId)),
      request,
    );
  },
};

export function validateProjectId(projectId: string): string {
  if (!PROJECT_UUID_PATTERN.test(projectId)) {
    throw new Error('Invalid projectId');
  }

  return projectId;
}

function normalizeEntityLinksRequest(
  request: ReplaceProjectEntityLinksRequest,
): ReplaceProjectEntityLinksRequest {
  return {
    ...request,
    links: request.links.map((link) => ({ ...link, metadata: link.metadata ?? {} })),
  };
}

function normalizeParticipantsRequest(
  request: ReplaceProjectParticipantsRequest,
): ReplaceProjectParticipantsRequest {
  return {
    ...request,
    participants: request.participants.map((participant) => ({
      ...participant,
      metadata: participant.metadata ?? {},
    })),
  };
}
