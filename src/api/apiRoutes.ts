export const BACKEND_API_VERSION = 'v1';
export const BACKEND_API_PREFIX = `/api/${BACKEND_API_VERSION}`;

export function backendApiPath(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${BACKEND_API_PREFIX}${normalizedPath}`;
}

export const apiRoutes = {
  auth: {
    login: backendApiPath('/auth/login'),
    refresh: backendApiPath('/auth/refresh'),
    logout: backendApiPath('/auth/logout'),
    me: backendApiPath('/me'),
  },
  orders: {
    list: backendApiPath('/orders'),
    byId: (orderId: number) => backendApiPath(`/orders/${orderId}`),
    status: (orderId: number) => backendApiPath(`/orders/${orderId}/status`),
    calendarDate: (orderId: number) => backendApiPath(`/orders/${orderId}/calendar-date`),
    orderStatus: (orderId: number) => backendApiPath(`/orders/${orderId}/order-status`),
    productionStageEvent: (orderId: number, productionStatusId: number) =>
      backendApiPath(`/orders/${orderId}/production-stage-events/${productionStatusId}`),
    exportGoogleDrive: (orderId: number) =>
      backendApiPath(`/orders/${orderId}/export/google-drive`),
    snapshot: (orderId: number) => backendApiPath(`/orders/${orderId}/snapshot`),
    snapshotBatch: backendApiPath('/orders/snapshot/batch'),
    importSnapshot: backendApiPath('/orders/snapshot/import'),
    importSnapshotBatch: backendApiPath('/orders/snapshot/import-batch'),
    deadlines: (orderId: number) => backendApiPath(`/orders/${orderId}/deadlines`),
    deadlineEvents: (orderId: number) => backendApiPath(`/orders/${orderId}/deadline-events`),
    deadlineSummary: (orderId: number) => backendApiPath(`/orders/${orderId}/deadline-summary`),
  },
  payments: {
    list: backendApiPath('/payments'),
    byId: (paymentId: number) => backendApiPath(`/payments/${paymentId}`),
  },
  clientPhones: {
    list: backendApiPath('/client-phones'),
    byId: (phoneId: number) => backendApiPath(`/client-phones/${phoneId}`),
  },
  deadlines: {
    list: backendApiPath('/deadlines'),
    byId: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}`),
    pause: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}/pause`),
    resume: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}/resume`),
    cancel: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}/cancel`),
  },
  deadlinePolicies: {
    list: backendApiPath('/deadline-policies'),
    byId: (policyId: string) => backendApiPath(`/deadline-policies/${policyId}`),
  },
  deadlineSettings: {
    root: backendApiPath('/deadline-settings'),
  },
  users: {
    list: backendApiPath('/users'),
    byId: (userId: number) => backendApiPath(`/users/${userId}`),
    changePassword: (userId: number) => backendApiPath(`/users/${userId}/change-password`),
    deactivate: (userId: number) => backendApiPath(`/users/${userId}/deactivate`),
    activate: (userId: number) => backendApiPath(`/users/${userId}/activate`),
  },
  vlm: {
    health: backendApiPath('/vlm/health'),
    upload: backendApiPath('/vlm/upload'),
    analyze: backendApiPath('/vlm/analyze'),
  },
} as const;
