export type DailyDigestCatchUpPolicy = 'skip' | 'until_deadline' | 'end_of_day';
export type DailyDigestPartialPolicy = 'remaining' | 'repeat_all' | 'manual';

export interface DailyDigestSettings {
  version: number;
  enabled: boolean;
  groupChatId: string | null;
  sendTime: string;
  sendWindowMinutes: number;
  timeZone: 'Asia/Almaty';
  catchUpPolicy: DailyDigestCatchUpPolicy;
  catchUpDeadline: string;
  cardsPerMessage: 1 | 2;
  partialPolicy: DailyDigestPartialPolicy;
}

// Durable once-per-day chosen dispatch minute for one Almaty business date.
export interface DailyDigestSchedule {
  businessDate: string;
  scheduledAt: string;
  windowStart: string;
  windowEnd: string;
  sendWindowMinutes: number;
  catchUpPolicy: DailyDigestCatchUpPolicy;
  catchUpDeadline: string;
  settingsVersion: number;
  createdAt: string;
}

export interface DailyDigestSettingsEnvelope {
  settings: DailyDigestSettings;
  runtime: {
    enabled: boolean;
    relayAvailable: boolean;
    unavailableReason: string | null;
  };
  todaySchedule: DailyDigestSchedule | null;
}

export type DailyDigestSettingsInput = Omit<DailyDigestSettings, 'timeZone'> & {
  duplicateRiskConfirmed: boolean;
};

export interface DailyDigestPreviewPage {
  pageIndex: number;
  imageDataUrl: string;
  orderIds: number[];
}

export interface DailyDigestPreview {
  businessDate: string;
  orderCount: number;
  totalArea: number;
  pages: DailyDigestPreviewPage[];
  empty: boolean;
}

export type DailyDigestRunKind = 'auto' | 'manual' | 'retry';
export type DailyDigestRunState =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'expired'
  | 'empty'
  | 'skipped';

export interface DailyDigestRun {
  id: string;
  businessDate: string;
  kind: DailyDigestRunKind;
  parentRunId: string | null;
  state: DailyDigestRunState;
  reason: string | null;
  orderCount: number;
  totalArea: number;
  pageCount: number;
  sentPageCount: number;
  destinationMasked: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  // Frozen planned dispatch minute for automatic runs; null for manual/retry
  // runs and for dates whose automatic run predates durable schedules.
  scheduledAt: string | null;
}

export type DailyDigestPageState =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'expired';

export interface DailyDigestPage {
  pageIndex: number;
  orderIds: number[];
  state: DailyDigestPageState;
  attemptCount: number;
  providerMessageId: string | null;
  errorCode: string | null;
  sentAt: string | null;
  imageAvailable: boolean;
  expiresAt: string;
}

export interface DailyDigestRunDetail {
  run: DailyDigestRun;
  pages: DailyDigestPage[];
}

export interface DailyDigestRunResponse {
  run: DailyDigestRun;
}

export interface DailyDigestRunsResponse {
  runs: DailyDigestRun[];
}

export type DailyDigestRetryMode = 'remaining' | 'all';

export interface DailyDigestRetryInput {
  mode: DailyDigestRetryMode;
  idempotencyKey: string;
  duplicateRiskConfirmed: boolean;
}
