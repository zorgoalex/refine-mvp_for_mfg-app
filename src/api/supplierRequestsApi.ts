import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CreateSupplierRequestDraftsBody,
  CreateSupplierRequestDraftsResultDto,
  SupplierRequestCardDto,
  SupplierRequestCommandResultDto,
  SupplierRequestsListParams,
  SupplierRequestsListResponseDto,
  TransitionSupplierRequestBody,
  UpdateSupplierRequestBody,
} from './types/supplierRequestsApi.types';

export const supplierRequestsApi = {
  list(params: SupplierRequestsListParams, options?: { signal?: AbortSignal }): Promise<SupplierRequestsListResponseDto> {
    return httpClient.get<SupplierRequestsListResponseDto>(withQuery(apiRoutes.procurement.supplierRequests.list, params), options);
  },

  createDrafts(body: CreateSupplierRequestDraftsBody): Promise<CreateSupplierRequestDraftsResultDto> {
    return httpClient.post<CreateSupplierRequestDraftsResultDto>(apiRoutes.procurement.supplierRequests.drafts, body);
  },

  card(supplierRequestId: number): Promise<SupplierRequestCardDto> {
    return httpClient.get<SupplierRequestCardDto>(apiRoutes.procurement.supplierRequests.byId(supplierRequestId));
  },

  update(supplierRequestId: number, body: UpdateSupplierRequestBody): Promise<SupplierRequestCommandResultDto> {
    return httpClient.patch<SupplierRequestCommandResultDto>(apiRoutes.procurement.supplierRequests.byId(supplierRequestId), body);
  },

  send(supplierRequestId: number, body: TransitionSupplierRequestBody): Promise<SupplierRequestCommandResultDto> {
    return httpClient.post<SupplierRequestCommandResultDto>(apiRoutes.procurement.supplierRequests.send(supplierRequestId), body);
  },

  close(supplierRequestId: number, body: TransitionSupplierRequestBody): Promise<SupplierRequestCommandResultDto> {
    return httpClient.post<SupplierRequestCommandResultDto>(apiRoutes.procurement.supplierRequests.close(supplierRequestId), body);
  },

  cancel(supplierRequestId: number, body: TransitionSupplierRequestBody): Promise<SupplierRequestCommandResultDto> {
    return httpClient.post<SupplierRequestCommandResultDto>(apiRoutes.procurement.supplierRequests.cancel(supplierRequestId), body);
  },
};
