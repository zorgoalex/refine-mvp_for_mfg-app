import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  DuplicateCaseDetail,
  DuplicateCommandBody,
  DuplicateListQuery,
  DuplicateListResult,
  DuplicateRule,
} from './integrationDuplicatesApiTypes';

/** Query string of the journal list; empty filters are left out. */
export function buildDuplicatesQuery(query: DuplicateListQuery): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, String(value));
  };
  put('status', query.status);
  put('entityKind', query.entityKind);
  put('ruleCode', query.ruleCode);
  put('system', query.system);
  put('from', query.from);
  put('to', query.to);
  put('search', query.search?.trim());
  put('page', query.page);
  put('pageSize', query.pageSize);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const integrationDuplicatesApi = {
  list: (query: DuplicateListQuery) =>
    httpClient.get<DuplicateListResult>(`${apiRoutes.integrationDuplicates.list}${buildDuplicatesQuery(query)}`),
  rules: () => httpClient.get<DuplicateRule[]>(apiRoutes.integrationDuplicates.rules),
  detail: (caseId: number) => httpClient.get<DuplicateCaseDetail>(apiRoutes.integrationDuplicates.detail(caseId)),
  command: (caseId: number, action: 'dismiss' | 'external' | 'reopen', body: DuplicateCommandBody) =>
    httpClient.post<DuplicateCaseDetail>(apiRoutes.integrationDuplicates.command(caseId, action), body),
};
