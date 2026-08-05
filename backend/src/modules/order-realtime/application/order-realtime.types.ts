export const ORDER_REALTIME_DOMAINS = ['detail_status', 'cut_refs'] as const;

export type OrderRealtimeDomain = (typeof ORDER_REALTIME_DOMAINS)[number];

export interface OrderRealtimeCursor {
  schemaVersion: 1;
  detailStatusRevision: number;
  cutRefsRevision?: number;
}

export interface OrderRealtimeEventRecord {
  orderId: number;
  commitSequence: number;
  detailStatusRevision: number | null;
  cutRefsRevision: number | null;
  domains: OrderRealtimeDomain[];
  detailIds: number[] | null;
  occurredAt: string;
}

export interface AppendOrderRealtimeEventInput {
  orderId: number;
  domains: readonly OrderRealtimeDomain[];
  detailIds?: readonly number[] | null;
  sourceType: string;
  sourceKey: string;
  occurredAt?: Date;
}
