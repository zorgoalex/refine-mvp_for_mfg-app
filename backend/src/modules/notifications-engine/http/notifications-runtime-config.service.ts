import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';
import type { NotificationFeatureFlag } from '../domain/notification-event-registry';

export interface NotificationsFeatureFlags {
  engineEnabled: boolean;
  rulesReadOnly: boolean;
  engineOwnsDeadline: boolean;
  relayOwner: 'none' | 'in_process' | 'external';
  relayPollIntervalMs: number;
  relayBatchSize: number;
  relayWorkerId: string;
  relayMaxAttempts: number;
  /** BACKEND_PROCUREMENT_NOTIFICATIONS_ENABLED: уведомления закупа (экран снабжения, ф.4б). */
  procurementNotificationsEnabled: boolean;
}

@Injectable()
export class NotificationsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): NotificationsFeatureFlags {
    return {
      engineEnabled: this.config.get('BACKEND_ENABLE_NOTIFICATION_ENGINE', { infer: true }),
      rulesReadOnly: this.config.get('BACKEND_NOTIFICATION_RULES_READ_ONLY', { infer: true }),
      engineOwnsDeadline: this.config.get('BACKEND_NOTIFICATION_ENGINE_OWNS_DEADLINE', {
        infer: true,
      }),
      relayOwner: this.config.get('BACKEND_OUTBOX_RELAY_OWNER', { infer: true }),
      relayPollIntervalMs: this.config.get('BACKEND_OUTBOX_RELAY_POLL_INTERVAL_MS', { infer: true }),
      relayBatchSize: this.config.get('BACKEND_OUTBOX_RELAY_BATCH_SIZE', { infer: true }),
      relayWorkerId: this.config.get('BACKEND_OUTBOX_RELAY_WORKER_ID', { infer: true }),
      relayMaxAttempts: this.config.get('BACKEND_OUTBOX_RELAY_MAX_ATTEMPTS', { infer: true }),
      procurementNotificationsEnabled: this.config.get('BACKEND_PROCUREMENT_NOTIFICATIONS_ENABLED', { infer: true }) === true,
    };
  }

  isEngineEnabled(): boolean {
    return this.getFeatureFlags().engineEnabled;
  }

  isRulesReadOnly(): boolean {
    return this.getFeatureFlags().rulesReadOnly;
  }

  isEngineOwnsDeadline(): boolean {
    return this.getFeatureFlags().engineOwnsDeadline;
  }

  /** Читается при каждой обработке события — не кешируется. */
  isFeatureEnabled(flag: NotificationFeatureFlag): boolean {
    if (flag === 'procurementNotifications') return this.getFeatureFlags().procurementNotificationsEnabled;
    return false;
  }
}
