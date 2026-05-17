export const legacyApiRoutes = {
  auth: {
    login: '/api/login',
    refresh: '/api/refresh',
  },
  users: {
    create: '/api/users/create',
    changePassword: '/api/users/change-password',
  },
  vlm: {
    health: '/api/vlm/health',
    upload: '/api/vlm/upload',
    analyze: '/api/vlm/analyze',
  },
  orderExport: {
    toDrive: '/api/order-export-to-drive',
  },
} as const;
