import { apiRoutes } from './apiRoutes';
import { isApiError } from './apiError';
import { httpClient } from './httpClient';
import type {
  ChangeOrderStatusRequest,
  MoveCalendarDateRequest,
  ProductionActionResponse,
  ProductionStageEventRequest,
} from './types/productionActionsApi.types';
import { validateOrderId } from './ordersApi';

export const productionActionsApi = {
  moveCalendarDate(
    orderId: number,
    request: MoveCalendarDateRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.patch<ProductionActionResponse>(
      apiRoutes.orders.calendarDate(validateOrderId(orderId)),
      request,
    );
  },

  changeOrderStatus(
    orderId: number,
    request: ChangeOrderStatusRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.patch<ProductionActionResponse>(
      apiRoutes.orders.status(validateOrderId(orderId)),
      request,
    );
  },

  activateProductionStage(
    orderId: number,
    productionStatusId: number,
    request: ProductionStageEventRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.put<ProductionActionResponse>(
      apiRoutes.orders.productionStageEvent(
        validateOrderId(orderId),
        validateProductionStatusId(productionStatusId),
      ),
      request,
    );
  },

  deactivateProductionStage(
    orderId: number,
    productionStatusId: number,
    request: ProductionStageEventRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.request<ProductionActionResponse>(
      apiRoutes.orders.productionStageEvent(
        validateOrderId(orderId),
        validateProductionStatusId(productionStatusId),
      ),
      {
        method: 'DELETE',
        body: JSON.stringify(request),
      },
    );
  },
};

export function createProductionActionIdempotencyKey(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}:${uuid}`;
}

export function validateProductionStatusId(productionStatusId: number): number {
  if (!Number.isInteger(productionStatusId) || productionStatusId < 1) {
    throw new Error('Invalid productionStatusId');
  }

  return productionStatusId;
}

export function isProductionActionVersionConflict(error: unknown): boolean {
  return isApiError(error) && (
    error.code === 'VERSION_CONFLICT' ||
    error.code === 'ORDER_VERSION_CONFLICT'
  );
}

export function isProductionActionPermissionDenied(error: unknown): boolean {
  return isApiError(error, 'PERMISSION_DENIED');
}

export function formatProductionActionPermissionDeniedMessage(
  action: 'order_status' | 'production_stage',
): string {
  if (action === 'production_stage') {
    return 'Вы не имеете права менять этап производства на чужом заказе.';
  }

  return 'Вы не имеете права менять статус на чужом заказе.';
}
