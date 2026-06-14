import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationRule } from '../domain/notification-rule.types';

export interface CreateNotificationRuleInput {
  ruleCode: string;
  eventType: string;
  projectId?: string | null;
  level: 'info' | 'warning' | 'error';
  priority: number;
  isEnabled: boolean;
  conditions: Record<string, unknown>;
  recipients: Record<string, unknown>;
  titleTemplate: string | null;
  messageTemplate: string | null;
  createdByUserId: number;
}

export interface UpdateNotificationRuleInput {
  projectId?: string | null;
  level?: 'info' | 'warning' | 'error';
  priority?: number;
  isEnabled?: boolean;
  conditions?: Record<string, unknown>;
  recipients?: Record<string, unknown>;
  titleTemplate?: string | null;
  messageTemplate?: string | null;
  updatedByUserId: number;
  expectedUpdatedAt?: string;
}

export interface NotificationRuleRepositoryPort {
  create(client: DatabaseClient, input: CreateNotificationRuleInput): Promise<NotificationRule>;
  update(client: DatabaseClient, ruleId: string, patch: UpdateNotificationRuleInput): Promise<NotificationRule>;
  delete(client: DatabaseClient, ruleId: string): Promise<NotificationRule | null>;
  getById(client: DatabaseClient, ruleId: string): Promise<NotificationRule | null>;
  list(
    client: DatabaseClient,
    filter: { eventType?: string; isEnabled?: boolean; projectId?: string | 'global' },
  ): Promise<NotificationRule[]>;
  listEnabledByEvent(client: DatabaseClient, eventType: string): Promise<NotificationRule[]>;
}
