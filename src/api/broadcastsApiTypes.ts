// Wire types for the multi-broadcast WhatsApp API (`/whatsapp/broadcasts/*`).
// Deliberately independent of the legacy daily-digest types.
export type BroadcastCatchUpPolicy = 'skip' | 'until_deadline' | 'end_of_day';
export type BroadcastPartialPolicy = 'remaining' | 'repeat_all' | 'manual';

export interface BroadcastInput {
  name: string;
  enabled: boolean;
  groupChatId: string | null;
  /** 1 = Monday ... 7 = Sunday. */
  weekdays: number[];
  sendTime: string;
  sendWindowMinutes: number;
  catchUpPolicy: BroadcastCatchUpPolicy;
  catchUpDeadline: string;
  partialPolicy: BroadcastPartialPolicy;
  /** 0 = today, 1 = tomorrow ... 14. */
  orderDateOffsetDays: number;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
  duplicateRiskConfirmed: boolean;
}

export type BroadcastUpdateInput = BroadcastInput & { version: number };

export interface Broadcast extends Omit<BroadcastInput, 'duplicateRiskConfirmed'> {
  id: number;
  version: number;
  archived: boolean;
  scheduleGeneration: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: { id: number | string; username: string | null } | null;
  duplicateRiskConfirmed?: boolean;
}

export type BroadcastRunState =
  | 'preparing' | 'queued' | 'sending' | 'sent' | 'partial' | 'failed' | 'unknown'
  | 'cancelled' | 'expired' | 'empty' | 'skipped';
export type BroadcastRunKind = 'auto' | 'manual' | 'retry';

export interface BroadcastLastRun {
  state: BroadcastRunState;
  createdAt: string;
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
  archived: false;
  lastRun: BroadcastLastRun | null;
}

export interface BroadcastControl {
  paused: boolean;
  version: number;
  pausedAt: string | null;
  pausedBy: { id: number | string; username: string | null } | null;
}

export interface BroadcastRuntime {
  enabled: boolean;
  relayAvailable: boolean;
  unavailableReason: string | null;
}

export interface BroadcastsListResponse {
  broadcasts: BroadcastSummary[];
  control: BroadcastControl;
  runtime: BroadcastRuntime;
  limits: { maxActive: number };
}

export interface BroadcastTodaySchedule {
  businessDate: string;
  scheduledAt: string;
  windowStart: string;
  windowEnd: string;
  sendWindowMinutes: number;
  catchUpPolicy: BroadcastCatchUpPolicy;
  catchUpDeadline: string;
  settingsVersion: number;
  createdAt: string;
}

export interface BroadcastEnvelope {
  broadcast: Broadcast;
  todaySchedule: BroadcastTodaySchedule | null;
  runtime: BroadcastRuntime;
}

export interface BroadcastCaptionVariable {
  name: string;
  label: string;
  example: string;
}

export interface BroadcastCatalog {
  captionVariables: BroadcastCaptionVariable[];
}

export interface BroadcastPreviewPage {
  pageIndex: number;
  orderIds: number[];
  imageDataUrl: string;
}

export interface BroadcastPreview {
  businessDate: string;
  targetDate: string;
  orderCount: number;
  totalArea: number;
  caption: string;
  pages: BroadcastPreviewPage[];
  empty: boolean;
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
  destinationMasked: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  scheduledAt: string | null;
  superseded: boolean;
  messageCount: number;
  sentMessageCount: number;
}

export type BroadcastMessageState =
  | 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled' | 'expired';

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

export interface BroadcastRunResponse {
  run: BroadcastRun;
}

export interface BroadcastRunsResponse {
  runs: BroadcastRun[];
}

/** Legacy digest history: same shape as the old `GET daily-digest/runs` rows. */
export interface LegacyDigestRun {
  id: string;
  businessDate: string;
  kind: BroadcastRunKind;
  state: BroadcastRunState;
  reason: string | null;
  orderCount: number;
  totalArea: number;
  pageCount: number;
  sentPageCount: number;
  destinationMasked: string;
  createdAt: string;
  scheduledAt: string | null;
}

export interface LegacyDigestRunsResponse {
  runs: LegacyDigestRun[];
}

export interface BroadcastManualSendInput {
  settingsVersion: number;
  idempotencyKey: string;
  confirmed: true;
}

export interface BroadcastReplanInput {
  version: number;
  idempotencyKey: string;
}

export type BroadcastRetryMode = 'remaining' | 'all';

export interface BroadcastRetryInput {
  mode: BroadcastRetryMode;
  idempotencyKey: string;
  duplicateRiskConfirmed: boolean;
}

// ---- calendar send («Отправить в чат» from a calendar day) ----

export interface CalendarSendSettings {
  /** The system broadcast whose history lists calendar sends. */
  broadcastId: number;
  version: number;
  groupChatId: string | null;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
  minIntervalMinutes: number;
  updatedAt: string;
  updatedBy: { id: number | string; username: string | null } | null;
}

export interface CalendarSendEnvelope {
  settings: CalendarSendSettings;
  nextAllowedAt: string | null;
  activeRun: boolean;
  runtime: BroadcastRuntime;
}

export interface CalendarSendUpdateInput {
  version: number;
  groupChatId: string | null;
  cardsPerMessage: 1 | 2;
  captionTemplate: string;
  minIntervalMinutes: number;
}

export interface CalendarSendRunInput {
  /** Order date, YYYY-MM-DD. */
  date: string;
  idempotencyKey: string;
}
