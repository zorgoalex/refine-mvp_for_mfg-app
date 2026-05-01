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
    exportGoogleDrive: (orderId: number) =>
      backendApiPath(`/orders/${orderId}/export/google-drive`),
    deadlines: (orderId: number) => backendApiPath(`/orders/${orderId}/deadlines`),
    deadlineEvents: (orderId: number) => backendApiPath(`/orders/${orderId}/deadline-events`),
    deadlineSummary: (orderId: number) => backendApiPath(`/orders/${orderId}/deadline-summary`),
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
