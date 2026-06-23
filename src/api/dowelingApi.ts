import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  CreateDowelingOrderRequest,
  CreateDowelingOrderResponse,
} from './types/dowelingApi.types';

/**
 * Backend-owned doweling quick-create client (CLAUDE.md principle 2/3): the create goes through the
 * audited `POST /api/v1/doweling-orders` command, never a page-level Hasura write. Auth token is
 * auto-attached by httpClient.
 */
export const dowelingApi = {
  create(request: CreateDowelingOrderRequest): Promise<CreateDowelingOrderResponse> {
    return httpClient.post<CreateDowelingOrderResponse>(apiRoutes.dowelingOrders.create, request);
  },
};

/** Generate a per-command idempotency key (mirror createProductionActionIdempotencyKey). */
export function createDowelingIdempotencyKey(prefix = 'doweling-quick-create'): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}:${uuid}`;
}

export interface BuildCreateDowelingInput {
  dowelingOrderName: string;
  designEngineerId: number;
  paymentStatusId: number;
  idempotencyKey: string;
}

/**
 * Pure mapper form values → backend request DTO. Trims the name (server also trims, but keep the wire
 * payload clean). Unit-testable without React.
 */
export function buildCreateDowelingRequest(
  input: BuildCreateDowelingInput,
): CreateDowelingOrderRequest {
  return {
    dowelingOrderName: input.dowelingOrderName.trim(),
    designEngineerId: input.designEngineerId,
    paymentStatusId: input.paymentStatusId,
    idempotencyKey: input.idempotencyKey,
  };
}
