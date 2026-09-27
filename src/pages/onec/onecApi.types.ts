/**
 * Wire types for the 1C integration admin API (backend module
 * backend/src/modules/onec-agent/**). Shapes mirror
 * OnecAdminService (agentView/certificateView/getConfiguration/etc.) exactly.
 */

export const ONEC_AGENT_MODES = [
  'Normal',
  'PauseEtl',
  'PauseCommands',
  'Drain',
  'Maintenance',
  'Disabled',
] as const;
export type OnecAgentMode = (typeof ONEC_AGENT_MODES)[number];

export const ONEC_COMMAND_TYPES = [
  'integration_probe',
  'create_customer_order',
  'update_customer_order',
  'post_customer_order',
  'cancel_customer_order',
  'create_material_movement',
  'create_material_receipt',
  'create_material_writeoff',
  'create_payment_document',
] as const;
export type OnecCommandType = (typeof ONEC_COMMAND_TYPES)[number];

export type OnecAgentStatus = 'active' | 'blocked';
export type OnecConnectionState = 'online' | 'silent' | 'never_seen';
export type OnecHeartbeatState =
  | 'healthy'
  | 'degraded'
  | 'offline_onec'
  | 'storage_critical'
  | 'maintenance'
  | 'incompatible_version';
export type OnecSourceIdentityStatus = 'unverified' | 'bound' | 'identity_changed';
export type OnecCertificateStatus = 'active' | 'revoked';
export type OnecAlertSeverity = 'info' | 'warning' | 'critical';
export type OnecAlertState = 'open' | 'acknowledged' | 'resolved';

export interface OnecSourceIdentity {
  databaseId: string;
  exportEpoch: string;
  environment: string;
}

export interface OnecAgentSource {
  sourceId: number;
  code: string;
  displayName: string;
  identityStatus: OnecSourceIdentityStatus;
  identity: OnecSourceIdentity | null;
}

export interface OnecAgentQueues {
  commandsPending?: number;
  resultsPending?: number;
  etlBatchesPending?: number;
  deadLetters?: number;
}

export interface OnecAgentOneCStatus {
  odataAvailable?: boolean;
  commandApiAvailable?: boolean;
  lastSuccessAtUtc?: string | null;
  lastError?: string | null;
}

export interface OnecAgentCertificateSummary {
  reportedExpiresAt: string | null;
  nearestRegisteredNotAfter: string | null;
  activeCount: number;
}

export interface OnecAgentConfigSummary {
  publishedVersion: number | null;
  activeVersion: number | null;
  rejectedVersion: number | null;
  rejectedReason: string | null;
  publishBlocked: boolean;
}

export interface OnecAgentView {
  agentId: string;
  displayName: string;
  siteId: string;
  status: OnecAgentStatus;
  version: number;
  minimumAgentVersion: string;
  source: OnecAgentSource;
  connection: OnecConnectionState;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  state: OnecHeartbeatState | null;
  stateReason: string | null;
  queues: OnecAgentQueues | null;
  oneC: OnecAgentOneCStatus | null;
  certificate: OnecAgentCertificateSummary;
  config: OnecAgentConfigSummary;
  openAlerts: number;
}

export interface OnecOverview {
  heartbeatIntervalMs: number;
  silentAfterMs: number;
  monitorOwner: string;
  openAlerts: number;
  agents: OnecAgentView[];
}

export interface OnecSourceListItem {
  sourceId: number;
  code: string;
  displayName: string;
  identity: OnecSourceIdentity | null;
  identityStatus: OnecSourceIdentityStatus;
  generation: number;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnecCertificate {
  certId: number;
  sha256Fingerprint: string;
  subject: string | null;
  notBefore: string | null;
  notAfter: string | null;
  status: OnecCertificateStatus;
  addedAt: string;
  revokedAt: string | null;
}

export interface OnecAgentHistoryItem {
  at: string;
  state: string;
  stateReason: string | null;
  /** Backend `historySummary()`: sampled heartbeat facts, not free text. */
  summary: OnecStatusHistorySummary | null;
}

export interface OnecAgentHeartbeatMachine {
  diskFreeBytes?: number;
  workingSetBytes?: number;
  cpuPercent?: number;
  sqliteSizeBytes?: number;
  spoolSizeBytes?: number;
}

export interface OnecAgentHeartbeatRaw {
  uptimeSeconds?: number;
  oneC?: OnecAgentOneCStatus;
  queues?: OnecAgentQueues;
  etl?: { lastSuccessAtUtc: string | null; currentRunId: string | null };
  machine?: OnecAgentHeartbeatMachine;
  certificate?: { expiresAtUtc: string | null };
  activeConfigVersion?: number | null;
  rejectedConfigVersion?: number | null;
  rejectedReason?: string | null;
}

export interface OnecAgentDetail extends OnecAgentView {
  heartbeat: OnecAgentHeartbeatRaw | null;
  certificates: OnecCertificate[];
  history: OnecAgentHistoryItem[];
}

export interface OnecEtlEntity {
  entityCode: string;
  oDataPath: string;
  keyField?: string;
  keyFields?: string[];
  updatedAtField?: string | null;
  updatedAtEdmType?: 'Edm.DateTimeOffset' | 'Edm.DateTime' | null;
  deletedField?: string | null;
  select: string[];
  syncMode: string;
  pageSize: number;
  overlapMinutes: number;
  schemaVersion?: number;
  oDataVersion?: 3 | 4;
  enabled?: boolean;
}

export interface OnecAgentConfiguration {
  mode: OnecAgentMode;
  commandTypes: string[];
  etlIntervalMinutes: number;
  etlEntities: OnecEtlEntity[];
}

export interface OnecConfigDraft {
  revision: number;
  configHash: string;
  configuration: OnecAgentConfiguration;
  updatedAt: string;
}

export interface OnecPublishedConfig {
  configVersion: number;
  configHash: string;
  configuration: OnecAgentConfiguration;
}

export interface OnecAgentReportedConfig {
  activeConfigVersion: number | null;
  rejectedConfigVersion: number | null;
  rejectedReason: string | null;
}

export interface OnecAgentConfigState {
  agentId: string;
  publishBlocked: boolean;
  draft: OnecConfigDraft | null;
  published: OnecPublishedConfig | null;
  agentReported: OnecAgentReportedConfig;
  defaults: OnecAgentConfiguration;
}

export interface OnecConfigIssue {
  path: string;
  message: string;
}

export type OnecConfigValidationResult =
  | { ok: true; configHash: string; bytes: number; issues: [] }
  | { ok: false; issues: OnecConfigIssue[] };

export interface OnecConfigVersion {
  configVersion: number;
  status: 'published' | 'superseded';
  configHash: string;
  publishedFromRevision: number;
  publishedAt: string;
  publishedBy: string | null;
  configuration: OnecAgentConfiguration;
}

export interface OnecAlert {
  alertId: number;
  kind: string;
  agentId: string;
  agentName: string | null;
  certId: number | null;
  severity: OnecAlertSeverity;
  state: OnecAlertState;
  details: unknown;
  openedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface OnecIncident {
  incidentId: number;
  agentId: string | null;
  kind: string;
  details: unknown;
  occurrences: number;
  firstAt: string;
  lastAt: string;
  resolvedAt: string | null;
}

export interface OnecStatusHistorySummary {
  version?: string | null;
  odataAvailable?: boolean | null;
  commandApiAvailable?: boolean | null;
  queues?: {
    commandsPending?: number;
    resultsPending?: number;
    etlBatchesPending?: number;
    deadLetters?: number;
  } | null;
  diskFreeBytes?: number | null;
}
