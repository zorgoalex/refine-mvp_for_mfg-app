import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { validateOrderId, withQuery } from './ordersApi';
import type {
  CreateGroupRequest,
  GroupBatchLinkRequest,
  GroupBatchLinkResponse,
  GroupDeadlineStatusCountsQuery,
  GroupDeadlineStatusCountsResponse,
  GroupDto,
  GroupEntityLinksResponse,
  GroupListQuery,
  GroupListResponse,
  GroupLookupQuery,
  GroupLookupResponse,
  GroupOverviewQuery,
  GroupOverviewResponse,
  GroupParticipantRolesResponse,
  GroupParticipantsResponse,
  GroupResponse,
  OrderGroupsResponse,
  OrderProjectsResponse,
  ProjectBatchLinkRequest,
  ProjectBatchLinkResponse,
  ProjectDeadlineStatusCountsQuery,
  ProjectDeadlineStatusCountsResponse,
  ProjectDto,
  ProjectEntityLinksResponse,
  ProjectListQuery,
  ProjectListResponse,
  ProjectLookupQuery,
  ProjectLookupResponse,
  ProjectOverviewQuery,
  ProjectOverviewResponse,
  ProjectParticipantRolesResponse,
  ProjectParticipantsResponse,
  ProjectResponse,
  ReplaceGroupEntityLinksRequest,
  ReplaceGroupParticipantsRequest,
  ReplaceOrderGroupsRequest,
  ReplaceOrderGroupsResponse,
  ReplaceOrderProjectsRequest,
  ReplaceOrderProjectsResponse,
  UpdateGroupRequest,
} from './types/groupApi.types';

const GROUP_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const groupsApi = {
  listGroups(params: GroupListQuery = {}): Promise<GroupListResponse> {
    return httpClient.get<GroupListResponse>(withQuery(apiRoutes.groups.list, params));
  },

  async listGroupOptions(params: GroupListQuery = {}): Promise<Array<{ label: string; value: string }>> {
    const response = await this.listGroups({ pageSize: 200, ...params });
    return response.data.map((group) => ({
      value: group.id,
      label: `${group.code} · ${group.name}`,
    }));
  },

  lookupGroups(params: GroupLookupQuery = {}): Promise<GroupLookupResponse> {
    return httpClient.get<GroupLookupResponse>(withQuery(apiRoutes.groups.lookup, params));
  },

  async getGroup(groupId: string): Promise<GroupDto> {
    const response = await httpClient.get<GroupResponse>(
      apiRoutes.groups.byId(validateGroupId(groupId)),
    );
    return response.group;
  },

  getGroupOverview(groupId: string, params: GroupOverviewQuery = {}): Promise<GroupOverviewResponse> {
    return httpClient.get<GroupOverviewResponse>(
      withQuery(apiRoutes.groups.overview(validateGroupId(groupId)), params),
    );
  },

  getGroupEntityLinks(groupId: string): Promise<GroupEntityLinksResponse> {
    return httpClient.get<GroupEntityLinksResponse>(
      apiRoutes.groups.entityLinks(validateGroupId(groupId)),
    );
  },

  replaceGroupEntityLinks(
    groupId: string,
    request: ReplaceGroupEntityLinksRequest,
  ): Promise<GroupEntityLinksResponse> {
    return httpClient.put<GroupEntityLinksResponse>(
      apiRoutes.groups.entityLinks(validateGroupId(groupId)),
      normalizeEntityLinksRequest(request),
    );
  },

  appendGroupEntityLinks(
    groupId: string,
    request: ReplaceGroupEntityLinksRequest,
  ): Promise<GroupEntityLinksResponse> {
    return httpClient.post<GroupEntityLinksResponse>(
      apiRoutes.groups.entityLinks(validateGroupId(groupId)),
      normalizeEntityLinksRequest(request),
    );
  },

  batchLinkGroupEntities(groupId: string, request: GroupBatchLinkRequest): Promise<GroupBatchLinkResponse> {
    return httpClient.post<GroupBatchLinkResponse>(
      apiRoutes.groups.batchLink(validateGroupId(groupId)),
      request,
    );
  },

  getGroupParticipants(groupId: string): Promise<GroupParticipantsResponse> {
    return httpClient.get<GroupParticipantsResponse>(
      apiRoutes.groups.participants(validateGroupId(groupId)),
    );
  },

  replaceGroupParticipants(
    groupId: string,
    request: ReplaceGroupParticipantsRequest,
  ): Promise<GroupParticipantsResponse> {
    return httpClient.put<GroupParticipantsResponse>(
      apiRoutes.groups.participants(validateGroupId(groupId)),
      normalizeParticipantsRequest(request),
    );
  },

  getGroupParticipantRoles(): Promise<GroupParticipantRolesResponse> {
    return httpClient.get<GroupParticipantRolesResponse>(apiRoutes.groups.participantRoles);
  },

  getGroupDeadlineStatusCounts(
    params: GroupDeadlineStatusCountsQuery,
  ): Promise<GroupDeadlineStatusCountsResponse> {
    const groupIds = 'groupIds' in params ? params.groupIds.map(validateGroupId) : undefined;
    if ('groupIds' in params && groupIds.length === 0) {
      throw new Error('groupIds are required');
    }

    return httpClient.get<GroupDeadlineStatusCountsResponse>(
      withQuery(apiRoutes.groups.reports.deadlineStatusCounts, {
        ...params,
        temporalMode: params.temporalMode ?? 'current',
        groupIds: groupIds?.join(','),
      }),
    );
  },

  createGroup(request: CreateGroupRequest): Promise<GroupResponse> {
    return httpClient.post<GroupResponse>(apiRoutes.groups.list, request);
  },

  updateGroup(groupId: string, request: UpdateGroupRequest): Promise<GroupResponse> {
    return httpClient.patch<GroupResponse>(
      apiRoutes.groups.byId(validateGroupId(groupId)),
      request,
    );
  },

  archiveGroup(groupId: string): Promise<GroupResponse> {
    return httpClient.delete<GroupResponse>(apiRoutes.groups.byId(validateGroupId(groupId)));
  },

  getOrderGroups(orderId: number): Promise<OrderGroupsResponse> {
    return httpClient.get<OrderGroupsResponse>(apiRoutes.orders.groups(validateOrderId(orderId)));
  },

  replaceOrderGroups(
    orderId: number,
    request: ReplaceOrderGroupsRequest,
  ): Promise<ReplaceOrderGroupsResponse> {
    return httpClient.put<ReplaceOrderGroupsResponse>(
      apiRoutes.orders.groups(validateOrderId(orderId)),
      request,
    );
  },
};

export const projectsApi = {
  listProjects(params: ProjectListQuery = {}): Promise<ProjectListResponse> {
    return groupsApi.listGroups(params);
  },

  listProjectOptions(params: ProjectListQuery = {}): Promise<Array<{ label: string; value: string }>> {
    return groupsApi.listGroupOptions(params);
  },

  lookupProjects(params: ProjectLookupQuery = {}): Promise<ProjectLookupResponse> {
    return groupsApi.lookupGroups(params);
  },

  getProject(projectId: string): Promise<ProjectDto> {
    return groupsApi.getGroup(projectId);
  },

  async getProjectOverview(
    projectId: string,
    params: ProjectOverviewQuery = {},
  ): Promise<ProjectOverviewResponse> {
    return mapOverviewToProject(await groupsApi.getGroupOverview(projectId, params));
  },

  async getProjectEntityLinks(projectId: string): Promise<ProjectEntityLinksResponse> {
    return mapEntityLinksToProject(await groupsApi.getGroupEntityLinks(projectId));
  },

  async replaceProjectEntityLinks(
    projectId: string,
    request: ReplaceGroupEntityLinksRequest,
  ): Promise<ProjectEntityLinksResponse> {
    return mapEntityLinksToProject(await groupsApi.replaceGroupEntityLinks(projectId, request));
  },

  async appendProjectEntityLinks(
    projectId: string,
    request: ReplaceGroupEntityLinksRequest,
  ): Promise<ProjectEntityLinksResponse> {
    return mapEntityLinksToProject(await groupsApi.appendGroupEntityLinks(projectId, request));
  },

  async batchLinkProjectEntities(
    projectId: string,
    request: ProjectBatchLinkRequest,
  ): Promise<ProjectBatchLinkResponse> {
    return mapBatchLinkToProject(await groupsApi.batchLinkGroupEntities(projectId, request));
  },

  async getProjectParticipants(projectId: string): Promise<ProjectParticipantsResponse> {
    return mapParticipantsToProject(await groupsApi.getGroupParticipants(projectId));
  },

  async replaceProjectParticipants(
    projectId: string,
    request: ReplaceGroupParticipantsRequest,
  ): Promise<ProjectParticipantsResponse> {
    return mapParticipantsToProject(await groupsApi.replaceGroupParticipants(projectId, request));
  },

  getProjectParticipantRoles(): Promise<ProjectParticipantRolesResponse> {
    return groupsApi.getGroupParticipantRoles();
  },

  async getProjectDeadlineStatusCounts(
    params: ProjectDeadlineStatusCountsQuery,
  ): Promise<ProjectDeadlineStatusCountsResponse> {
    const response = await groupsApi.getGroupDeadlineStatusCounts(
      'projectIds' in params
        ? { groupMode: params.projectMode, groupIds: params.projectIds, temporalMode: params.temporalMode }
        : { groupMode: params.projectMode, temporalMode: params.temporalMode },
    );

    return {
      ...response,
      filter:
        response.filter.groupMode === 'none'
          ? { projectMode: 'none', temporalMode: response.filter.temporalMode }
          : {
              projectMode: response.filter.groupMode,
              projectIds: response.filter.groupIds,
              temporalMode: response.filter.temporalMode,
            },
    };
  },

  async createProject(request: CreateGroupRequest): Promise<ProjectResponse> {
    return mapGroupResponseToProject(await groupsApi.createGroup(request));
  },

  async updateProject(projectId: string, request: UpdateGroupRequest): Promise<ProjectResponse> {
    return mapGroupResponseToProject(await groupsApi.updateGroup(projectId, request));
  },

  async archiveProject(projectId: string): Promise<ProjectResponse> {
    return mapGroupResponseToProject(await groupsApi.archiveGroup(projectId));
  },

  async getOrderProjects(orderId: number): Promise<OrderProjectsResponse> {
    return mapOrderGroupsToProjects(await groupsApi.getOrderGroups(orderId));
  },

  async replaceOrderProjects(
    orderId: number,
    request: ReplaceOrderProjectsRequest,
  ): Promise<ReplaceOrderProjectsResponse> {
    return mapOrderGroupsToProjects(
      await groupsApi.replaceOrderGroups(orderId, mapOrderProjectsRequestToGroups(request)),
    ) as ReplaceOrderProjectsResponse;
  },
};

export function validateGroupId(groupId: string): string {
  if (!GROUP_UUID_PATTERN.test(groupId)) {
    throw new Error('Invalid groupId');
  }

  return groupId;
}

export const validateProjectId = validateGroupId;

function normalizeEntityLinksRequest(
  request: ReplaceGroupEntityLinksRequest,
): ReplaceGroupEntityLinksRequest {
  return {
    ...request,
    links: request.links.map((link) => ({ ...link, metadata: link.metadata ?? {} })),
  };
}

function normalizeParticipantsRequest(
  request: ReplaceGroupParticipantsRequest,
): ReplaceGroupParticipantsRequest {
  return {
    ...request,
    participants: request.participants.map((participant) => ({
      ...participant,
      metadata: participant.metadata ?? {},
    })),
  };
}

function mapGroupResponseToProject(response: GroupResponse): ProjectResponse {
  return { project: response.group };
}

function mapOverviewToProject(response: GroupOverviewResponse): ProjectOverviewResponse {
  const { group, filter, ...rest } = response;
  return {
    ...rest,
    project: group,
    filter: {
      projectId: filter.groupId,
      temporalMode: filter.temporalMode,
      asOf: filter.asOf,
      from: filter.from,
      to: filter.to,
      createdFrom: filter.createdFrom,
      createdTo: filter.createdTo,
    },
  };
}

function mapEntityLinksToProject(response: GroupEntityLinksResponse): ProjectEntityLinksResponse {
  const { groupId, ...rest } = response;
  return {
    ...rest,
    projectId: groupId,
  };
}

function mapBatchLinkToProject(response: GroupBatchLinkResponse): ProjectBatchLinkResponse {
  const { groupId, ...rest } = response;
  return {
    ...rest,
    projectId: groupId,
  };
}

function mapParticipantsToProject(response: GroupParticipantsResponse): ProjectParticipantsResponse {
  const { groupId, ...rest } = response;
  return {
    ...rest,
    projectId: groupId,
  };
}

function mapOrderProjectsRequestToGroups(request: ReplaceOrderProjectsRequest): ReplaceOrderGroupsRequest {
  return {
    ...request,
    primaryGroupId: request.primaryProjectId,
    groups: request.projects.map((project) => ({
      groupId: project.projectId,
      relationType: project.relationType,
      isPrimary: project.isPrimary,
    })),
  };
}

function mapOrderGroupsToProjects(
  response: OrderGroupsResponse | ReplaceOrderGroupsResponse,
) : OrderProjectsResponse | ReplaceOrderProjectsResponse {
  const { primaryGroup, groups, ...rest } = response;
  return {
    ...rest,
    primaryProject: primaryGroup,
    projects: groups,
  };
}
