import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface DeadlinesFeatureFlags {
  deadlinesEnabled: boolean;
  deadlinesReadOnly: boolean;
  deadlineWorkerEnabled: boolean;
  deadlineActionsEnabled: boolean;
  deadlineNotificationsEnabled: boolean;
  deadlineWorkerPollIntervalMs: number;
  deadlineWorkerBatchSize: number;
  deadlineWorkerId: string;
}

@Injectable()
export class DeadlinesRuntimeConfigService {
  constructor(private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): DeadlinesFeatureFlags {
    return {
      deadlinesEnabled: this.config.get('BACKEND_ENABLE_DEADLINES', { infer: true }),
      deadlinesReadOnly: this.config.get('BACKEND_DEADLINES_READ_ONLY', { infer: true }),
      deadlineWorkerEnabled: this.config.get('BACKEND_ENABLE_DEADLINE_WORKER', { infer: true }),
      deadlineActionsEnabled: this.config.get('BACKEND_DEADLINE_ACTIONS_ENABLED', { infer: true }),
      deadlineNotificationsEnabled: this.config.get('BACKEND_DEADLINE_NOTIFICATIONS_ENABLED', {
        infer: true,
      }),
      deadlineWorkerPollIntervalMs: this.config.get(
        'BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS',
        { infer: true },
      ),
      deadlineWorkerBatchSize: this.config.get('BACKEND_DEADLINE_WORKER_BATCH_SIZE', {
        infer: true,
      }),
      deadlineWorkerId: this.config.get('BACKEND_DEADLINE_WORKER_ID', { infer: true }),
    };
  }
}
