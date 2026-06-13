import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

export interface OrgHead {
  userId: number;
  displayName: string | null;
  isActive: boolean;
}

export interface OrgDirectionSummary {
  directionId: number;
  directionName: string;
  description: string | null;
  isActive: boolean;
  workshopCount: number;
  workCenterCount: number;
  headCount: number;
}

export interface OrgDirectionDetail {
  directionId: number;
  directionName: string;
  description: string | null;
  isActive: boolean;
  workshops: Array<{ workshopId: number; name: string }>;
  workCenters: Array<{ workcenterId: number; workshopId: number; name: string }>;
  heads: OrgHead[];
}

export interface OrgAssignableUser {
  userId: number;
  displayName: string | null;
}

export interface OrgWorkshopLookup {
  workshopId: number;
  name: string;
  isActive: boolean;
}

export interface OrgWorkCenterLookup {
  workcenterId: number;
  workshopId: number;
  name: string;
  isActive: boolean;
}

export interface CreateDirectionPayload {
  name: string;
  description?: string | null;
  isActive?: boolean;
}

export interface UpdateDirectionPayload {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

export interface ReplaceIdSetPayload {
  idempotencyKey: string;
  ids: number[];
  reason?: string | null;
}

interface DirectionsListResponse {
  directions: OrgDirectionSummary[];
  requestId?: string;
}
interface AssignableUsersResponse {
  users: OrgAssignableUser[];
  requestId?: string;
}
interface WorkshopsLookupResponse {
  workshops: OrgWorkshopLookup[];
  requestId?: string;
}
interface WorkCentersLookupResponse {
  workCenters: OrgWorkCenterLookup[];
  requestId?: string;
}

export const orgApi = {
  listDirections(): Promise<DirectionsListResponse> {
    return httpClient.get<DirectionsListResponse>(apiRoutes.org.directions);
  },
  getDirection(directionId: number): Promise<OrgDirectionDetail> {
    return httpClient.get<OrgDirectionDetail>(apiRoutes.org.directionById(directionId));
  },
  createDirection(body: CreateDirectionPayload): Promise<OrgDirectionDetail> {
    return httpClient.post<OrgDirectionDetail>(apiRoutes.org.directions, body);
  },
  updateDirection(directionId: number, body: UpdateDirectionPayload): Promise<OrgDirectionDetail> {
    return httpClient.patch<OrgDirectionDetail>(apiRoutes.org.directionById(directionId), body);
  },
  deleteDirection(directionId: number): Promise<{ directionId: number }> {
    return httpClient.delete<{ directionId: number }>(apiRoutes.org.directionWithConfirm(directionId));
  },
  replaceDirectionWorkshops(directionId: number, body: ReplaceIdSetPayload): Promise<OrgDirectionDetail> {
    return httpClient.put<OrgDirectionDetail>(apiRoutes.org.directionWorkshops(directionId), body);
  },
  replaceDirectionWorkCenters(directionId: number, body: ReplaceIdSetPayload): Promise<OrgDirectionDetail> {
    return httpClient.put<OrgDirectionDetail>(apiRoutes.org.directionWorkCenters(directionId), body);
  },
  replaceDirectionHeads(directionId: number, body: ReplaceIdSetPayload): Promise<OrgDirectionDetail> {
    return httpClient.put<OrgDirectionDetail>(apiRoutes.org.directionHeads(directionId), body);
  },
  listWorkshopHeads(workshopId: number): Promise<OrgHead[]> {
    return httpClient.get<OrgHead[]>(apiRoutes.org.workshopHeads(workshopId));
  },
  replaceWorkshopHeads(workshopId: number, body: ReplaceIdSetPayload): Promise<OrgHead[]> {
    return httpClient.put<OrgHead[]>(apiRoutes.org.workshopHeads(workshopId), body);
  },
  getAssignableUsers(): Promise<AssignableUsersResponse> {
    return httpClient.get<AssignableUsersResponse>(apiRoutes.org.assignableUsers);
  },
  getWorkshops(): Promise<WorkshopsLookupResponse> {
    return httpClient.get<WorkshopsLookupResponse>(apiRoutes.org.lookupWorkshops);
  },
  getWorkCenters(): Promise<WorkCentersLookupResponse> {
    return httpClient.get<WorkCentersLookupResponse>(apiRoutes.org.lookupWorkCenters);
  },
};
