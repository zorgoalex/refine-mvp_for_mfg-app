import type { PermissionName } from '../../../permissions/permissions';

/** Registry of the order forms that can be sent. A new form = one entry here + its generator. */
export const ORDER_FORMS = [
  { code: 'production_pdf', title: 'PDF для производства', format: 'pdf', financial: false },
  { code: 'order_pdf', title: 'PDF заказа', format: 'pdf', financial: true },
  { code: 'production_excel', title: 'Excel для производства', format: 'xlsx', financial: false },
  { code: 'order_excel', title: 'Excel заказа', format: 'xlsx', financial: true },
  { code: 'production_image', title: 'Изображение для производства', format: 'png', financial: false },
  { code: 'order_image', title: 'Изображение заказа', format: 'png', financial: true },
] as const;

export type OrderFormCode = (typeof ORDER_FORMS)[number]['code'];
export type OrderFormFormat = (typeof ORDER_FORMS)[number]['format'];
export const ORDER_FORM_CODES = ORDER_FORMS.map((form) => form.code) as readonly OrderFormCode[];

export function orderForm(code: OrderFormCode) {
  const form = ORDER_FORMS.find((item) => item.code === code);
  if (!form) throw new Error(`Unknown order form ${code}`);
  return form;
}

/** Title for read paths: a code this backend does not know (a newer release) never breaks a list. */
export function orderFormTitle(code: string): string {
  return ORDER_FORMS.find((item) => item.code === code)?.title ?? code;
}

/** Whether this backend can deliver the form (a newer release may queue forms it does not know). */
export function isDeliverableForm(code: string): code is OrderFormCode {
  return ORDER_FORMS.some((item) => item.code === code);
}

export const ORDER_FORM_MIME: Record<OrderFormFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
};

/** Card command and menu: «как у экспорта» (scope is checked per order). */
export const ORDER_SEND_PERMISSIONS: readonly PermissionName[] = ['orders.view', 'orders.export'];
export const ORDER_SEND_FINANCIAL_PERMISSION: PermissionName = 'orders.view_financials';
export const ORDER_SEND_SETTINGS_PERMISSIONS: readonly PermissionName[] = ['whatsapp.manage'];

export const ORDER_SEND_MAX_CHATS = 20;
export const ORDER_SEND_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** A queued send waits at most 24 hours from the command, then expires. */
export const ORDER_SEND_QUEUE_TTL_MS = 24 * 60 * 60_000;
/** Waiting sends in the whole queue / of one author (the balloon tracker follows up to 50 ids). */
export const ORDER_SEND_QUEUE_MAX = 100;
export const ORDER_SEND_QUEUE_MAX_PER_ACTOR = 20;
export const ORDER_SEND_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type OrderSendState = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled' | 'expired';
export type OrderSendCancelReason = 'disabled' | 'recipient_removed' | 'recipient_changed' | 'form_not_allowed' | 'permission_revoked' | 'paused'
  | 'manual'
  /** A supplier request changed (supplier, date, comment, lines), was cancelled or closed while its text waited. */
  | 'request_changed';

/** The «form» of a supplier request send: its text (no file). Never offered among the order forms. */
export const SUPPLIER_TEXT_FORM = 'supplier_text';
export type OrderSendFormCode = OrderFormCode | typeof SUPPLIER_TEXT_FORM;
export type OrderSendTargetKind = 'client' | 'chat' | 'employee' | 'supplier';
/** Sending a supplier request from the procurement screen: as its commands (the scope is checked per request). */
export const SUPPLIER_SEND_PERMISSIONS: readonly PermissionName[] = ['procurement.view', 'procurement.manage'];
/**
 * Whether this backend creates sends of supplier requests (needs migration 238). The compatible release (K3a)
 * is this very code with `false`: it replays accepted commands, reads, audits, purges, re-checks and delivers
 * the rows that exist, but makes no new ones — a definite refusal — and its menu says «unavailable».
 */
export const ORDER_SEND_SUPPLIER_REQUESTS = true;
export type OrderSendTarget =
  /** `phoneId` — one of the client's phones (default: primary, else the smallest), with the token the menu gave for it. */
  { kind: 'client'; phoneId?: number | null; phoneToken?: string | null }
  | { kind: 'chat'; chatKey: string }
  /** An employee from the settings; `contactId` — one of his phones (default: the primary one). */
  | { kind: 'employee'; recipientKey: string; contactId?: number | null; /** The token the menu gave for this contact. */ contactToken?: string | null };
/**
 * Whether this backend creates sends to a chosen phone of the client (needs migration 237). The compatible
 * release (K2a) is this very code with `false`: it still parses and replays such commands, checks and delivers
 * the rows that exist, but makes no new ones and offers no phones to choose.
 */
export const ORDER_SEND_CLIENT_PHONE_CHOICE = true;

export type OrderSendChannel = 'whatsapp' | 'telegram';
/** Channels a send can go through in this release (Telegram comes with the next stage). */
export const ORDER_SEND_SUPPORTED_CHANNELS: readonly OrderSendChannel[] = ['whatsapp'];
export const ORDER_SEND_MAX_EMPLOYEES = 20;

export interface OrderSendEmployeeRecipient {
  recipientKey: string;
  employeeId: number;
  employeeName: string;
  channel: OrderSendChannel;
  forms: OrderFormCode[];
  caption: string;
}

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
  employees: OrderSendEmployeeRecipient[];
  /** Texts of supplier requests may be sent from the procurement screen. */
  supplierRequestsEnabled: boolean;
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
  /** recipientKey null = a new employee recipient; an existing key keeps its employee and channel. */
  employees: Array<{ recipientKey: string | null; employeeId: number; channel: OrderSendChannel; forms: OrderFormCode[]; caption: string }>;
  /** Absent (a client of the previous release) = kept as it is. */
  supplierRequestsEnabled?: boolean;
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
  /** «логин / ФИО» when users are linked to the employee; phones only as masks. */
  employees: Array<{ recipientKey: string; label: string; forms: OrderFormCode[];
    contacts: Array<{ contactId: number; masked: string; isPrimary: boolean; token: string }> }>;
  nextAllowedAt: string | null;
  activeSend: boolean;
  /** Waiting sends in the queue (queued + sending). */
  queueLength: number;
  runtime: OrderSendRuntime;
}

export interface OrderSendView {
  sendId: string;
  /** Null for a supplier request send. */
  orderId: number | null;
  targetKind: OrderSendTargetKind;
  chatKey: string | null;
  recipientLabel: string;
  recipientMasked: string;
  form: OrderSendFormCode;
  /** A supplier request send: the request and its number. */
  supplierRequestId: number | null;
  supplierRequestNumber: string | null;
  state: OrderSendState;
  errorCode: string | null;
  cancelReason: OrderSendCancelReason | null;
  createdAt: string;
  sentAt: string | null;
  actor: { id: string; username: string | null };
  /** Pictures of an image form or messages of a supplier text (1 for a file). */
  partsTotal: number;
  /** 1-based place in the queue while queued/sending, else null. */
  position: number | null;
  /** Approximate start of the delivery while queued/sending (ISO), else null. */
  estimatedAt: string | null;
  /** The send is expected to expire before its turn. */
  mayExpire: boolean;
  expiresAt: string;
}

/** What the window «Текст для поставщика» needs to offer the send: the recipient as masks, never a number. */
export interface SupplierSendMenu {
  /** The card sends are on, supplier requests are on and this release makes them. */
  enabled: boolean;
  /** Why the request cannot be sent now (null = it can): shown as the button hint. */
  unavailableReason: 'disabled' | 'release' | 'not_linked' | 'no_phone' | 'supplier_inactive' | 'status' | null;
  supplier: { supplierId: number; name: string } | null;
  contacts: Array<{ contactId: number; masked: string; isPrimary: boolean; token: string }>;
  requestVersion: number;
  queueLength: number;
  runtime: OrderSendRuntime;
}
