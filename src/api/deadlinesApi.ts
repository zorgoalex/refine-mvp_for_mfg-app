import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { validateOrderId, withQuery } from './ordersApi';
import type {
  CancelDeadlineRequest,
  CreateDeadlineRequest,
  DeadlineEventsResponse,
  DeadlineListQuery,
  DeadlineListResponse,
  DeadlinePolicyListResponse,
  DeadlineResponse,
  DeadlineSettingsResponse,
  OrderDeadlinesResponse,
  OrderDeadlineSummary,
  OverrideDeadlineRequest,
  PauseDeadlineRequest,
  ResumeDeadlineRequest,
  UpdateDeadlineSettingsRequest,
} from './types/deadlineApi.types';

export const deadlinesApi = {
  list(params: DeadlineListQuery = {}): Promise<DeadlineListResponse> {
    return httpClient.get<DeadlineListResponse>(withQuery(apiRoutes.deadlines.list, params));
  },

  getById(deadlineId: string): Promise<DeadlineResponse> {
    return httpClient.get<DeadlineResponse>(apiRoutes.deadlines.byId(validateDeadlineId(deadlineId)));
  },

  create(request: CreateDeadlineRequest): Promise<DeadlineResponse> {
    return httpClient.post<DeadlineResponse>(apiRoutes.deadlines.list, request);
  },

  override(deadlineId: string, request: OverrideDeadlineRequest): Promise<DeadlineResponse> {
    return httpClient.patch<DeadlineResponse>(
      apiRoutes.deadlines.byId(validateDeadlineId(deadlineId)),
      request,
    );
  },

  pause(deadlineId: string, request: PauseDeadlineRequest): Promise<DeadlineResponse> {
    return httpClient.post<DeadlineResponse>(
      apiRoutes.deadlines.pause(validateDeadlineId(deadlineId)),
      request,
    );
  },

  resume(deadlineId: string, request: ResumeDeadlineRequest = {}): Promise<DeadlineResponse> {
    return httpClient.post<DeadlineResponse>(
      apiRoutes.deadlines.resume(validateDeadlineId(deadlineId)),
      request,
    );
  },

  cancel(deadlineId: string, request: CancelDeadlineRequest): Promise<DeadlineResponse> {
    return httpClient.post<DeadlineResponse>(
      apiRoutes.deadlines.cancel(validateDeadlineId(deadlineId)),
      request,
    );
  },

  listForOrder(orderId: number): Promise<OrderDeadlinesResponse> {
    return httpClient.get<OrderDeadlinesResponse>(
      apiRoutes.orders.deadlines(validateOrderId(orderId)),
    );
  },

  listEventsForOrder(orderId: number): Promise<DeadlineEventsResponse> {
    return httpClient.get<DeadlineEventsResponse>(
      apiRoutes.orders.deadlineEvents(validateOrderId(orderId)),
    );
  },

  getSummaryForOrder(orderId: number): Promise<OrderDeadlineSummary> {
    return httpClient.get<OrderDeadlineSummary>(
      apiRoutes.orders.deadlineSummary(validateOrderId(orderId)),
    );
  },

  listPolicies(): Promise<DeadlinePolicyListResponse> {
    return httpClient.get<DeadlinePolicyListResponse>(apiRoutes.deadlinePolicies.list);
  },

  getSettings(): Promise<DeadlineSettingsResponse> {
    return httpClient.get<DeadlineSettingsResponse>(apiRoutes.deadlineSettings.root);
  },

  updateSettings(request: UpdateDeadlineSettingsRequest): Promise<DeadlineSettingsResponse> {
    return httpClient.patch<DeadlineSettingsResponse>(apiRoutes.deadlineSettings.root, request);
  },
};

export function validateDeadlineId(deadlineId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      deadlineId,
    )
  ) {
    throw new Error('Invalid deadlineId');
  }

  return deadlineId;
}
