import { describe, expect, it } from 'vitest';
import { getBackendFeatureFlags } from './feature-flags';
import { validateEnv } from './env.validation';

describe('backend feature flags', () => {
  it('defaults risky modules to disabled/read-only before migration', () => {
    expect(getBackendFeatureFlags(validateEnv({}))).toEqual({
      auth: false,
      orders: false,
      payments: false,
      clientPhones: false,
      productionActions: false,
      orderExport: false,
      users: false,
      vlm: false,
      projects: false,
      deadlines: false,
      ordersReadOnly: true,
      projectsReadOnly: true,
      exportDisabled: true,
      vlmDisabled: true,
      deadlinesReadOnly: true,
      deadlineWorker: false,
      deadlineActions: false,
      deadlineNotifications: false,
      cutJobs: false,
      cutJobsReadOnly: true,
      cutAutoTrigger: false,
    });
  });

  it('parses explicit feature flags', () => {
    expect(
      getBackendFeatureFlags(
        validateEnv({
          BACKEND_ENABLE_AUTH: 'true',
          DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
          JWT_ACCESS_SECRET: 'x'.repeat(32),
          REFRESH_TOKEN_PEPPER: 'y'.repeat(32),
          BACKEND_ENABLE_ORDERS: 'true',
          BACKEND_ENABLE_PAYMENTS: 'true',
          BACKEND_ENABLE_CLIENT_PHONES: 'true',
          BACKEND_ENABLE_PRODUCTION_ACTIONS: 'true',
          BACKEND_ORDERS_READ_ONLY: 'false',
          BACKEND_ENABLE_DEADLINES: 'true',
          BACKEND_ENABLE_PROJECTS: 'true',
          BACKEND_PROJECTS_READ_ONLY: 'false',
          BACKEND_DEADLINES_READ_ONLY: 'false',
          BACKEND_ENABLE_DEADLINE_WORKER: 'true',
          BACKEND_DEADLINE_ACTIONS_ENABLED: 'true',
          BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: 'true',
          BACKEND_ENABLE_CUT_JOBS: 'true',
          BACKEND_CUT_JOBS_READ_ONLY: 'false',
          BACKEND_CUT_AUTO_TRIGGER: 'true',
          FREECUT_BASE_URL: 'http://freecut:8088',
        }),
      ),
    ).toMatchObject({
      auth: true,
      orders: true,
      payments: true,
      clientPhones: true,
      productionActions: true,
      ordersReadOnly: false,
      deadlines: true,
      projects: true,
      projectsReadOnly: false,
      deadlinesReadOnly: false,
      deadlineWorker: true,
      deadlineActions: true,
      deadlineNotifications: true,
      cutJobs: true,
      cutJobsReadOnly: false,
      cutAutoTrigger: true,
    });
  });
});
