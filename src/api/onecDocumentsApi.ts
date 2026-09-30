import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  AddOnecAllocationRequest,
  AllocationSuggestionsResponse,
  BatchOnecAllocationRequest,
  BatchOnecAllocationResponse,
  OnecAllocationResultDto,
  OnecDocumentCardResponse,
  OnecDocumentListParams,
  OnecDocumentListResponse,
  RemoveOnecAllocationRequest,
  RequestLinkRequest,
  RequestLinkResultDto,
  UnlinkRequestLinkRequest,
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

  allocationSuggestions(documentId: number): Promise<AllocationSuggestionsResponse> {
    return httpClient.get<AllocationSuggestionsResponse>(
      apiRoutes.onecDocuments.allocationSuggestions(validatePositiveId(documentId, 'documentId')),
    );
  },

  allocateBatch(documentId: number, body: BatchOnecAllocationRequest): Promise<BatchOnecAllocationResponse> {
    return httpClient.post<BatchOnecAllocationResponse>(
      apiRoutes.onecDocuments.allocationsBatch(validatePositiveId(documentId, 'documentId')),
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

  /** Привязать распределение прихода к заказу строки отправленной заявки (ф.3б). */
  linkToRequest(
    documentId: number,
    lineId: number,
    allocationId: number,
    body: RequestLinkRequest,
  ): Promise<RequestLinkResultDto> {
    return httpClient.post<RequestLinkResultDto>(
      apiRoutes.onecDocuments.requestLinks(
        validatePositiveId(documentId, 'documentId'),
        validatePositiveId(lineId, 'lineId'),
        validatePositiveId(allocationId, 'allocationId'),
      ),
      body,
    );
  },

  /** Отвязать приход от заявки (ф.3б). */
  unlinkFromRequest(
    documentId: number,
    lineId: number,
    allocationId: number,
    linkId: number,
    body: UnlinkRequestLinkRequest,
  ): Promise<RequestLinkResultDto> {
    return httpClient.delete<RequestLinkResultDto>(
      apiRoutes.onecDocuments.requestLink(
        validatePositiveId(documentId, 'documentId'),
        validatePositiveId(lineId, 'lineId'),
        validatePositiveId(allocationId, 'allocationId'),
        validatePositiveId(linkId, 'linkId'),
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
