import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  BitrixAuditStatus, BitrixQueueQuery, BitrixQueueResponse,
  AuditFilterOptionsResponse,
  AuditLogListQuery,
  AuditLogListResponse,
  AuditLookupOptionsQuery,
  AuditOrderFilterOptionsResponse,
  AuditParticipantFilterOptionsResponse,
} from './types/auditApi.types';

type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];

export function withAuditQuery<T extends { [K in keyof T]: QueryValue }>(path: string, params: T = {} as T): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === '' || item === null || item === undefined) continue;
        searchParams.append(key, String(item));
      }
      continue;
    }
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export const auditApi = {
  bitrixStatus(): Promise<BitrixAuditStatus> { return httpClient.get(apiRoutes.audit.bitrixStatus); },
  bitrixQueue(query: BitrixQueueQuery): Promise<BitrixQueueResponse> { return httpClient.get(withAuditQuery(apiRoutes.audit.bitrixQueue, query)); },
  bitrixEvents(search?: string): Promise<{ data: Array<{ event: string; label: string }> }> { return httpClient.get(withAuditQuery(apiRoutes.audit.bitrixEvents, { search })); },
  list(params: AuditLogListQuery = {}): Promise<AuditLogListResponse> {
    return httpClient.get<AuditLogListResponse>(withAuditQuery(apiRoutes.audit.list, params));
  },
  filterOptions(params: { scope?: 'all' | 'business' | 'bitrix24'; excludeBitrix24?: boolean } = {}): Promise<AuditFilterOptionsResponse> {
    return httpClient.get<AuditFilterOptionsResponse>(withAuditQuery(apiRoutes.audit.filterOptions, params));
  },
  orderOptions(params: AuditLookupOptionsQuery = {}): Promise<AuditOrderFilterOptionsResponse> {
    return httpClient.get<AuditOrderFilterOptionsResponse>(withAuditQuery(apiRoutes.audit.orderOptions, params));
  },
  participantOptions(params: AuditLookupOptionsQuery = {}): Promise<AuditParticipantFilterOptionsResponse> {
    return httpClient.get<AuditParticipantFilterOptionsResponse>(
      withAuditQuery(apiRoutes.audit.participantOptions, params),
    );
  },
};
