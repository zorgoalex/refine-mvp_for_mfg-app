import type {
  DailyDigestRenderedPage,
  DailyDigestSnapshot,
} from './daily-digest-snapshot.types';

export const DAILY_DIGEST_ORDER_READER = Symbol('DAILY_DIGEST_ORDER_READER');
export const DAILY_DIGEST_RENDERER = Symbol('DAILY_DIGEST_RENDERER');

export type DailyDigestCatchUpPolicy = 'skip' | 'until_deadline' | 'end_of_day';
export type DailyDigestPartialPolicy = 'remaining' | 'repeat_all' | 'manual';
export type DailyDigestRunKind = 'auto' | 'manual' | 'retry';
export type DailyDigestRunState =
  | 'queued' | 'sending' | 'sent' | 'partial' | 'failed' | 'unknown'
  | 'cancelled' | 'expired' | 'empty' | 'skipped';
export type DailyDigestPageState =
  | 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled' | 'expired';

export interface DailyDigestSettings {
  version: number;
  enabled: boolean;
  groupChatId: string | null;
  sendTime: string;
  timeZone: 'Asia/Almaty';
  cardsPerMessage: 1 | 2;
  catchUpPolicy: DailyDigestCatchUpPolicy;
  catchUpDeadline: string;
  partialPolicy: DailyDigestPartialPolicy;
}

export interface DailyDigestSettingsInput extends Omit<DailyDigestSettings, 'timeZone'> {
  duplicateRiskConfirmed: boolean;
}

export interface DailyDigestRuntime {
  enabled: boolean;
  relayAvailable: boolean;
  unavailableReason: string | null;
}

export interface DailyDigestSettingsEnvelope {
  settings: DailyDigestSettings;
  runtime: DailyDigestRuntime;
}

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
}

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

export interface DailyDigestOrderReader {
  read(businessDate: string): Promise<DailyDigestSnapshot>;
}

export interface DailyDigestRenderer {
  render(snapshot: DailyDigestSnapshot): Promise<DailyDigestRenderedPage[]>;
}

export interface DailyDigestPreview {
  businessDate: string;
  orderCount: number;
  totalArea: number;
  pages: Array<{ pageIndex: number; imageDataUrl: string; orderIds: number[] }>;
  empty: boolean;
}

export interface DailyDigestFileMetadata {
  fileKey: string;
  sha256: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface DailyDigestStoredPage extends DailyDigestFileMetadata {
  pageIndex: number;
  orderIds: number[];
}

export interface DailyDigestStoredImage {
  bytes: Buffer;
  expiresAt: Date;
}
