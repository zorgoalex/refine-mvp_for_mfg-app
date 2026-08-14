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
    workosInvitationStart: backendApiPath('/auth/workos/invitations/start'),
    workosInvitationCallback: backendApiPath('/auth/workos/invitations/callback'),
    workosLinks: backendApiPath('/auth/workos/links'),
    workosSettings: backendApiPath('/auth/workos/settings'),
    workosLinkById: (identityId: string) => backendApiPath(`/auth/workos/links/${identityId}`),
    workosAdminLinks: (userId: string) => backendApiPath(`/auth/workos/admin/users/${userId}/links`),
    workosAdminLinkById: (userId: string, identityId: string) =>
      backendApiPath(`/auth/workos/admin/users/${userId}/links/${identityId}`),
    workosAdminSettings: (userId: string) =>
      backendApiPath(`/auth/workos/admin/users/${userId}/settings`),
    workosAdminInvitations: (userId: string) =>
      backendApiPath(`/auth/workos/admin/users/${userId}/invitations`),
  },
  profile: {
    preferences: backendApiPath('/me/preferences'),
    referenceUsage: backendApiPath('/me/preferences/reference-usage'),
    telegramNotifications: backendApiPath('/me/notification-channels/telegram'),
    telegramNotificationsLink: backendApiPath('/me/notification-channels/telegram/link'),
  },
  orders: {
    list: backendApiPath('/orders'),
    formData: backendApiPath('/orders/form-data'),
    resourceDemands: backendApiPath('/orders/resource-demands'),
    statusBoard: backendApiPath('/orders/status-board'),
    statusBoardMdfManualMoves: backendApiPath('/orders/status-board/mdf-manual-moves'),
    statusBoardMdfManualMove: (cardKind: string, cardId: string) =>
      backendApiPath(`/orders/status-board/mdf-manual-moves/${encodeURIComponent(cardKind)}/${encodeURIComponent(cardId)}`),
    byId: (orderId: number) => backendApiPath(`/orders/${orderId}`),
    recalculateHdf: (orderId: number) => backendApiPath(`/orders/${orderId}/recalculate-hdf`),
    refresh: (orderId: number) => backendApiPath(`/orders/${orderId}/refresh`),
    detailLiveState: (orderId: number) =>
      backendApiPath(`/orders/${orderId}/detail-live-state`),
    liveEvents: (orderId: number) => backendApiPath(`/orders/${orderId}/live-events`),
    transferTargets: (orderId: number) => backendApiPath(`/orders/${orderId}/transfer-targets`),
    transferDetails: (orderId: number) => backendApiPath(`/orders/${orderId}/details/transfer`),
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
    filmOptions: backendApiPath('/cut-jobs/film-options'),
    eligibleDetailsPreview: backendApiPath('/cut-jobs/eligible-details'),
    byId: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}`),
    deleteImpact: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/delete-impact`),
    results: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/results`),
    result: (cutJobId: number, resultNo: number) => backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}`),
    resultCurrent: (cutJobId: number, resultNo: number) => backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}/current`),
    resultArchive: (cutJobId: number, resultNo: number) => backendApiPath(`/cut-jobs/${cutJobId}/results/${resultNo}/archive`),
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
    name: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/name`),
    groupPdfTemplate: (cutJobId: number, groupId: number) =>
      backendApiPath(`/cut-jobs/${cutJobId}/groups/${groupId}/pdf-template`),
    profile: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/profile`),
    sheetMaterial: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/sheet-material`),
    combineFilms: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/combine-films`),
    splitByMaterial: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/split-by-material`),
    rotationAllowed: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/rotation-allowed`),
    textureDirection: (cutJobId: number) => backendApiPath(`/cut-jobs/${cutJobId}/texture-direction`),
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
    pdfTemplateFields: backendApiPath('/cut-config/pdf-template-fields'),
    pdfTemplates: backendApiPath('/cut-config/pdf-templates'),
    pdfTemplate: (id: number) => backendApiPath(`/cut-config/pdf-templates/${id}`),
  },
  productionTechSettings: {
    hdf: backendApiPath('/production-tech-settings/hdf'),
    extraResources: backendApiPath('/production-tech-settings/hdf/extra-resources'),
    extraResource: (extraResourceId: number) =>
      backendApiPath(`/production-tech-settings/hdf/extra-resources/${extraResourceId}`),
    hdfMillingType: (millingTypeId: number) =>
      backendApiPath(`/production-tech-settings/hdf/milling-types/${millingTypeId}`),
  },
  cncTelegram: {
    today: backendApiPath('/cnc-telegram/today'),
    ingest: backendApiPath('/cnc-telegram/ingest'),
    manualSvgUpload: backendApiPath('/cnc-telegram/manual-svg-upload'),
    manualSvgCommentPresets: backendApiPath('/cnc-telegram/manual-svg-comment-presets'),
    autoCutStatus: backendApiPath('/cnc-telegram/auto-cut-status'),
    orderCuttingSequences: (orderId: number) => backendApiPath(`/cnc-telegram/orders/${orderId}/cutting-sequences`),
    orderScreenshots: (orderId: number) => backendApiPath(`/cnc-telegram/orders/${orderId}/screenshots`),
    orderManualSvgFile: (orderId: number, fileId: string) =>
      backendApiPath(`/cnc-telegram/orders/${orderId}/manual-svg-files/${encodeURIComponent(fileId)}`),
    orderScreenshotPreview: (orderId: number, packetId: string) =>
      backendApiPath(`/cnc-telegram/orders/${orderId}/screenshots/${encodeURIComponent(packetId)}/preview`),
    orderScreenshotImage: (orderId: number, packetId: string) =>
      backendApiPath(`/cnc-telegram/orders/${orderId}/screenshots/${encodeURIComponent(packetId)}/image`),
    orderScreenshotRestore: (orderId: number, packetId: string) =>
      backendApiPath(`/cnc-telegram/orders/${orderId}/screenshots/${encodeURIComponent(packetId)}/restore`),
    workerLogs: backendApiPath('/cnc-telegram/worker-logs'),
    workerLogsExport: backendApiPath('/cnc-telegram/worker-logs/export'),
  },
  sheetMaterials: {
    list: backendApiPath('/sheet-material-types'),
    byId: (id: number) => backendApiPath(`/sheet-material-types/${id}`),
  },
  labels: {
    fields: backendApiPath('/label-fields'),
    templates: backendApiPath('/label-templates'),
    rendererCapabilities: backendApiPath('/label-templates/renderer-capabilities'),
    template: (id: number) => backendApiPath(`/label-templates/${id}`),
    orderData: (orderId: number) => backendApiPath(`/orders/${orderId}/label-data`),
    orderPreview: (orderId: number) => backendApiPath(`/orders/${orderId}/labels/preview`),
    orderGenerate: (orderId: number) => backendApiPath(`/orders/${orderId}/labels/generate`),
    orderCutMapOptions: (orderId: number) => backendApiPath(`/orders/${orderId}/labels/cut-map-options`),
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
    projectDesignEngineer: (id: number) => backendApiPath(`/bazis/projects/${id}/design-engineer`),
    node: (id: number) => backendApiPath(`/bazis/nodes/${id}`),
    nodeNotes: (id: number) => backendApiPath(`/bazis/nodes/${id}/notes`),
    revisionTree: (id: number) => backendApiPath(`/bazis/revisions/${id}/tree`),
    revisionNodesSearch: (id: number) => backendApiPath(`/bazis/revisions/${id}/nodes/search`),
    revisionMaterialsSummary: (id: number) => backendApiPath(`/bazis/revisions/${id}/materials-summary`),
    revisionOrders: (id: number) => backendApiPath(`/bazis/revisions/${id}/orders`),
    revisionEstimate: (id: number) => backendApiPath(`/bazis/revisions/${id}/estimate`),
    revisionCutXls: (id: number) => backendApiPath(`/bazis/revisions/${id}/export-cut.xls`),
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
  deadlineDefaultSchedule: {
    root: backendApiPath('/deadline-default-schedule'),
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
    filterOptions: backendApiPath('/audit/filter-options'),
    orderOptions: backendApiPath('/audit/order-options'),
    participantOptions: backendApiPath('/audit/participant-options'),
  },
} as const;
