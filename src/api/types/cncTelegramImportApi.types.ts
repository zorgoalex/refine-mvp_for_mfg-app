export type CncTelegramImportScanStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'expired';
export type CncTelegramImportRequestStatus = 'draft' | 'pending' | 'processing' | 'completed' | 'partial' | 'failed';
export type CncTelegramImportItemStatus = 'pending' | 'processing' | 'confirmation_required' | 'imported' | 'failed' | 'unknown';

import type { CncTelegramCutLayout } from './cncTelegramApi.types';

export interface CncTelegramImportScanRequest {
  dateFrom: string;
  dateTo: string;
}

export interface CncTelegramImportScanProgress {
  daysTotal: number;
  daysProcessed: number;
  messagesTotal: number;
  messagesProcessed: number;
  candidatesTotal: number;
  warningsTotal: number;
  truncated: boolean;
}

export interface CncTelegramImportScan {
  scanId: string;
  status: CncTelegramImportScanStatus;
  dateFrom: string;
  dateTo: string;
  businessTimezone: string;
  requestedAt: string;
  finishedAt: string | null;
  progress: CncTelegramImportScanProgress;
  error: string | null;
}

export type CncTelegramImportMatchKind =
  | 'same_telegram_source'
  | 'sent_by_erp_manual_upload'
  | 'exact_svg_content'
  | 'same_layout';

export interface CncTelegramImportMatch {
  kind: CncTelegramImportMatchKind;
  label?: string | null;
  packetId?: string | null;
  cutJobId?: number | null;
  cutJobDisplayNumber?: string | null;
  cutResultId?: number | null;
  href?: string | null;
  detectedAt?: string | null;
}

export interface CncTelegramImportCandidate {
  candidateId: string;
  sourceChatId: string;
  sourceMessageId: string;
  sourceCreatedAt: string;
  sourceUpdatedAt?: string | null;
  workday: string;
  svgFileName: string;
  svgContentSha256?: string | null;
  svgMessageId?: string | null;
  gcodeFileName?: string | null;
  gcodeMessageId?: string | null;
  screenshotFileName?: string | null;
  screenshotMessageId?: string | null;
  screenshotContentSha256?: string | null;
  cutLayout?: CncTelegramCutLayout | null;
  previewUrl?: string | null;
  sheetWidthMm?: number | null;
  sheetHeightMm?: number | null;
  sheetCount?: number | null;
  positionCount?: number | null;
  orderLabels?: string[];
  parserWarnings: string[];
  sourceStatus: 'new' | 'similar' | 'previously_imported' | 'incomplete' | 'source_changed' | 'expired';
  eligibility: 'eligible' | 'ineligible';
  eligibilityReason?: string | null;
  matches: CncTelegramImportMatch[];
}

export interface CncTelegramImportCandidatesResponse {
  scanId: string;
  candidates: CncTelegramImportCandidate[];
  pagination?: { page: number; pageSize: number; total: number; totalPages: number };
}

export type CncTelegramImportMessageType = 'svg' | 'dxf' | 'image' | 'gcode' | 'text' | 'other';
export type CncTelegramImportCandidateRole = 'svg' | 'gcode' | 'screenshot' | 'comment';

/** Sanitized message metadata/text owned by an explicit import scan. */
export interface CncTelegramImportMessage {
  scanMessageId: string;
  scanId: string;
  sourceChatId: string;
  sourceMessageId: string;
  sourceThreadId?: string | null;
  replyToMessageId?: string | null;
  senderUserId?: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt?: string | null;
  workday: string;
  messageType: CncTelegramImportMessageType;
  filename?: string | null;
  mimeType?: string | null;
  messageText?: string | null;
  outgoing: boolean;
  candidateId?: string | null;
  candidateRole?: CncTelegramImportCandidateRole | null;
  readOrdinal: number;
}

export interface CncTelegramImportMessagesResponse {
  scanId: string;
  messages: CncTelegramImportMessage[];
  pagination?: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface CncTelegramImportPrepareRequest {
  candidateIds: string[];
  repeatOfImportRequestId?: string | null;
}

export interface CncTelegramImportPrepareResponse {
  importRequestId: string;
  scanId: string;
  selectionHash: string;
  confirmationId: string;
  duplicateMatchVersion: string;
  duplicateCount: number;
  candidates: CncTelegramImportCandidate[];
  refreshedMatches?: Record<string, CncTelegramImportMatch[]>;
  status: CncTelegramImportRequestStatus;
}

export interface CncTelegramImportConfirmRequest {
  confirmationId: string;
  duplicateAcknowledgements: Array<{
    candidateId: string;
    duplicateAcknowledged: boolean;
  }>;
}

export interface CncTelegramImportItem {
  importItemId: string;
  candidateId: string;
  svgFileName?: string;
  status: CncTelegramImportItemStatus;
  error?: string | null;
  cutJobId: number | null;
  cutJobDisplayNumber: string | null;
  packetId: string | null;
  cutResultId?: number | null;
  duplicateAcknowledged: boolean;
  matches: CncTelegramImportMatch[];
}

export interface CncTelegramImportRequest {
  importRequestId: string;
  scanId: string;
  status: CncTelegramImportRequestStatus;
  confirmationId: string;
  totalCount: number;
  importedCount: number;
  failedCount: number;
  items: CncTelegramImportItem[];
  error: string | null;
}
