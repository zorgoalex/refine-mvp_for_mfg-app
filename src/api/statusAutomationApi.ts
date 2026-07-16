import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  CreateStatusAutomationRuleRequest,
  DeleteStatusAutomationRuleResponse,
  StatusAutomationEventTypeDto,
  StatusAutomationRuleDto,
  UpdateStatusAutomationRuleRequest,
} from './types/statusAutomationApi.types';

export const statusAutomationApi = {
  list(): Promise<StatusAutomationRuleDto[]> {
    return httpClient.get<StatusAutomationRuleDto[]>(apiRoutes.statusAutomation.rules);
  },

  create(body: CreateStatusAutomationRuleRequest): Promise<StatusAutomationRuleDto> {
    return httpClient.post<StatusAutomationRuleDto>(apiRoutes.statusAutomation.rules, body);
  },

  update(
    ruleId: number,
    body: UpdateStatusAutomationRuleRequest,
  ): Promise<StatusAutomationRuleDto> {
    return httpClient.patch<StatusAutomationRuleDto>(
      apiRoutes.statusAutomation.ruleById(ruleId),
      body,
    );
  },

  remove(ruleId: number): Promise<DeleteStatusAutomationRuleResponse> {
    return httpClient.delete<DeleteStatusAutomationRuleResponse>(
      apiRoutes.statusAutomation.ruleById(ruleId),
    );
  },

  listEventTypes(): Promise<StatusAutomationEventTypeDto[]> {
    return httpClient.get<StatusAutomationEventTypeDto[]>(apiRoutes.statusAutomation.eventTypes);
  },
};
