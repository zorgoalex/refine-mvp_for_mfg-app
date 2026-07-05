import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { validateOrderId, withQuery } from './ordersApi';
import type {
  CreateGroupRequest,
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
  ReplaceGroupEntityLinksRequest,
  ReplaceGroupParticipantsRequest,
  ReplaceOrderGroupsRequest,
  ReplaceOrderGroupsResponse,
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

export function validateGroupId(groupId: string): string {
  if (!GROUP_UUID_PATTERN.test(groupId)) {
    throw new Error('Invalid groupId');
  }

  return groupId;
}

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
