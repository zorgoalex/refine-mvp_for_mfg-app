import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CreateNotificationRuleRequest,
  NotificationEventTypeDto,
  NotificationRuleDto,
  UpdateNotificationRuleRequest,
} from './types/notificationRulesApi.types';

export interface ListNotificationRulesParams {
  eventType?: string;
  isEnabled?: boolean;
}

export const notificationRulesApi = {
  list(params: ListNotificationRulesParams = {}): Promise<NotificationRuleDto[]> {
    return httpClient.get<NotificationRuleDto[]>(withQuery(apiRoutes.notificationRules.list, params));
  },

  getById(ruleId: string): Promise<NotificationRuleDto> {
    return httpClient.get<NotificationRuleDto>(apiRoutes.notificationRules.byId(ruleId));
  },

  create(body: CreateNotificationRuleRequest): Promise<NotificationRuleDto> {
    return httpClient.post<NotificationRuleDto>(apiRoutes.notificationRules.list, body);
  },

  update(ruleId: string, body: UpdateNotificationRuleRequest): Promise<NotificationRuleDto> {
    return httpClient.patch<NotificationRuleDto>(apiRoutes.notificationRules.byId(ruleId), body);
  },

  remove(ruleId: string): Promise<NotificationRuleDto> {
    return httpClient.delete<NotificationRuleDto>(apiRoutes.notificationRules.byId(ruleId));
  },

  listEventTypes(): Promise<NotificationEventTypeDto[]> {
    return httpClient.get<NotificationEventTypeDto[]>(apiRoutes.notificationRules.eventTypes);
  },
};
