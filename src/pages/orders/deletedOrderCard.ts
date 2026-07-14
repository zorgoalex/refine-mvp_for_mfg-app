import type { OrderDto } from '../../api/types/orderApi.types';

export interface DeletedOrderCardModel {
  orderId: number;
  orderName: string;
  clientName: string | null;
  finalAmount: number | null;
  orderDate: string | null;
  deletedAt: string | null;
  deletedByName: string | null;
  version: number;
  detailsCount: number;
}

export function buildDeletedOrderCardModel(order: OrderDto): DeletedOrderCardModel | null {
  if (order.header.deleteFlag !== true) return null;

  return {
    orderId: order.header.orderId,
    orderName: order.header.orderName,
    clientName: order.header.clientName ?? null,
    finalAmount: order.totals?.finalAmount ?? null,
    orderDate: order.header.orderDate ?? null,
    deletedAt: order.header.deletedAt ?? null,
    deletedByName: order.header.deletedByName ?? null,
    version: order.version,
    detailsCount: order.details?.length ?? 0,
  };
}
