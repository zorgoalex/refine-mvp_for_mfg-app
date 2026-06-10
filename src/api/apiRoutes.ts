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
    formData: backendApiPath('/orders/form-data'),
    byId: (orderId: number) => backendApiPath(`/orders/${orderId}`),
    status: (orderId: number) => backendApiPath(`/orders/${orderId}/status`),
    paymentStatus: (orderId: number) => backendApiPath(`/orders/${orderId}/payment-status`),
    productionStatus: (orderId: number) => backendApiPath(`/orders/${orderId}/production-status`),
    autoProductionStatusMode: (orderId: number) => backendApiPath(`/orders/${orderId}/production-status-mode/auto`),
    manualProductionStatusMode: (orderId: number) => backendApiPath(`/orders/${orderId}/production-status-mode/manual`),
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
    deadlineEffectiveRules: (orderId: number) =>
      backendApiPath(`/orders/${orderId}/deadline-effective-rules`),
    deadlineActionPreview: (orderId: number) =>
      backendApiPath(`/orders/${orderId}/deadline-action-preview`),
    deadlineOverrides: (orderId: number) =>
      backendApiPath(`/orders/${orderId}/deadline-overrides`),
    deadlineOverride: (orderId: number, overrideId: string) =>
      backendApiPath(`/orders/${orderId}/deadline-overrides/${overrideId}`),
    projects: (orderId: number) => backendApiPath(`/orders/${orderId}/projects`),
  },
  orderDetails: {
    productionStageEvent: (detailId: number, productionStatusId: number) =>
      backendApiPath(`/order-details/${detailId}/production-stage-events/${productionStatusId}`),
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
    override: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}/override`),
    pause: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}/pause`),
    resume: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}/resume`),
    cancel: (deadlineId: string) => backendApiPath(`/deadlines/${deadlineId}/cancel`),
  },
  notifications: {
    list: backendApiPath('/notifications'),
    byId: (notificationId: string) => backendApiPath(`/notifications/${notificationId}`),
    read: (notificationId: string) => backendApiPath(`/notifications/${notificationId}/read`),
    readAll: backendApiPath('/notifications/read-all'),
  },
  deadlinePolicies: {
    list: backendApiPath('/deadline-policies'),
    byId: (policyId: string) => backendApiPath(`/deadline-policies/${policyId}`),
  },
  deadlineSettings: {
    root: backendApiPath('/deadline-settings'),
  },
  deadlineTransitionRules: {
    list: backendApiPath('/deadline-transition-rules'),
    byId: (actionRuleId: string) => backendApiPath(`/deadline-transition-rules/${actionRuleId}`),
  },
  notificationRules: {
    list: backendApiPath('/notification-rules'),
    byId: (ruleId: string) => backendApiPath(`/notification-rules/${encodeURIComponent(ruleId)}`),
    eventTypes: backendApiPath('/notification-event-types'),
  },
  projects: {
    list: backendApiPath('/projects'),
    lookup: backendApiPath('/projects/lookup'),
    byId: (projectId: string) => backendApiPath(`/projects/${projectId}`),
    overview: (projectId: string) => backendApiPath(`/projects/${projectId}/overview`),
    entityLinks: (projectId: string) => backendApiPath(`/projects/${projectId}/entity-links`),
    batchLink: (projectId: string) => backendApiPath(`/projects/${projectId}/batch-link`),
    participants: (projectId: string) => backendApiPath(`/projects/${projectId}/participants`),
    participantRoles: backendApiPath('/projects/participant-roles'),
    reports: {
      deadlineStatusCounts: backendApiPath('/projects/reports/deadline-status-counts'),
    },
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
  audit: {
    list: backendApiPath('/audit'),
  },
} as const;
