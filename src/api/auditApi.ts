import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type { AuditLogListQuery, AuditLogListResponse } from './types/auditApi.types';

export const auditApi = {
  list(params: AuditLogListQuery = {}): Promise<AuditLogListResponse> {
    return httpClient.get<AuditLogListResponse>(withQuery(apiRoutes.audit.list, params));
  },
};
