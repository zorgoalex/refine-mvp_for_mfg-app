import { backendApiPath } from '../../api/apiRoutes';
import { httpClient } from '../../api/httpClient';
import { onecIfMatchHeader } from './onecFormat';
import type {
  OnecAgentConfigState,
  OnecAgentConfiguration,
  OnecAgentDetail,
  OnecAgentView,
  OnecAlert,
  OnecCertificate,
  OnecConfigValidationResult,
  OnecConfigVersion,
  OnecIncident,
  OnecOverview,
  OnecSourceListItem,
} from './onecApi.types';

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function agentIdPath(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error('Invalid 1C agent id');
  return agentId;
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
};
