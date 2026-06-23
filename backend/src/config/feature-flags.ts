import type { BackendEnv } from './env.validation';

export interface BackendFeatureFlags {
  auth: boolean;
  orders: boolean;
  payments: boolean;
  clientPhones: boolean;
  productionActions: boolean;
  orderExport: boolean;
  users: boolean;
  vlm: boolean;
  projects: boolean;
  deadlines: boolean;
  ordersReadOnly: boolean;
  projectsReadOnly: boolean;
  exportDisabled: boolean;
  vlmDisabled: boolean;
  deadlinesReadOnly: boolean;
  deadlineWorker: boolean;
  deadlineActions: boolean;
  deadlineNotifications: boolean;
  cutJobs: boolean;
  cutJobsReadOnly: boolean;
  cutAutoTrigger: boolean;
  /** SP3: include migration-029 sheet columns in backend order reads (off pre-migration). */
  sheetOrdersReads: boolean;
  /** §7.5: enable the create-only doweling quick-create command (off = 503). */
  dowelingCommands: boolean;
}

export function getBackendFeatureFlags(env: BackendEnv): BackendFeatureFlags {
  return {
    auth: env.BACKEND_ENABLE_AUTH,
    orders: env.BACKEND_ENABLE_ORDERS,
    payments: env.BACKEND_ENABLE_PAYMENTS,
    clientPhones: env.BACKEND_ENABLE_CLIENT_PHONES,
    productionActions: env.BACKEND_ENABLE_PRODUCTION_ACTIONS,
    orderExport: env.BACKEND_ENABLE_ORDER_EXPORT,
    users: env.BACKEND_ENABLE_USERS,
    vlm: env.BACKEND_ENABLE_VLM,
    projects: env.BACKEND_ENABLE_PROJECTS,
    deadlines: env.BACKEND_ENABLE_DEADLINES,
    ordersReadOnly: env.BACKEND_ORDERS_READ_ONLY,
    projectsReadOnly: env.BACKEND_PROJECTS_READ_ONLY,
    exportDisabled: env.BACKEND_EXPORT_DISABLED,
    vlmDisabled: env.BACKEND_VLM_DISABLED,
    deadlinesReadOnly: env.BACKEND_DEADLINES_READ_ONLY,
    deadlineWorker: env.BACKEND_ENABLE_DEADLINE_WORKER,
    deadlineActions: env.BACKEND_DEADLINE_ACTIONS_ENABLED,
    deadlineNotifications: env.BACKEND_DEADLINE_NOTIFICATIONS_ENABLED,
    cutJobs: env.BACKEND_ENABLE_CUT_JOBS,
    cutJobsReadOnly: env.BACKEND_CUT_JOBS_READ_ONLY,
    cutAutoTrigger: env.BACKEND_CUT_AUTO_TRIGGER,
    sheetOrdersReads: env.BACKEND_SHEET_ORDERS_READS,
    dowelingCommands: env.BACKEND_ENABLE_DOWELING_COMMANDS,
  };
}
