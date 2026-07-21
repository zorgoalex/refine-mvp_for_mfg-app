export const BACKEND_API_VERSION = 'v1';
export const BACKEND_API_PREFIX = `/api/${BACKEND_API_VERSION}`;

export function backendApiPath(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${BACKEND_API_PREFIX}${normalizedPath}`;
}

const orderGroupsRoute = (orderId: number) => backendApiPath(`/orders/${orderId}/groups`);
const groupsRoutes = {
  list: backendApiPath('/groups'),
  lookup: backendApiPath('/groups/lookup'),
  byId: (groupId: string) => backendApiPath(`/groups/${groupId}`),
  overview: (groupId: string) => backendApiPath(`/groups/${groupId}/overview`),
  entityLinks: (groupId: string) => backendApiPath(`/groups/${groupId}/entity-links`),
  batchLink: (groupId: string) => backendApiPath(`/groups/${groupId}/batch-link`),
  participants: (groupId: string) => backendApiPath(`/groups/${groupId}/participants`),
  participantRoles: backendApiPath('/groups/participant-roles'),
  reports: {
    deadlineStatusCounts: backendApiPath('/groups/reports/deadline-status-counts'),
  },
} as const;

export const apiRoutes = {
  auth: {
    login: backendApiPath('/auth/login'),
    refresh: backendApiPath('/auth/refresh'),
    logout: backendApiPath('/auth/logout'),
    me: backendApiPath('/me'),
    workosAuthorize: backendApiPath('/auth/workos/authorize'),
    workosCallback: backendApiPath('/auth/workos/callback'),
    workosLinkStart: backendApiPath('/auth/workos/link/start'),
    workosLinkCallback: backendApiPath('/auth/workos/link/callback'),
    workosLinks: backendApiPath('/auth/workos/links'),
    workosLinkById: (identityId: string) => backendApiPath(`/auth/workos/links/${identityId}`),
    workosAdminLinks: (userId: string) => backendApiPath(`/auth/workos/admin/users/${userId}/links`),
    workosAdminLinkById: (userId: string, identityId: string) =>
      backendApiPath(`/auth/workos/admin/users/${userId}/links/${identityId}`),
  },
  profile: {
    preferences: backendApiPath('/me/preferences'),
    referenceUsage: backendApiPath('/me/preferences/reference-usage'),
  },
  orders: {
    list: backendApiPath('/orders'),
    formData: backendApiPath('/orders/form-data'),
    statusBoard: backendApiPath('/orders/status-board'),
    byId: (orderId: number) => backendApiPath(`/orders/${orderId}`),
    restore: (orderId: number) => backendApiPath(`/orders/${orderId}/restore`),
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
    groups: orderGroupsRoute,
  },
  orderDetails: {
    productionStageEvent: (detailId: number, productionStatusId: number) =>
      backendApiPath(`/order-details/${detailId}/production-stage-events/${productionStatusId}`),
  },
  payments: {
    list: backendApiPath('/payments'),
    byId: (paymentId: number) => backendApiPath(`/payments/${paymentId}`),
  },
  cutJobs: {
    list: backendApiPath('/cut-jobs'),
    placements: backendApiPath('/cut-jobs/placements'),
    detailLastReady: backendApiPath('/cut-jobs/detail-last-ready'),
    /** Variant B Task 11: cut.view-gated sheet-type lookup (no sheet_materials.view required). */
    sheetTypes: backendApiPath('/cut-jobs/sheet-types'),
    byId: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}`),
    results: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/results`),
    result: (cutJobId: number, resultNo: number) => backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}`),
    items: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/items`),
    item: (cutJobId: number, itemId: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/items/${itemId}`),
    calculate: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/calculate`),
    eligibleDetails: (cutJobId: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/eligible-details`),
    sheetPng: (cutJobId: number, groupId: number, sheetIndex: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/groups/${groupId}/sheets/${sheetIndex}.png`),
    resultSheetPng: (cutJobId: number, resultNo: number, groupId: number, sheetIndex: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}/groups/${groupId}/sheets/${sheetIndex}.png`),
    sheetSvg: (cutJobId: number, groupId: number, sheetIndex: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/groups/${groupId}/sheets/${sheetIndex}.svg`),
    resultSheetSvg: (cutJobId: number, resultNo: number, groupId: number, sheetIndex: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}/groups/${groupId}/sheets/${sheetIndex}.svg`),
    groupPdf: (cutJobId: number, groupId: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/groups/${groupId}/export.pdf`),
    resultGroupPdf: (cutJobId: number, resultNo: number, groupId: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}/groups/${groupId}/export.pdf`),
    jobPdf: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/export.pdf`),
    resultJobPdf: (cutJobId: number, resultNo: number) => backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}/export.pdf`),
    jobPdfTemplate: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/pdf-template`),
    groupPdfTemplate: (cutJobId: number, groupId: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/groups/${groupId}/pdf-template`),
    profile: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/profile`),
    sheetMaterial: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/sheet-material`),
    combineFilms: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/combine-films`),
    splitByMaterial: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/split-by-material`),
    manualLayout: (cutJobId: number, groupId: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/groups/${groupId}/manual-layout`),
  },
  cutConfig: {
    root: backendApiPath('/cut-config'),
    setting: (key: string) => backendApiPath(`/cut-config/settings/${encodeURIComponent(key)}`),
    paramProfiles: backendApiPath('/cut-config/param-profiles'),
    paramProfile: (id: number) => backendApiPath(`/cut-config/param-profiles/${id}`),
    renderPresets: backendApiPath('/cut-config/render-presets'),
    renderPreset: (id: number) => backendApiPath(`/cut-config/render-presets/${id}`),
    pdfTemplates: backendApiPath('/cut-config/pdf-templates'),
    pdfTemplate: (id: number) => backendApiPath(`/cut-config/pdf-templates/${id}`),
  },
  sheetMaterials: {
    list: backendApiPath('/sheet-material-types'),
    byId: (id: number) => backendApiPath(`/sheet-material-types/${id}`),
  },
  labels: {
    fields: backendApiPath('/label-fields'),
    templates: backendApiPath('/label-templates'),
    template: (id: number) => backendApiPath(`/label-templates/${id}`),
    orderData: (orderId: number) => backendApiPath(`/orders/${orderId}/label-data`),
    orderPreview: (orderId: number) => backendApiPath(`/orders/${orderId}/labels/preview`),
    orderGenerate: (orderId: number) => backendApiPath(`/orders/${orderId}/labels/generate`),
    latest: (orderId: number) => backendApiPath(`/orders/${orderId}/labels/latest`),
    latestExport: (orderId: number) => backendApiPath(`/orders/${orderId}/labels/latest/export`),
    generationExport: (orderId: number, generationId: number) =>
      backendApiPath(`/orders/${orderId}/labels/generations/${generationId}/export`),
    detailPreview: backendApiPath('/labels/preview'),
    detailGenerate: backendApiPath('/labels/generate'),
    detailGenerationExport: (generationId: number) =>
      backendApiPath(`/labels/generations/${generationId}/export`),
    qrTemplates: backendApiPath('/label-qr-templates'),
    qrTemplate: (id: number) => backendApiPath(`/label-qr-templates/${id}`),
    scanResolve: () => backendApiPath('/labels/scan-resolve'),
    scanResolveImage: () => backendApiPath('/labels/scan-resolve-image'),
    ocrTemplates: backendApiPath('/label-ocr-templates'),
    ocrTemplate: (id: number) => backendApiPath(`/label-ocr-templates/${id}`),
    ocrTemplatePreview: () => backendApiPath('/label-ocr-templates/preview'),
    ocrTemplateTest: () => backendApiPath('/label-ocr-templates/test'),
  },
  clientPhones: {
    list: backendApiPath('/client-phones'),
    byId: (phoneId: number) => backendApiPath(`/client-phones/${phoneId}`),
  },
  dowelingOrders: {
    create: backendApiPath('/doweling-orders'),
  },
  bazis: {
    imports: backendApiPath('/bazis/imports'),
    projects: backendApiPath('/bazis/projects'),
    project: (id: number) => backendApiPath(`/bazis/projects/${id}`),
    node: (id: number) => backendApiPath(`/bazis/nodes/${id}`),
    nodeNotes: (id: number) => backendApiPath(`/bazis/nodes/${id}/notes`),
    revisionTree: (id: number) => backendApiPath(`/bazis/revisions/${id}/tree`),
    revisionNodesSearch: (id: number) => backendApiPath(`/bazis/revisions/${id}/nodes/search`),
    revisionMaterialsSummary: (id: number) => backendApiPath(`/bazis/revisions/${id}/materials-summary`),
    revisionOrders: (id: number) => backendApiPath(`/bazis/revisions/${id}/orders`),
    revisionEstimate: (id: number) => backendApiPath(`/bazis/revisions/${id}/estimate`),
    materialMappings: backendApiPath('/bazis/material-mappings'),
    pdfTablePatterns: backendApiPath('/bazis/pdf-table-patterns'),
    matchPdfTablePatterns: backendApiPath('/bazis/pdf-table-patterns/match'),
    pdfTablePattern: (fingerprint: string) => backendApiPath(`/bazis/pdf-table-patterns/${fingerprint}`),
    createOrder: (revisionId: number) => backendApiPath(`/bazis/revisions/${revisionId}/create-order`),
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
  statusAutomation: {
    rules: backendApiPath('/status-automation/rules'),
    ruleById: (ruleId: number) => backendApiPath(`/status-automation/rules/${ruleId}`),
    eventTypes: backendApiPath('/status-automation/event-types'),
  },
  groups: groupsRoutes,
  projects: {
    list: backendApiPath('/projects'),
    byId: (id: number | string) => backendApiPath(`/projects/${id}`),
    merge: (id: number | string) => backendApiPath(`/projects/${id}/merge`),
    moveOrder: (orderId: number | string) => backendApiPath(`/orders/${orderId}/project`),
  },
  org: {
    directions: backendApiPath('/org/directions'),
    directionById: (directionId: number) => backendApiPath(`/org/directions/${directionId}`),
    directionWithConfirm: (directionId: number) => backendApiPath(`/org/directions/${directionId}?confirm=true`),
    directionWorkshops: (directionId: number) => backendApiPath(`/org/directions/${directionId}/workshops`),
    directionWorkCenters: (directionId: number) => backendApiPath(`/org/directions/${directionId}/work-centers`),
    directionHeads: (directionId: number) => backendApiPath(`/org/directions/${directionId}/heads`),
    workshopHeads: (workshopId: number) => backendApiPath(`/org/workshops/${workshopId}/heads`),
    assignableUsers: backendApiPath('/org/lookups/assignable-users'),
    lookupWorkshops: backendApiPath('/org/lookups/workshops'),
    lookupWorkCenters: backendApiPath('/org/lookups/work-centers'),
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
