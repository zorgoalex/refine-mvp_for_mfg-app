import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface NotificationsFeatureFlags {
  engineEnabled: boolean;
  rulesReadOnly: boolean;
  relayOwner: 'none' | 'in_process' | 'external';
  relayPollIntervalMs: number;
  relayBatchSize: number;
  relayWorkerId: string;
  relayMaxAttempts: number;
}

@Injectable()
export class NotificationsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): NotificationsFeatureFlags {
    return {
      engineEnabled: this.config.get('BACKEND_ENABLE_NOTIFICATION_ENGINE', { infer: true }),
      rulesReadOnly: this.config.get('BACKEND_NOTIFICATION_RULES_READ_ONLY', { infer: true }),
      relayOwner: this.config.get('BACKEND_OUTBOX_RELAY_OWNER', { infer: true }),
      relayPollIntervalMs: this.config.get('BACKEND_OUTBOX_RELAY_POLL_INTERVAL_MS', { infer: true }),
      relayBatchSize: this.config.get('BACKEND_OUTBOX_RELAY_BATCH_SIZE', { infer: true }),
      relayWorkerId: this.config.get('BACKEND_OUTBOX_RELAY_WORKER_ID', { infer: true }),
      relayMaxAttempts: this.config.get('BACKEND_OUTBOX_RELAY_MAX_ATTEMPTS', { infer: true }),
    };
  }

  isEngineEnabled(): boolean {
    return this.getFeatureFlags().engineEnabled;
  }

  isRulesReadOnly(): boolean {
    return this.getFeatureFlags().rulesReadOnly;
  }
}
