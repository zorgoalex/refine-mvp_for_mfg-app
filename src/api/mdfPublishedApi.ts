import { apiRoutes } from './apiRoutes';
import { authSession } from './authSession';
import { httpClient } from './httpClient';
import type { MdfPublishedQuery, MdfPublishedSnapshot, MdfSessionSnapshot } from './types/mdfPublishedApi.types';

export function assertMdfSession(generation: number): void {
  if (authSession.getSessionGeneration()!==generation || !authSession.getUser()) {
    throw new Error('MDF_SESSION_CHANGED');
  }
}

export const mdfPublishedApi = {
  async get(query: MdfPublishedQuery = {},signal?: AbortSignal): Promise<MdfSessionSnapshot> {
    const sessionGeneration=authSession.getSessionGeneration();
    assertMdfSession(sessionGeneration);
    const params=new URLSearchParams();
    if (query.dateTo!==undefined) params.set('dateTo',query.dateTo);
    if (query.focus) {
      params.set('focusKind',query.focus.kind);
      params.set('focusId',query.focus.id);
    }
    if (query.orderIds?.length) params.set('orderIds',query.orderIds.join(','));
    if (query.jobIds?.length) params.set('jobIds',query.jobIds.join(','));
    try {
      const snapshot=await httpClient.get<MdfPublishedSnapshot>(
        `${apiRoutes.orders.statusBoardMdfPublished}${params.size ? `?${params}` : ''}`,
        { signal,cache: 'no-store' },
      );
      assertMdfSession(sessionGeneration);
      if (snapshot.schemaVersion!==1 || !Array.isArray(snapshot.trackedJobs)) {
        throw new Error('MDF_PUBLICATION_CONTRACT_INVALID');
      }
      return { sessionGeneration,snapshot };
    } catch (error) {
      assertMdfSession(sessionGeneration);
      throw error;
    }
  },
};
