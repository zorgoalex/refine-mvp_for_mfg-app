import type { BroadcastCaptionVariable, BroadcastRuntime } from './broadcastsApiTypes';

export type OrderFormCode = 'production_pdf' | 'order_pdf' | 'production_excel' | 'order_excel' | 'production_image' | 'order_image';

export interface OrderFormInfo {
  code: OrderFormCode;
  title: string;
  format: 'pdf' | 'xlsx' | 'png';
  financial: boolean;
}

export interface OrderSendChatSettings {
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
  /** Random extra delay after the threshold, 0..floor(minIntervalMinutes / 2). */
  sendWindowMinutes: number;
  clientForms: OrderFormCode[];
  clientCaption: string;
  chats: OrderSendChatSettings[];
  updatedAt: string;
  updatedBy: { id: number | string; username: string | null } | null;
}

export interface OrderSendSettingsEnvelope {
  settings: OrderSendSettings;
  forms: OrderFormInfo[];
  captionVariables: BroadcastCaptionVariable[];
  nextAllowedAt: string | null;
  activeSend: boolean;
  /** Waiting sends (queued + sending); absent on an older backend. */
  queueLength?: number;
  /** Approximate start of the next delivery; absent on an older backend. */
  nextDeliveryAt?: string | null;
  runtime: BroadcastRuntime;
}

export interface OrderSendChatInput {
  /** null = a new chat. */
  chatKey: string | null;
  groupChatId: string;
  label: string;
  forms: OrderFormCode[];
  caption: string;
}

export interface OrderSendSettingsInput {
  version: number;
  enabled: boolean;
  minIntervalMinutes: number;
  /** Random extra delay after the threshold, 0..floor(minIntervalMinutes / 2). */
  sendWindowMinutes: number;
  clientForms: OrderFormCode[];
  clientCaption: string;
  chats: OrderSendChatInput[];
}

/** The menu of the order card: no group ids, already filtered by the user's financial visibility. */
export interface OrderSendMenu {
  enabled: boolean;
  forms: Array<Pick<OrderFormInfo, 'code' | 'title' | 'financial'>>;
  client: { forms: OrderFormCode[] };
  chats: Array<{ chatKey: string; label: string; forms: OrderFormCode[] }>;
  nextAllowedAt: string | null;
  activeSend: boolean;
  runtime: BroadcastRuntime;
}

export type OrderSendTarget = { kind: 'client' } | { kind: 'chat'; chatKey: string };

export interface OrderSendCommandInput {
  target: OrderSendTarget;
  form: OrderFormCode;
  idempotencyKey: string;
  /** Explicit repeat after the previous send of this order, recipient and form ended unknown. */
  confirmAfterUnknown?: string;
}

export interface OrderSendView {
  sendId: string;
  orderId: number;
  /** 'employee' — a newer release (read only here). */
  targetKind: 'client' | 'chat' | 'employee';
  chatKey: string | null;
  recipientLabel: string;
  recipientMasked: string;
  form: OrderFormCode;
  state: string;
  errorCode: string | null;
  cancelReason: string | null;
  createdAt: string;
  sentAt: string | null;
  actor: { id: number | string; username: string | null };
  /** Queue fields; absent on an older backend. */
  partsTotal?: number;
  position?: number | null;
  estimatedAt?: string | null;
  mayExpire?: boolean;
  expiresAt?: string;
}

/** A line of «Очередь отправок из карточки». */
export interface OrderSendQueueItem extends OrderSendView {
  orderName: string | null;
  formTitle: string;
  finishedAt: string | null;
  cancelledBy: { id: number | string; username: string | null } | null;
}

export interface OrderSendQueue {
  paused: boolean;
  enabled: boolean;
  minIntervalMinutes: number;
  sendWindowMinutes: number;
  nextDeliveryAt: string | null;
  queueLength: number;
  page: number;
  pageSize: number;
  total: number;
  items: OrderSendQueueItem[];
}

export interface OrderSendResponse {
  send: OrderSendView;
}
