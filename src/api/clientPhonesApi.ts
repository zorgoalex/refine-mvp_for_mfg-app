import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  ClientPhoneDto,
  ClientPhoneResponse,
  CreateClientPhoneRequest,
  DeleteClientPhoneResponse,
  UpdateClientPhoneRequest,
} from './types/clientPhoneApi.types';

export const clientPhonesApi = {
  async create(request: CreateClientPhoneRequest): Promise<ClientPhoneDto> {
    const response = await httpClient.post<ClientPhoneResponse>(apiRoutes.clientPhones.list, {
      ...request,
      idempotencyKey: request.idempotencyKey ?? createClientPhoneIdempotencyKey('client-phone-create'),
    });
    return response.phone;
  },

  async update(phoneId: number, request: UpdateClientPhoneRequest): Promise<ClientPhoneDto> {
    const response = await httpClient.patch<ClientPhoneResponse>(
      apiRoutes.clientPhones.byId(validateClientPhoneId(phoneId)),
      {
        ...request,
        idempotencyKey: request.idempotencyKey ?? createClientPhoneIdempotencyKey('client-phone-update'),
      },
    );
    return response.phone;
  },

  delete(phoneId: number): Promise<DeleteClientPhoneResponse> {
    return httpClient.request<DeleteClientPhoneResponse>(
      apiRoutes.clientPhones.byId(validateClientPhoneId(phoneId)),
      {
        method: 'DELETE',
        body: JSON.stringify({
          idempotencyKey: createClientPhoneIdempotencyKey('client-phone-delete'),
        }),
      },
    );
  },
};

export function createClientPhoneIdempotencyKey(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}:${uuid}`;
}

export function validateClientPhoneId(phoneId: number): number {
  if (!Number.isInteger(phoneId) || phoneId < 1) {
    throw new Error('Invalid phoneId');
  }

  return phoneId;
}
