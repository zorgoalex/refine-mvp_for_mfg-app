import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

export interface SignalConfiguration {
  version: number;
  sources: { code: string; name: string; channel: 'whatsapp'; connection: string; chatId: string; enabled: boolean }[];
  signals: { code: string; name: string }[];
  resolvers: { code: string; name: string; target: 'order_id'|'order_name'|'cut_id'|'project_code'; prefixes: string[]; format: 'digits'|'code' }[];
  rules: { code: string; name: string; sourceCodes: string[]; signalCode: string; resolverCode: string; keywords: string[]; exclusions: string[]; matchMode: 'phrase'|'contains'|'exact'; enabled: boolean; priority: number }[];
}
export interface SignalRow {
  id: string | null; message_id: string; channel: string; source_name: string; source_code: string;
  sender: string; message_text: string; sent_at: string; received_at: string;
  signal_code: string | null; signal_name: string | null; state: string | null;
  reason_code: string | null; order_id: string | null; order_name: string | null; version: number;
}
export interface SignalList { items: SignalRow[]; total: number; attention: number; completed: number; relayEnabled: boolean; automationEnabled: boolean }
export interface SignalDetail {
  id: string; version: number; signalCode: string; signalName: string; orderId: string | null; state: string;
  message: Pick<SignalRow, 'channel'|'source_name'|'sender'|'message_text'|'sent_at'|'received_at'>;
  steps: { occurred_at: string; event_code: string; actor_user_id: string | null; details: Record<string, unknown> }[];
  actions: { event: string; occurred_at: string; rule_name: string; reason: string | null; action_type: string; target_status_id: string | null }[];
  technical?: { requestId: string; configVersion: number; ruleCodes: string[]; attemptCount: number };
}
export interface SignalPreview { previewHash: string; version: number; automationEnabled: boolean; order: { order_id: string; order_name: string }; applied: { id: number; name: string; actionType: string; targetStatusId: number | null }[]; skipped: unknown[] }
function withQuery(path: string, query: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)); });
  return `${path}?${params}`;
}
export const inboundSignalsApi = {
  list: (query: Record<string, string | number | undefined>) => httpClient.get<SignalList>(withQuery(apiRoutes.inboundSignals.list, query)),
  detail: (id: string) => httpClient.get<SignalDetail>(apiRoutes.inboundSignals.detail(id)),
  orders: (q: string) => httpClient.get<{ id: string; name: string }[]>(withQuery(apiRoutes.inboundSignals.orders, { q })),
  preview: (id: string, version: number, orderId: number) => httpClient.post<SignalPreview>(apiRoutes.inboundSignals.command(id, 'resolve-preview'), { version, orderId }),
  command: (id: string, action: 'resolve'|'dismiss'|'retry', body: { version: number; orderId?: number; previewHash?: string; reason?: string }, key: string) => httpClient.post(apiRoutes.inboundSignals.command(id, action), body, { headers: { 'Idempotency-Key': key } }),
  configuration: () => httpClient.get<SignalConfiguration>(apiRoutes.inboundSignals.configuration),
  saveConfiguration: (body: SignalConfiguration) => httpClient.put<SignalConfiguration>(apiRoutes.inboundSignals.configuration, body),
  test: (configuration: SignalConfiguration, text: string, source: string) => httpClient.post<{ ruleCode: string; signalCode: string; references: string[] }[]>(apiRoutes.inboundSignals.test, { configuration, text, source }),
};
