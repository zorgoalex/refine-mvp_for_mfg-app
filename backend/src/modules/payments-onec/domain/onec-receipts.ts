import { createHash } from 'node:crypto';

/** Виды документов 1С на вкладке «Поступления 1С». */
export const RECEIPT_KINDS = ['cash_receipt', 'bank_receipt'] as const;
export const REFUND_KINDS = ['cash_refund', 'bank_refund'] as const;
export const INCOMING_KINDS = [...RECEIPT_KINDS, ...REFUND_KINDS] as const;
export type IncomingKind = (typeof INCOMING_KINDS)[number];

/** Валюта платежей ERP: поступления в иной валюте с платежами не сверяются. */
export const ERP_CURRENCY = 'KZT';
/** Окно дат правила «заказ 1С ↔ заказ ERP» (дней между датой заказа ERP и датой заказа 1С). */
export const ORDER_LINK_WINDOW_DAYS = 60;

/**
 * Состояние строки (план §5). Вычисляется в SQL чтения — единственном месте правила; здесь только перечень.
 * `refund_*` — только у возвратов.
 */
export const RECEIPT_STATES = [
  'matched', 'changed', 'dismissed', 'inactive', 'foreign_currency', 'no_erp_order', 'to_create', 'review',
  'refund_review', 'refund_info',
] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];

/** Счётчики-фильтры вкладки: состояние → группа. */
export const STATE_GROUPS = {
  review: ['review', 'changed', 'refund_review'],
  to_create: ['to_create'],
  matched: ['matched'],
  dismissed: ['dismissed'],
  no_erp_order: ['no_erp_order'],
  refunds: ['refund_info'],
  other: ['inactive', 'foreign_currency'],
} as const satisfies Record<string, readonly ReceiptState[]>;
export type StateGroup = keyof typeof STATE_GROUPS;
export const STATE_GROUP_KEYS = Object.keys(STATE_GROUPS) as StateGroup[];

/** Область видимости платежей пользователя (`role_policy_scopes`): `assigned` у платежей не применяется → как `none`. */
export type PaymentScope = 'all' | 'own' | 'none';
export const paymentScope = (scope: string | undefined): PaymentScope => (scope === 'all' || scope === 'own' ? scope : 'none');

/** Поля, от которых зависит решение по строке: меняется любое — токен другой (план §6 «Контракт устаревания»). */
export interface StateTokenInput {
  lineId: string;
  documentRevision: string | null;
  posted: boolean;
  deletedInOnec: boolean;
  missing: boolean;
  lineRemoved: boolean;
  amount: string;
  currency: string | null;
  docDate: string;
  onecOrderRef: string | null;
  onecOrderRevision: string | null;
  erpOrderId: string | null;
  erpOrderVersion: string | null;
  activeMatchId: string | null;
  activeLinkId: string | null;
  refundsFingerprint: string;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

export function stateToken(input: StateTokenInput): string {
  return digest([
    'line', input.lineId, input.documentRevision, input.posted, input.deletedInOnec, input.missing, input.lineRemoved,
    input.amount, input.currency, input.docDate, input.onecOrderRef, input.onecOrderRevision, input.erpOrderId,
    input.erpOrderVersion, input.activeMatchId, input.activeLinkId, input.refundsFingerprint,
  ]);
}

export function paymentToken(input: { paymentId: string; orderId: string; version: string; amount: string; paymentDate: string }): string {
  return digest(['payment', input.paymentId, input.orderId, input.version, input.amount, input.paymentDate]);
}
