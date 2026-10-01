import { backendApiPath } from '../../api/apiRoutes';
import { httpClient } from '../../api/httpClient';
import { onecIfMatchHeader } from './onecFormat';
import type { OnecDailyJournal } from './onecJournal';
import type {
  OnecAgentConfigState,
  OnecAgentConfiguration,
  OnecAgentDetail,
  OnecAgentView,
  OnecAlert,
  OnecCertificate,
  OnecCommandDetail,
  OnecCommandSendResult,
  OnecCommandView,
  OnecConfigValidationResult,
  OnecConfigVersion,
  OnecCounterpartyMatchResult,
  OnecEntityRestoreResult,
  OnecEntityRevokeResult,
  OnecEtlEntityState,
  OnecEtlRun,
  OnecEtlRunDetail,
  OnecIncident,
  OnecItemDistributionResult,
  OnecMatchRoleFilter,
  OnecMatchStatusFilter,
  OnecMirrorListResult,
  OnecMirrorRowDetail,
  OnecMirrorState,
  OnecOverview,
  OnecSourceIdentity,
  OnecSourceListItem,
  OnecSourceRebaselineResult,
} from './onecApi.types';

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const COMMAND_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ENTITY_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function agentIdPath(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error('Invalid 1C agent id');
  return agentId;
}

function entityCodePath(entity: string): string {
  if (!ENTITY_CODE_PATTERN.test(entity)) throw new Error('Invalid 1C entity code');
  return entity;
}

function commandIdPath(commandId: string): string {
  if (!COMMAND_ID_PATTERN.test(commandId)) throw new Error('Invalid 1C command id');
  return commandId;
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid 1C id');
  return value;
}

function path(suffix: string): string {
  return backendApiPath(`/onec${suffix}`);
}

export const onecApi = {
  overview(): Promise<OnecOverview> {
    return httpClient.get(path('/overview'));
  },

  listSources(): Promise<OnecSourceListItem[]> {
    return httpClient.get(path('/sources'));
  },

  createSource(input: { code: string; displayName: string }): Promise<OnecSourceListItem> {
    return httpClient.post(path('/sources'), input);
  },

  updateSource(sourceId: number, input: { displayName: string }): Promise<OnecSourceListItem> {
    return httpClient.patch(path(`/sources/${positiveId(sourceId)}`), input);
  },

  createAgent(input: {
    agentId: string;
    sourceId: number;
    siteId: string;
    displayName: string;
    minimumAgentVersion?: string;
  }): Promise<OnecAgentView> {
    return httpClient.post(path('/agents'), input);
  },

  dailyJournal(agentId: string): Promise<OnecDailyJournal> {
    return httpClient.get(path(`/agents/${agentIdPath(agentId)}/journal/daily`));
  },

  getAgent(agentId: string): Promise<OnecAgentDetail> {
    return httpClient.get(path(`/agents/${agentIdPath(agentId)}`));
  },

  updateAgent(
    agentId: string,
    input: { version: number; siteId?: string; displayName?: string; minimumAgentVersion?: string },
  ): Promise<OnecAgentView> {
    return httpClient.patch(path(`/agents/${agentIdPath(agentId)}`), input);
  },

  blockAgent(agentId: string, version: number): Promise<OnecAgentView> {
    return httpClient.post(path(`/agents/${agentIdPath(agentId)}/block`), { version });
  },

  unblockAgent(agentId: string, version: number): Promise<OnecAgentView> {
    return httpClient.post(path(`/agents/${agentIdPath(agentId)}/unblock`), { version });
  },

  addCertificate(
    agentId: string,
    input: { pem: string } | { sha256Fingerprint: string },
  ): Promise<OnecCertificate> {
    return httpClient.post(path(`/agents/${agentIdPath(agentId)}/certificates`), input);
  },

  revokeCertificate(agentId: string, certId: number): Promise<OnecCertificate> {
    return httpClient.post(
      path(`/agents/${agentIdPath(agentId)}/certificates/${positiveId(certId)}/revoke`),
      {},
    );
  },

  getConfig(agentId: string): Promise<OnecAgentConfigState> {
    return httpClient.get(path(`/agents/${agentIdPath(agentId)}/config`));
  },

  validateConfig(configuration: unknown): Promise<OnecConfigValidationResult> {
    return httpClient.post(path('/config/validate'), { configuration });
  },

  /** revision=null means there is no draft yet: the If-Match header is omitted (spec). */
  saveDraft(
    agentId: string,
    revision: number | null,
    configuration: OnecAgentConfiguration,
  ): Promise<{ revision: number; configHash: string; configuration: OnecAgentConfiguration }> {
    return httpClient.put(
      path(`/agents/${agentIdPath(agentId)}/config/draft`),
      { configuration },
      { headers: onecIfMatchHeader(revision) },
    );
  },

  publish(
    agentId: string,
    revision: number,
    configHash: string,
  ): Promise<{ configVersion: number; configHash: string }> {
    return httpClient.post(path(`/agents/${agentIdPath(agentId)}/config/publish`), {
      revision,
      configHash,
    });
  },

  listConfigVersions(agentId: string): Promise<OnecConfigVersion[]> {
    return httpClient.get(path(`/agents/${agentIdPath(agentId)}/config/versions`));
  },

  listAlerts(params: { state?: string; agentId?: string } = {}): Promise<OnecAlert[]> {
    const query = new URLSearchParams();
    if (params.state) query.set('state', params.state);
    if (params.agentId) query.set('agentId', params.agentId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return httpClient.get(path(`/alerts${suffix}`));
  },

  acknowledgeAlert(alertId: number): Promise<{ alertId: number; state: string }> {
    return httpClient.post(path(`/alerts/${positiveId(alertId)}/acknowledge`), {});
  },

  resolveAlert(alertId: number): Promise<{ alertId: number; state: string }> {
    return httpClient.post(path(`/alerts/${positiveId(alertId)}/resolve`), {});
  },

  listIncidents(params: { open?: boolean; agentId?: string } = {}): Promise<OnecIncident[]> {
    const query = new URLSearchParams();
    if (params.open !== undefined) query.set('open', String(params.open));
    if (params.agentId) query.set('agentId', params.agentId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return httpClient.get(path(`/incidents${suffix}`));
  },

  resolveIncident(incidentId: number): Promise<{ incidentId: number; resolvedAt: string }> {
    return httpClient.post(path(`/incidents/${positiveId(incidentId)}/resolve`), {});
  },

  listCommands(
    params: { agentId?: string; status?: string; commandType?: string; limit?: number } = {},
  ): Promise<OnecCommandView[]> {
    const query = new URLSearchParams();
    if (params.agentId) query.set('agentId', params.agentId);
    if (params.status) query.set('status', params.status);
    if (params.commandType) query.set('commandType', params.commandType);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.size ? `?${query.toString()}` : '';
    return httpClient.get(path(`/commands${suffix}`));
  },

  getCommand(commandId: string): Promise<OnecCommandDetail> {
    return httpClient.get(path(`/commands/${commandIdPath(commandId)}`));
  },

  /** Idempotency-Key must be generated once per dialog open so a retry never creates a second command. */
  sendCommand(
    agentId: string,
    idempotencyKey: string,
    input: { commandType: string; payload: Record<string, unknown>; priority?: number },
  ): Promise<OnecCommandSendResult> {
    return httpClient.post(path(`/agents/${agentIdPath(agentId)}/commands`), input, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },

  cancelCommand(commandId: string): Promise<OnecCommandView> {
    return httpClient.post(path(`/commands/${commandIdPath(commandId)}/cancel`), {});
  },

  listEtlEntities(params: { agentId?: string } = {}): Promise<OnecEtlEntityState[]> {
    const query = new URLSearchParams();
    if (params.agentId) query.set('agentId', params.agentId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return httpClient.get(path(`/etl/entities${suffix}`));
  },

  listEtlRuns(params: { agentId?: string; limit?: number } = {}): Promise<OnecEtlRun[]> {
    const query = new URLSearchParams();
    if (params.agentId) query.set('agentId', params.agentId);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.size ? `?${query.toString()}` : '';
    return httpClient.get(path(`/etl/runs${suffix}`));
  },

  getEtlRun(runId: string): Promise<OnecEtlRunDetail> {
    return httpClient.get(path(`/etl/runs/${commandIdPath(runId)}`));
  },

  listEtlMirror(params: {
    agentId: string;
    entity: string;
    search?: string;
    state?: OnecMirrorState;
    offset?: number;
    limit?: number;
  }): Promise<OnecMirrorListResult> {
    const query = new URLSearchParams();
    query.set('agentId', agentIdPath(params.agentId));
    query.set('entity', entityCodePath(params.entity));
    if (params.search) query.set('search', params.search);
    if (params.state) query.set('state', params.state);
    if (params.offset) query.set('offset', String(params.offset));
    if (params.limit) query.set('limit', String(params.limit));
    return httpClient.get(path(`/etl/mirror?${query.toString()}`));
  },

  getEtlMirrorRow(params: { agentId: string; entity: string; key: string }): Promise<OnecMirrorRowDetail> {
    const query = new URLSearchParams({
      agentId: agentIdPath(params.agentId),
      entity: entityCodePath(params.entity),
      key: params.key,
    });
    return httpClient.get(path(`/etl/mirror/row?${query.toString()}`));
  },

  /** Personal-data entity only (`counterparty_phones`); write ban + purge + republish without it. */
  revokeEtlEntity(agentId: string, entity: string): Promise<OnecEntityRevokeResult> {
    return httpClient.post(path(`/agents/${agentIdPath(agentId)}/etl/entities/${entityCodePath(entity)}/revoke`), {});
  },

  restoreEtlEntity(agentId: string, entity: string): Promise<OnecEntityRestoreResult> {
    return httpClient.post(path(`/agents/${agentIdPath(agentId)}/etl/entities/${entityCodePath(entity)}/restore`), {});
  },

  /**
   * New source generation: open runs abandoned, the 1C copy cleared, configuration republished.
   * `expectedGeneration` must be the generation the operator last saw (409 ONEC_GENERATION_CHANGED
   * otherwise); `acceptIdentity` is required, and must equal the agent-reported `observedIdentity`
   * exactly, when the source's identity changed (409 ONEC_IDENTITY_CONFIRMATION_REQUIRED otherwise).
   */
  rebaselineSource(
    sourceId: number,
    input: { expectedGeneration: number; acceptIdentity?: OnecSourceIdentity },
  ): Promise<OnecSourceRebaselineResult> {
    return httpClient.post(path(`/sources/${positiveId(sourceId)}/rebaseline`), input);
  },

  /** Read-only report: 1C counterparties matched against ERP clients/suppliers (plan §9, E3c). */
  listMatchingCounterparties(params: {
    agentId: string;
    status?: OnecMatchStatusFilter;
    role?: OnecMatchRoleFilter;
    search?: string;
    offset?: number;
    limit?: number;
  }): Promise<OnecCounterpartyMatchResult> {
    const query = new URLSearchParams({ agentId: agentIdPath(params.agentId) });
    if (params.status) query.set('status', params.status);
    if (params.role) query.set('role', params.role);
    if (params.search) query.set('search', params.search);
    if (params.offset) query.set('offset', String(params.offset));
    if (params.limit) query.set('limit', String(params.limit));
    return httpClient.get(path(`/etl/matching/counterparties?${query.toString()}`));
  },

  /** Read-only report: 1C nomenclature per category and item type (plan §9, E3c). */
  getMatchingItems(agentId: string): Promise<OnecItemDistributionResult> {
    const query = new URLSearchParams({ agentId: agentIdPath(agentId) });
    return httpClient.get(path(`/etl/matching/items?${query.toString()}`));
  },
};
