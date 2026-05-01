import { httpClient } from './httpClient';
import type {
  ChangeOrderStatusRequest,
  DeleteOrderResponse,
  OrderDto,
  OrderListQuery,
  OrderListResponse,
  OrderResponse,
  SaveOrderDto,
  SaveOrderResponse,
} from './types/orderApi.types';

export const ordersApi = {
  list(params: OrderListQuery = {}): Promise<OrderListResponse> {
    return httpClient.get<OrderListResponse>(withQuery('/api/orders', params));
  },

  async getById(orderId: number): Promise<OrderDto> {
    const response = await httpClient.get<OrderResponse>(`/api/orders/${validateOrderId(orderId)}`);
    return response.order;
  },

  create(dto: SaveOrderDto): Promise<SaveOrderResponse> {
    return httpClient.post<SaveOrderResponse>('/api/orders', dto);
  },

  update(orderId: number, dto: SaveOrderDto): Promise<SaveOrderResponse> {
    return httpClient.put<SaveOrderResponse>(`/api/orders/${validateOrderId(orderId)}`, dto);
  },

  changeStatus(
    orderId: number,
    request: ChangeOrderStatusRequest,
  ): Promise<OrderResponse> {
    return httpClient.patch<OrderResponse>(
      `/api/orders/${validateOrderId(orderId)}/status`,
      request,
    );
  },

  delete(orderId: number): Promise<DeleteOrderResponse> {
    return httpClient.delete<DeleteOrderResponse>(`/api/orders/${validateOrderId(orderId)}`);
  },
};

export function withQuery(path: string, params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export function validateOrderId(orderId: number): number {
  if (!Number.isInteger(orderId) || orderId < 1) {
    throw new Error('Invalid orderId');
  }

  return orderId;
}
