import type { PermissionName } from '../../../permissions/permissions';

/** Registry of the order forms that can be sent. A new form = one entry here + its generator. */
export const ORDER_FORMS = [
  { code: 'production_pdf', title: 'PDF для производства', format: 'pdf', financial: false },
  { code: 'order_pdf', title: 'PDF заказа', format: 'pdf', financial: true },
  { code: 'production_excel', title: 'Excel для производства', format: 'xlsx', financial: false },
  { code: 'order_excel', title: 'Excel заказа', format: 'xlsx', financial: true },
] as const;

export type OrderFormCode = (typeof ORDER_FORMS)[number]['code'];
export type OrderFormFormat = (typeof ORDER_FORMS)[number]['format'];
export const ORDER_FORM_CODES = ORDER_FORMS.map((form) => form.code) as readonly OrderFormCode[];

export function orderForm(code: OrderFormCode) {
  const form = ORDER_FORMS.find((item) => item.code === code);
  if (!form) throw new Error(`Unknown order form ${code}`);
  return form;
}

export const ORDER_FORM_MIME: Record<OrderFormFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Card command and menu: «как у экспорта» (scope is checked per order). */
export const ORDER_SEND_PERMISSIONS: readonly PermissionName[] = ['orders.view', 'orders.export'];
export const ORDER_SEND_FINANCIAL_PERMISSION: PermissionName = 'orders.view_financials';
export const ORDER_SEND_SETTINGS_PERMISSIONS: readonly PermissionName[] = ['whatsapp.manage'];

export const ORDER_SEND_MAX_CHATS = 20;
export const ORDER_SEND_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const ORDER_SEND_QUEUE_TTL_MS = 30 * 60_000;
export const ORDER_SEND_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type OrderSendState = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled' | 'expired';
export type OrderSendCancelReason = 'disabled' | 'recipient_removed' | 'recipient_changed' | 'form_not_allowed' | 'permission_revoked' | 'paused';
export type OrderSendTarget = { kind: 'client' } | { kind: 'chat'; chatKey: string };

export interface OrderSendChat {
  chatKey: string;
  groupChatId: string;
  label: string;
  forms: OrderFormCode[];
  caption: string;
}

export interface OrderSendSettings {
  version: number;
  enabled: boolean;
  minIntervalMinutes: number;
  /** Random extra delay of the next delivery, 0..floor(minIntervalMinutes / 2). */
  sendWindowMinutes: number;
  clientForms: OrderFormCode[];
  clientCaption: string;
  chats: OrderSendChat[];
  updatedAt: string;
  updatedBy: { id: string; username: string | null } | null;
}

export interface OrderSendSettingsInput {
  version: number;
  enabled: boolean;
  minIntervalMinutes: number;
  sendWindowMinutes: number;
  clientForms: OrderFormCode[];
  clientCaption: string;
  /** chatKey null = a new chat; an existing key keeps its group (a changed group gets a new key). */
  chats: Array<{ chatKey: string | null; groupChatId: string; label: string; forms: OrderFormCode[]; caption: string }>;
}

export interface OrderSendRuntime {
  enabled: boolean;
  relayAvailable: boolean;
  unavailableReason: string | null;
}

/** Menu of the order card: no group ids, filtered by the user's financial visibility. */
export interface OrderSendMenu {
  enabled: boolean;
  forms: Array<{ code: OrderFormCode; title: string; financial: boolean }>;
  client: { forms: OrderFormCode[] };
  chats: Array<{ chatKey: string; label: string; forms: OrderFormCode[] }>;
  nextAllowedAt: string | null;
  activeSend: boolean;
  runtime: OrderSendRuntime;
}

export interface OrderSendView {
  sendId: string;
  orderId: number;
  targetKind: 'client' | 'chat';
  chatKey: string | null;
  recipientLabel: string;
  recipientMasked: string;
  form: OrderFormCode;
  state: OrderSendState;
  errorCode: string | null;
  cancelReason: OrderSendCancelReason | null;
  createdAt: string;
  sentAt: string | null;
  actor: { id: string; username: string | null };
}
