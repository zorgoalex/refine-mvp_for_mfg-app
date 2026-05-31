import { apiRoutes } from './apiRoutes';
import { isApiError } from './apiError';
import { httpClient } from './httpClient';
import type {
  ChangePaymentStatusRequest,
  ChangeOrderStatusRequest,
  ChangeProductionStatusRequest,
  DetailProductionStageEventRequest,
  MoveCalendarDateRequest,
  ProductionActionResponse,
  ProductionStageEventRequest,
  ProductionStatusModeRequest,
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

  changePaymentStatus(
    orderId: number,
    request: ChangePaymentStatusRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.patch<ProductionActionResponse>(
      apiRoutes.orders.paymentStatus(validateOrderId(orderId)),
      request,
    );
  },

  changeProductionStatus(
    orderId: number,
    request: ChangeProductionStatusRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.patch<ProductionActionResponse>(
      apiRoutes.orders.productionStatus(validateOrderId(orderId)),
      {
        ...request,
        productionStatusId: validateProductionStatusId(request.productionStatusId),
      },
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

  activateDetailProductionStage(
    detailId: number,
    productionStatusId: number,
    request: DetailProductionStageEventRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.put<ProductionActionResponse>(
      apiRoutes.orderDetails.productionStageEvent(
        validateOrderDetailId(detailId),
        validateProductionStatusId(productionStatusId),
      ),
      request,
    );
  },

  restoreAutoProductionStatus(
    orderId: number,
    request: ProductionStatusModeRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.patch<ProductionActionResponse>(
      apiRoutes.orders.autoProductionStatusMode(validateOrderId(orderId)),
      request,
    );
  },

  enterManualProductionStatus(
    orderId: number,
    request: ProductionStatusModeRequest,
  ): Promise<ProductionActionResponse> {
    return httpClient.patch<ProductionActionResponse>(
      apiRoutes.orders.manualProductionStatusMode(validateOrderId(orderId)),
      request,
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

export function validateOrderDetailId(detailId: number): number {
  if (!Number.isInteger(detailId) || detailId < 1) {
    throw new Error('Invalid detailId');
  }

  return detailId;
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
  action: 'order_status' | 'payment_status' | 'production_stage',
): string {
  if (action === 'production_stage') {
    return 'Вы не имеете права менять этап производства на чужом заказе.';
  }
  if (action === 'payment_status') {
    return 'Вы не имеете права менять статус оплаты на чужом заказе.';
  }

  return 'Вы не имеете права менять статус на чужом заказе.';
}
