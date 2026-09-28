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

/** Admin commands the agent executes itself (spec §4.6); reconcile_* are not implemented by the agent. */
export const ONEC_ADMIN_COMMAND_TYPES = [
  'start_full_sync',
  'reload_entity',
  'pause_etl',
  'resume_etl',
  'run_connectivity_test',
  'collect_diagnostics',
  'rotate_certificate_hint',
] as const;
export type OnecAdminCommandType = (typeof ONEC_ADMIN_COMMAND_TYPES)[number];

/** Command types the "Отправить команду" dialog may send: admin commands + the business probe. */
export const ONEC_OPERATOR_COMMAND_TYPES = [...ONEC_ADMIN_COMMAND_TYPES, 'integration_probe'] as const;
export type OnecOperatorCommandType = (typeof ONEC_OPERATOR_COMMAND_TYPES)[number];

export type OnecCommandKind = 'admin' | 'business';

export const ONEC_COMMAND_STATUSES = [
  'queued',
  'leased',
  'received',
  'succeeded',
  'business_error',
  'dead_letter',
  'expired',
  'cancelled',
  'expired_undelivered',
] as const;
export type OnecCommandStatus = (typeof ONEC_COMMAND_STATUSES)[number];

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

/**
 * Shape of a PUBLISHED configuration only: the backend stamps the source's
 * generation token onto it at publish time (`OnecAdminService.publish`). A
 * draft is validated against the strict `onecAgentConfigurationSchema` and
 * MUST NOT carry this field (see `onecStripSourceGeneration` in onecFormat.ts).
 */
export type OnecPublishedAgentConfiguration = OnecAgentConfiguration & { sourceGeneration?: string };

export interface OnecConfigDraft {
  revision: number;
  configHash: string;
  configuration: OnecAgentConfiguration;
  updatedAt: string;
}

export interface OnecPublishedConfig {
  configVersion: number;
  configHash: string;
  configuration: OnecPublishedAgentConfiguration;
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
  configuration: OnecPublishedAgentConfiguration;
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

export interface OnecCommandRequestedBy {
  userId: string;
  displayName: string;
}

/** Journal projection (`GET /onec/commands[/:commandId]`); mirrors backend `commandView()`. */
export interface OnecCommandView {
  commandId: string;
  agentId: string;
  commandType: string;
  commandKind: OnecCommandKind;
  status: OnecCommandStatus;
  priority: number;
  orderingKey: string | null;
  payloadHash: string;
  payloadBytes: number;
  notBeforeUtc: string | null;
  expiresAtUtc: string | null;
  requestedBy: OnecCommandRequestedBy | null;
  sourceModule: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  leaseCount: number;
  leasedAt: string | null;
  receivedAt: string | null;
  resultReceivedAt: string | null;
  resultErrorCode: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/**
 * `GET /onec/commands/:commandId` includes `payload`/`result` only when the
 * caller has onec.manage or onec.commands.send; both keys are absent otherwise.
 */
export interface OnecCommandDetail extends OnecCommandView {
  payload?: unknown;
  result?: unknown;
}

export interface OnecCommandSendResult extends OnecCommandDetail {
  created: boolean;
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

// ---------------------------------------------------------------- ETL tab (read-only journal, no row data)

export type OnecEtlLastStatus = 'done' | 'failed' | null;
export type OnecEtlReadScope = 'full' | 'delta' | null;
export type OnecEtlCompleteness = 'verified' | 'unverified' | 'not_checked' | null;

/** `GET /onec/etl/entities`; mirrors backend `OnecEtlAdminService.listEntities`. */
export interface OnecEtlEntityState {
  sourceId: number;
  entity: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastStatus: OnecEtlLastStatus;
  lastReadScope: OnecEtlReadScope;
  lastCompleteness: OnecEtlCompleteness;
  lastCompletenessReason: string | null;
  lastSnapshotAt: string | null;
  lastFullAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  rowCount: number;
  deletedCount: number;
  missingCount: number;
}

export type OnecEtlRunStatus = 'receiving' | 'completed' | 'abandoned';
export type OnecEtlRunMode = 'bootstrap_full' | 'entity_reload' | 'incremental' | null;

/** One entity's outcome inside a run's completion payload (agent RunCompletionV2/PartialV1). */
export interface OnecEtlRunEntitySummary {
  entity: string;
  status: 'done' | 'failed';
  readScope?: OnecEtlReadScope;
  completeness?: OnecEtlCompleteness;
  errorCode: string | null;
  errorMessage?: string | null;
  rows?: number;
  rowsRead?: number;
}

/** `GET /onec/etl/runs[?agentId=]`; mirrors backend `runView()`. */
export interface OnecEtlRun {
  runId: string;
  agentId: string;
  sourceId: number;
  sourceGeneration: number;
  status: OnecEtlRunStatus;
  mode: OnecEtlRunMode;
  modeOrigin: string | null;
  commandId: string | null;
  batchCount: number;
  rowTotal: number;
  entitiesFailed: number | null;
  entities: OnecEtlRunEntitySummary[] | null;
  createdAt: string;
  firstBatchAt: string | null;
  completedAt: string | null;
}

export type OnecEtlBatchStatus = 'receiving' | 'stored' | 'parsing' | 'parsed' | 'invalid' | 'discarded' | 'finalized';

export interface OnecEtlBatch {
  batchId: string;
  entity: string;
  status: OnecEtlBatchStatus;
  rowCount: number;
  parsedRows: number | null;
  invalidReason: string | null;
  parseAttempt: number;
  receivedAt: string | null;
  acknowledged: boolean;
}

/** `GET /onec/etl/runs/:runId`: the run plus its batches. */
export interface OnecEtlRunDetail extends OnecEtlRun {
  batches: OnecEtlBatch[];
}
