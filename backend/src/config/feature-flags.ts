import type { BackendEnv } from './env.validation';

export interface BackendFeatureFlags {
  auth: boolean;
  orders: boolean;
  orderExport: boolean;
  users: boolean;
  vlm: boolean;
  deadlines: boolean;
  ordersReadOnly: boolean;
  exportDisabled: boolean;
  vlmDisabled: boolean;
  deadlinesReadOnly: boolean;
  deadlineWorker: boolean;
  deadlineActions: boolean;
  deadlineNotifications: boolean;
}

export function getBackendFeatureFlags(env: BackendEnv): BackendFeatureFlags {
  return {
    auth: env.BACKEND_ENABLE_AUTH,
    orders: env.BACKEND_ENABLE_ORDERS,
    orderExport: env.BACKEND_ENABLE_ORDER_EXPORT,
    users: env.BACKEND_ENABLE_USERS,
    vlm: env.BACKEND_ENABLE_VLM,
    deadlines: env.BACKEND_ENABLE_DEADLINES,
    ordersReadOnly: env.BACKEND_ORDERS_READ_ONLY,
    exportDisabled: env.BACKEND_EXPORT_DISABLED,
    vlmDisabled: env.BACKEND_VLM_DISABLED,
    deadlinesReadOnly: env.BACKEND_DEADLINES_READ_ONLY,
    deadlineWorker: env.BACKEND_ENABLE_DEADLINE_WORKER,
    deadlineActions: env.BACKEND_DEADLINE_ACTIONS_ENABLED,
    deadlineNotifications: env.BACKEND_DEADLINE_NOTIFICATIONS_ENABLED,
  };
}
