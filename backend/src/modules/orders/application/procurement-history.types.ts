import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceUnit } from './order-resource-demand.types';

/** История закупа одного материала заказа (план 2026-09-28 §5.6): только чтение журнала аудита. */
export const PROCUREMENT_HISTORY_DEFAULT_LIMIT = 50;
export const PROCUREMENT_HISTORY_MAX_LIMIT = 200;

export type ProcurementHistoryEventKind =
  | 'marked'
  | 'unmarked'
  | 'allocation_added'
  | 'allocation_removed'
  | 'allocation_linked'
  | 'allocation_unlinked'
  | 'request_created'
  | 'request_updated'
  | 'request_sent'
  | 'request_closed'
  | 'request_cancelled';

export interface ProcurementHistoryDocumentDto {
  documentId: number;
  docKind: string | null;
  number: string | null;
  date: string | null;
}

export interface ProcurementHistoryEventDto {
  /** audit_id. */
  id: string;
  at: string;
  kind: ProcurementHistoryEventKind;
  actorName: string | null;
  /** Отметка «Закуплено»: ручная, приходом 1С или подбором. */
  origin: string | null;
  /** Распределение/связь: приход или оплата. */
  role: 'receipt' | 'payment' | null;
  /** Количество: при отметке — потребность на момент отметки; у прихода — распределённое количество. */
  quantity: number | null;
  unit: string | null;
  /** Сумма оплаты — только с finance.view (иначе null). */
  amount: number | null;
  currency: string | null;
  /** Распределение прихода отметило «Закуплено». */
  markedPurchased: boolean;
  document: ProcurementHistoryDocumentDto | null;
  request: { supplierRequestId: number; number: string | null } | null;
  /**
   * Связи с заявками, созданные вместе с распределением (групповое распределение из подбора) или снятые вместе с ним
   * (снятие распределения). Отдельные привязки/отвязки — свои события `allocation_linked/unlinked`.
   */
  requestLinks: ProcurementHistoryRequestLinkDto[];
}

export interface ProcurementHistoryRequestLinkDto {
  action: 'linked' | 'unlinked';
  supplierRequestId: number;
  number: string | null;
  /** Количество прихода в единице строки заявки; у оплат — null. */
  quantity: number | null;
  unit: string | null;
}

export interface ProcurementHistoryCurrentDto {
  name: string;
  quantity: number | null;
  unit: OrderResourceUnit;
  purchased: boolean;
  origin: 'manual' | 'onec' | null;
  markedAt: string | null;
  quantityAtMark: number | null;
  unitAtMark: OrderResourceUnit | null;
  /** Потребность изменилась после отметки «Закуплено». */
  changedSinceMark: boolean;
  /** Отметка есть, а материал заказу больше не нужен. */
  orphan: boolean;
}

export interface ProcurementHistoryResponseDto {
  orderId: number;
  resourceKey: string;
  /** null — материала в заказе нет и отметки закупа тоже. */
  current: ProcurementHistoryCurrentDto | null;
  events: ProcurementHistoryEventDto[];
  /** Курсор следующей (более старой) страницы; null — дальше событий нет. */
  nextCursor: string | null;
}

export interface ProcurementHistoryQuery {
  currentUser: CurrentUser;
  orderId: number;
  resourceKey: string;
  limit: number;
  before: { at: string; id: string } | null;
}
