import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

describe('DeadlinesRuntimeConfigService transition readiness', () => {
  it('claims automatic readiness only for the active in-process scheduler', () => {
    expect(readiness({ owner: 'in_process' })).toMatchObject({
      manualMutationReady: true,
      inProcessAutomaticReady: true,
      externalSchedulerOwnerSelected: false,
      automaticExecutionConfigured: true,
    });
    expect(readiness({ owner: 'external' })).toMatchObject({
      manualMutationReady: true,
      inProcessAutomaticReady: false,
      externalSchedulerOwnerSelected: true,
      automaticExecutionConfigured: false,
    });
    expect(readiness({ owner: 'none', actionsEnabled: false })).toMatchObject({
      manualMutationReady: false,
      inProcessAutomaticReady: false,
      externalSchedulerOwnerSelected: false,
      automaticExecutionConfigured: false,
    });
  });
});

function readiness(options: {
  owner: 'none' | 'in_process' | 'external';
  actionsEnabled?: boolean;
}) {
  const values: Partial<BackendEnv> = {
    BACKEND_ENABLE_DEADLINES: true,
    BACKEND_DEADLINES_READ_ONLY: false,
    BACKEND_ENABLE_DEADLINE_WORKER: true,
    BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER: options.owner,
    BACKEND_DEADLINE_ACTIONS_ENABLED: options.actionsEnabled ?? true,
    BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: false,
    BACKEND_NOTIFICATION_ENGINE_OWNS_DEADLINE: false,
    BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS: 60000,
    BACKEND_DEADLINE_WORKER_BATCH_SIZE: 100,
    BACKEND_DEADLINE_WORKER_ID: 'test-worker',
  };
  const config = {
    get(key: keyof BackendEnv) {
      return values[key];
    },
  } as ConfigService<BackendEnv, true>;

  return new DeadlinesRuntimeConfigService(config).getTransitionRulesReadiness();
}
