import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  AddOnecAllocationRequest,
  OnecAllocationResultDto,
  OnecDocumentCardResponse,
  OnecDocumentListParams,
  OnecDocumentListResponse,
  RemoveOnecAllocationRequest,
} from './types/onecDocumentsApi.types';

export const onecDocumentsApi = {
  list(params: OnecDocumentListParams): Promise<OnecDocumentListResponse> {
    return httpClient.get<OnecDocumentListResponse>(withQuery(apiRoutes.onecDocuments.list, params));
  },

  getCard(documentId: number): Promise<OnecDocumentCardResponse> {
    return httpClient.get<OnecDocumentCardResponse>(
      apiRoutes.onecDocuments.card(validatePositiveId(documentId, 'documentId')),
    );
  },

  addAllocation(
    documentId: number,
    lineId: number,
    body: AddOnecAllocationRequest,
  ): Promise<OnecAllocationResultDto> {
    return httpClient.post<OnecAllocationResultDto>(
      apiRoutes.onecDocuments.allocations(
        validatePositiveId(documentId, 'documentId'),
        validatePositiveId(lineId, 'lineId'),
      ),
      body,
    );
  },

  removeAllocation(
    documentId: number,
    lineId: number,
    allocationId: number,
    body: RemoveOnecAllocationRequest,
  ): Promise<OnecAllocationResultDto> {
    return httpClient.delete<OnecAllocationResultDto>(
      apiRoutes.onecDocuments.allocation(
        validatePositiveId(documentId, 'documentId'),
        validatePositiveId(lineId, 'lineId'),
        validatePositiveId(allocationId, 'allocationId'),
      ),
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },
};

function validatePositiveId(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
