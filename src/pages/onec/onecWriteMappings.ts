import { backendApiPath } from '../../api/apiRoutes';
import { httpClient } from '../../api/httpClient';

/** ERP → 1C business commands, phase 1: mappings of ERP items to 1C objects (backend /onec/write-mappings). */
export interface OnecWriteMappingView {
  onecRef: string | null;
  onecName: string | null;
  onecRefStale: boolean;
  onecValue: Record<string, unknown> | null;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface OnecWriteMappingItem {
  erpKey: string;
  label: string;
  mapping: OnecWriteMappingView | null;
}

export interface OnecWriteMappingKindView {
  kind: string;
  label: string;
  refRequired: boolean;
  hasRef: boolean;
  valueOptions: { field: string; values: string[]; nullable: boolean } | null;
  candidatesCount: number | null;
  pendingNote: string | null;
  missing: number;
  /** Mapped to a 1C object that is no longer eligible for the kind. */
  invalid: number;
  ready: boolean;
  items: OnecWriteMappingItem[];
}

export interface OnecWriteMappingCandidate {
  ref: string;
  name: string | null;
  code: string | null;
  entity: string;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const KIND_PATTERN = /^[a-z_]{1,40}$/;
const ERP_KEY_PATTERN = /^[a-z_]+:[A-Za-z0-9_-]{1,64}$/;

function agentQuery(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error('Invalid 1C agent id');
  return `agentId=${encodeURIComponent(agentId)}`;
}

export const onecWriteMappingsApi = {
  list(agentId: string): Promise<{ sourceId: number; kinds: OnecWriteMappingKindView[] }> {
    return httpClient.get(backendApiPath(`/onec/write-mappings?${agentQuery(agentId)}`));
  },

  candidates(agentId: string, kind: string, search: string): Promise<{ kind: string; data: OnecWriteMappingCandidate[] }> {
    if (!AGENT_ID_PATTERN.test(agentId)) throw new Error('Invalid 1C agent id');
    if (!KIND_PATTERN.test(kind)) throw new Error('Invalid mapping kind');
    const query = new URLSearchParams({ agentId, kind });
    if (search.trim()) query.set('search', search.trim().slice(0, 100));
    return httpClient.get(backendApiPath(`/onec/write-mappings/candidates?${query.toString()}`));
  },

  put(agentId: string, kind: string, erpKey: string, body: { onecRef: string | null; onecValue: Record<string, unknown> | null; expectedVersion: number | null }):
    Promise<{ changed: boolean; mapping: OnecWriteMappingView | null }> {
    if (!KIND_PATTERN.test(kind) || !ERP_KEY_PATTERN.test(erpKey)) throw new Error('Invalid mapping key');
    return httpClient.put(backendApiPath(`/onec/write-mappings/${kind}/${encodeURIComponent(erpKey)}?${agentQuery(agentId)}`), body);
  },
};

/** Default agent of the tab: the first active one (stage keeps a blocked copy of the production agent). */
export function defaultWriteMappingAgent(agents: ReadonlyArray<{ agentId: string; status: string }>): string {
  return agents.find((agent) => agent.status === 'active')?.agentId ?? agents[0]?.agentId ?? '';
}

/** Label of a fixed 1C value («ВРаботе» → «В работе»). */
export function onecValueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '— пусто —';
  const labels: Record<string, string> = { ВРаботе: 'В работе', ГотовКВыдаче: 'Готов к выдаче', Запланирован: 'Запланирован', Выдан: 'Выдан', Успешно: 'Успешно', Отменен: 'Отменён' };
  return labels[String(value)] ?? String(value);
}
