import type { DailyDigestCatchUpPolicy, DailyDigestPartialPolicy } from '../daily-digest.types';

export type BroadcastRunKind = 'auto' | 'manual' | 'retry';
export type BroadcastRunState =
  | 'preparing' | 'queued' | 'sending' | 'sent' | 'partial' | 'failed' | 'unknown'
  | 'cancelled' | 'expired' | 'empty' | 'skipped';
export type BroadcastMessageState =
  | 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled' | 'expired';

/** Permissions a broadcast's content requires in stage A (the digest bundle). */
export const BROADCAST_BASE_PERMISSIONS = ['whatsapp.manage', 'calendar.view', 'orders.view', 'orders.view_financials'] as const;
/** Upper bound of simultaneously enabled broadcasts (plan §6.2). */
export const BROADCAST_MAX_ACTIVE = 20;
export const BROADCAST_MAX_ORDER_OFFSET_DAYS = 14;
/** «Отправить в чат» from the calendar: any day within this many days of today (Asia/Almaty). */
export const CALENDAR_SEND_MAX_DAYS = 366;

export interface BroadcastInput {
  name: string;
  enabled: boolean;
  groupChatId: string | null;
  /** ISO weekdays: 1 = Monday … 7 = Sunday, unique and ascending. */
  weekdays: number[];
  sendTime: string;
  sendWindowMinutes: number;
  catchUpPolicy: DailyDigestCatchUpPolicy;
  catchUpDeadline: string;
  partialPolicy: DailyDigestPartialPolicy;
  orderDateOffsetDays: number;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
  duplicateRiskConfirmed: boolean;
}

export interface BroadcastUpdateInput extends BroadcastInput {
  version: number;
}

export interface Broadcast extends Omit<BroadcastInput, 'duplicateRiskConfirmed'> {
  id: number;
  version: number;
  archived: boolean;
  scheduleGeneration: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: { id: string; username: string | null } | null;
}

export interface BroadcastSummary {
  id: number;
  name: string;
  enabled: boolean;
  groupChatId: string | null;
  weekdays: number[];
  sendTime: string;
  sendWindowMinutes: number;
  orderDateOffsetDays: number;
  archived: boolean;
  lastRun: { state: BroadcastRunState; createdAt: string } | null;
}

export interface BroadcastSchedule {
  broadcastId: number;
  businessDate: string;
  generation: number;
  scheduledAt: string;
  windowStart: string;
  windowEnd: string;
  sendWindowMinutes: number;
  catchUpPolicy: DailyDigestCatchUpPolicy;
  catchUpDeadline: string;
  settingsVersion: number;
  createdAt: string;
}

export interface BroadcastRuntime {
  enabled: boolean;
  relayAvailable: boolean;
  unavailableReason: string | null;
}

export interface BroadcastControl {
  paused: boolean;
  version: number;
  pausedAt: string | null;
  pausedBy: { id: string; username: string | null } | null;
}

export interface BroadcastEnvelope {
  broadcast: Broadcast;
  todaySchedule: BroadcastSchedule | null;
  runtime: BroadcastRuntime;
}

export interface BroadcastRun {
  id: string;
  broadcastId: number;
  businessDate: string;
  targetDate: string;
  kind: BroadcastRunKind;
  parentRunId: string | null;
  state: BroadcastRunState;
  reason: string | null;
  orderCount: number;
  totalArea: number;
  messageCount: number;
  sentMessageCount: number;
  destinationMasked: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  scheduledAt: string | null;
  superseded: boolean;
}

export interface BroadcastMessage {
  deliverySeq: number;
  kind: 'image' | 'text';
  orderIds: number[];
  state: BroadcastMessageState;
  attemptCount: number;
  errorCode: string | null;
  sentAt: string | null;
  imageAvailable: boolean;
  expiresAt: string;
}

export interface BroadcastRunDetail {
  run: BroadcastRun;
  messages: BroadcastMessage[];
}

export interface BroadcastPreview {
  businessDate: string;
  targetDate: string;
  orderCount: number;
  totalArea: number;
  caption: string;
  pages: Array<{ pageIndex: number; orderIds: number[]; imageDataUrl: string }>;
  empty: boolean;
}

/** Stored image message (delivery_seq = image_index in stage A). */
export interface BroadcastStoredImage {
  imageIndex: number;
  orderIds: number[];
  fileKey: string;
  sha256: string;
  sizeBytes: number;
  expiresAt: Date;
  caption: string | null;
}

/** Settings of the system broadcast behind «Отправить в чат» in the calendar. */
export interface CalendarSendSettings {
  broadcastId: number;
  version: number;
  groupChatId: string | null;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
  /** Frequency threshold: deliveries from the calendar start at most once per this many minutes. */
  minIntervalMinutes: number;
  updatedAt: string;
  updatedBy: { id: string; username: string | null } | null;
}

export interface CalendarSendUpdateInput {
  version: number;
  groupChatId: string | null;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
  minIntervalMinutes: number;
}

export interface CalendarSendState {
  settings: CalendarSendSettings;
  /** Earliest start of the next calendar delivery, or null when it is allowed now. */
  nextAllowedAt: string | null;
  /** A calendar send is still queued or being delivered. */
  activeRun: boolean;
}

export interface CalendarSendEnvelope extends CalendarSendState {
  runtime: BroadcastRuntime;
}
