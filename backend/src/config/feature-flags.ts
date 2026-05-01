import type { BackendEnv } from './env.validation';

export interface BackendFeatureFlags {
  auth: boolean;
  orders: boolean;
  orderExport: boolean;
  users: boolean;
  vlm: boolean;
  ordersReadOnly: boolean;
  exportDisabled: boolean;
  vlmDisabled: boolean;
}

export function getBackendFeatureFlags(env: BackendEnv): BackendFeatureFlags {
  return {
    auth: env.BACKEND_ENABLE_AUTH,
    orders: env.BACKEND_ENABLE_ORDERS,
    orderExport: env.BACKEND_ENABLE_ORDER_EXPORT,
    users: env.BACKEND_ENABLE_USERS,
    vlm: env.BACKEND_ENABLE_VLM,
    ordersReadOnly: env.BACKEND_ORDERS_READ_ONLY,
    exportDisabled: env.BACKEND_EXPORT_DISABLED,
    vlmDisabled: env.BACKEND_VLM_DISABLED,
  };
}
