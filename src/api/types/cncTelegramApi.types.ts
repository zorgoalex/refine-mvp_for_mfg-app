export type CncTelegramParseStatus = 'received' | 'parsed' | 'needs_review';
export type CncTelegramCompletionStatus = 'pending' | 'completed';
export type CncTelegramItemSource = 'vector' | 'ocr' | 'gcode' | 'manual';
export type CncTelegramMatchStatus = 'unmatched' | 'matched' | 'conflict' | 'needs_review';

export interface CncTelegramTool {
  toolNumber: number;
  spindleRpm?: number | null;
}

export interface CncTelegramDowelingLink {
  orderName: string;
  dowelingNumber: string;
}

export interface CncTelegramPacketItem {
  packetItemId: string;
  sourceItemKey: string;
  orderName: string;
  orderId: number | null;
  orderDeleted?: boolean;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
  source: CncTelegramItemSource;
  confidence: number;
  matchOrderId: number | null;
  matchDetailId: number | null;
  matchDetailQuantity: number | null;
  matchStatus: CncTelegramMatchStatus;
  reviewNote: string | null;
  laminatedOrLater: boolean;
}

export interface CncTelegramCutLayoutItem {
  orderName: string;
  detailNumber: number;
  widthMm: number;
  heightMm: number;
  quantity: number;
  confidence?: number | null;
  sourceElementId?: string | null;
  xMm: number;
  yMm: number;
  placedWidthMm: number;
  placedHeightMm: number;
  rotated: boolean;
  sourceSvg?: CncTelegramCutLayoutItemSourceSvg | null;
  visualLabel?: CncTelegramCutLayoutItemVisualLabel | null;
}

export interface CncTelegramCutLayoutItemSourceSvg {
  viewBox: {
    xMm: number;
    yMm: number;
    widthMm: number;
    heightMm: number;
  };
  body: string;
}

export interface CncTelegramCutLayoutItemVisualLabel {
  rawLines: string[];
}

export interface CncTelegramCutLayout {
  status: 'valid' | 'invalid';
  reasons: string[];
  sheet: { widthMm: number; heightMm: number } | null;
  rawCommentCount?: number | null;
  partContourCount?: number | null;
  acceptedItemCount?: number | null;
  items: CncTelegramCutLayoutItem[];
}

export interface CncTelegramPacketCutSheet {
  cutGroupId: number;
  sheetIndex: number;
  sheetNumber: number;
  variant: 'auto' | 'manual';
  detailIds: number[];
}

export interface CncTelegramCutLayoutItem {
  orderName: string;
  detailNumber: number;
  widthMm: number;
  heightMm: number;
  quantity: number;
  confidence?: number | null;
  sourceElementId?: string | null;
  xMm: number;
  yMm: number;
  placedWidthMm: number;
  placedHeightMm: number;
  rotated: boolean;
}

export interface CncTelegramCutLayout {
  status: 'valid' | 'invalid';
  reasons: string[];
  sheet: { widthMm: number; heightMm: number } | null;
  rawCommentCount?: number | null;
  partContourCount?: number | null;
  acceptedItemCount?: number | null;
  items: CncTelegramCutLayoutItem[];
}

export interface CncTelegramPacketCutSheet {
  cutGroupId: number;
  sheetIndex: number;
  sheetNumber: number;
  variant: 'auto' | 'manual';
  detailIds: number[];
}

export interface CncTelegramPacket {
  packetId: string;
  externalPacketKey: string;
  cuttingSequenceNo: number | null;
  sourceChatId: string;
  sourceMessageId: number | null;
  sourceThreadId: number | null;
  sourceVersion: number;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  workday: string;
  machine: string | null;
  programName: string | null;
  materialName: string;
  sheetImageUrl: string | null;
  sheetImageContentType: string | null;
  sheetImageSizeBytes: number | null;
  parseStatus: CncTelegramParseStatus;
  completionStatus: CncTelegramCompletionStatus;
  thumbsUp: boolean;
  completedAt: string | null;
  rework: boolean;
  comments: string[];
  tools: CncTelegramTool[];
  dowelingLinks: CncTelegramDowelingLink[];
  analysisWarnings: string[];
  ocrEngine: string | null;
  parserVersion: string;
  cutLayout: CncTelegramCutLayout | null;
  svgCutJobId?: number | null;
  svgCutJobDisplayNumber?: string | null;
  svgCutResultId?: number | null;
  svgCutResultNo?: number | null;
  svgCutImportStatus?: 'none' | 'skipped' | 'needs_review' | 'imported';
  svgCutImportNote?: string | null;
  allLinkedOrderDetailsPackedOrLater: boolean;
  svgCutSheets?: CncTelegramPacketCutSheet[];
  itemCount: number;
  itemQuantityTotal: number;
  updatedAt: string;
  items: CncTelegramPacketItem[];
}

export interface CncTelegramBathItem {
  bathItemId: string;
  orderId: number;
  orderName: string;
  detailId: number;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
  completedQuantity: number;
  ready: boolean;
  laminatedOrLater: boolean;
  packedOrLater: boolean;
}

export interface CncTelegramBathSheet {
  cutGroupId: number;
  sheetIndex: number;
  sheetNumber: number;
  variant: 'auto' | 'manual';
  sheetWidthMm: number | null;
  sheetHeightMm: number | null;
}

export interface CncTelegramBathCard {
  bathCardId: string;
  cutJobId: number;
  cutResultId: number;
  resultNo: number;
  revisionNo: number;
  cutNumber: string;
  displayCutNumber?: string | null;
  cutJobName: string;
  createdAt: string;
  ready: boolean;
  orderCount: number;
  positionCount: number;
  itemQuantityTotal: number;
  items: CncTelegramBathItem[];
  sheets: CncTelegramBathSheet[];
}

export interface CncTelegramBazisCutSetItem {
  orderId: number | null;
  orderName: string;
  orderDeleted: boolean;
  detailId: number | null;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
  materialName: string;
  quantity: number;
  packedOrLater: boolean;
}

export interface CncTelegramBazisCutSetCard {
  bazisCutSetId: number;
  name: string;
  createdAt: string;
  orderCount: number;
  positionCount: number;
  itemQuantityTotal: number;
  items: CncTelegramBazisCutSetItem[];
}

export interface CncTelegramTodayColumn {
  key:
    | 'parsed'
    | 'completed'
    | 'baths'
    | 'baths_ready'
    | 'completed_laminated'
    | 'baths_laminated'
    | 'completed_baths';
  title: string;
  total: number;
  packets: CncTelegramPacket[];
  baths: CncTelegramBathCard[];
  /** Present on current backends; optional during rolling deployment. */
  bazisCutSets?: CncTelegramBazisCutSetCard[];
}

export interface CncTelegramTodayResponse {
  workday: string;
  generatedAt: string;
  columns: CncTelegramTodayColumn[];
}

export interface CncTelegramOriginalPacket extends CncTelegramPacket {
  currentBoardVisibility: 'visible' | 'hidden';
  currentBoardColumn: 'parsed' | 'completed' | 'completed_laminated' | null;
}

export interface CncTelegramOriginalBathCard extends CncTelegramBathCard {
  currentBoardVisibility: 'visible' | 'archived';
  currentBoardColumn: 'baths' | 'baths_ready' | 'baths_laminated' | 'completed_baths' | null;
  currentBoardCardId: string | null;
}

export interface CncTelegramOriginalBazisCutSetCard extends CncTelegramBazisCutSetCard {
  currentBoardColumn: 'parsed' | 'completed_laminated';
}

export interface CncTelegramOriginalBoardResponse {
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  packets: CncTelegramOriginalPacket[];
  baths: CncTelegramOriginalBathCard[];
  bazisCutSets: CncTelegramOriginalBazisCutSetCard[];
}

export type MdfBoardHistorySubjectKind = 'order' | 'packet' | 'bazisCutSet' | 'bath';
export type MdfBoardHistoryColumn =
  | 'parsed' | 'completed' | 'completed_laminated'
  | 'baths' | 'baths_ready' | 'baths_laminated' | 'completed_baths'
  | 'orders' | 'orders_ready' | 'orders_issued';

export interface MdfBoardHistoryOrderOption {
  orderId: number;
  orderName: string;
  fullNumber: string;
  deleted: boolean;
  createdAt: string;
}

export interface MdfBoardHistoryOrderOptionsResponse {
  data: MdfBoardHistoryOrderOption[];
  generatedAt: string;
}

export interface MdfBoardHistoryCurrentCard {
  subjectKind: MdfBoardHistorySubjectKind;
  subjectId: string;
  existsNow: boolean;
  cardKind: MdfBoardHistorySubjectKind | null;
  cardId: string | null;
  label: string;
  currentColumn: MdfBoardHistoryColumn | null;
  automaticColumn: MdfBoardHistoryColumn | null;
  reasonUnavailable: string | null;
}

export interface MdfBoardHistoryBlocker {
  code: 'NO_MDF_SOURCES' | 'MACHINE_FILES_NOT_CUT' | 'BATHS_NOT_ROLLED' | 'ORDER_DELETED';
  text: string;
  count: number | null;
  relatedSubjectIds: string[];
}

export interface MdfBoardHistoryDiagnosis {
  presence: 'on_board' | 'not_on_board' | 'deleted';
  currentColumn: MdfBoardHistoryColumn | null;
  automaticColumn: MdfBoardHistoryColumn | null;
  manualOverride: {
    targetColumn: MdfBoardHistoryColumn;
    updatedAt: string;
    actorName: string | null;
  } | null;
  title: string;
  explanation: string;
  blockers: MdfBoardHistoryBlocker[];
  relatedCurrentCards: MdfBoardHistoryCurrentCard[];
}

export interface MdfBoardHistoryEvent {
  eventId: string;
  occurredAt: string;
  subjectKind: MdfBoardHistorySubjectKind;
  subjectId: string;
  subjectLabel: string;
  eventKind: 'appeared' | 'moved' | 'progress' | 'disappeared' | 'not_on_board' | 'first_known';
  fromColumn: MdfBoardHistoryColumn | null;
  toColumn: MdfBoardHistoryColumn | null;
  reasonCode: string;
  reason: string;
  consequence: string;
  actor: { kind: 'user' | 'system'; displayName: string };
  provenance: 'recorded' | 'reconstructed' | 'net_reconstructed';
  relatedCurrentCards: MdfBoardHistoryCurrentCard[];
}

export interface MdfBoardHistoryEpisode {
  episodeId: string;
  occurredAt: string;
  title: string;
  primaryEvent: MdfBoardHistoryEvent;
  relatedEvents: MdfBoardHistoryEvent[];
}

export interface MdfBoardHistoryResponse {
  window: { dateFrom: string; dateTo: string; boardDate: string };
  generatedAt: string;
  order: MdfBoardHistoryOrderOption;
  diagnosis: MdfBoardHistoryDiagnosis;
  coverage: {
    status: 'recorded_exact' | 'reconstructed_complete' | 'partial' | 'none';
    label: string;
    evidenceFrom: string | null;
    gaps: string[];
  };
  episodes: MdfBoardHistoryEpisode[];
}

export interface CncTelegramOrderCuttingSequence {
  packetId: string;
  externalPacketKey: string;
  cuttingSequenceNo: number;
  sourceMessageId: number | null;
  workday: string;
  programName: string | null;
  materialName: string;
  completionStatus: CncTelegramCompletionStatus;
  sourceCreatedAt: string | null;
  itemQuantityTotal: number;
}

export interface CncTelegramOrderCuttingSequencesResponse {
  orderId: number;
  sequences: CncTelegramOrderCuttingSequence[];
}

export type CncTelegramMediaRestoreStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface CncTelegramOrderScreenshot {
  kind: 'telegram' | 'svg_cut';
  packetId: string;
  sourceMessageId: number | null;
  sourceCreatedAt: string;
  programName: string | null;
  materialName: string;
  matchedDetailCount: number;
  itemQuantityTotal: number;
  previewUrl: string | null;
  imageUrl: string | null;
  cutJobId?: number | null;
  cutJobDisplayNumber?: string | null;
  cutResultNo?: number | null;
  cutGroupId?: number | null;
  sheetIndex?: number | null;
  sheetNumber?: number | null;
  variant?: 'auto' | 'manual' | null;
  originalAvailable: boolean;
  availableUntil: string;
  restore: {
    requestId: string;
    status: CncTelegramMediaRestoreStatus;
    requestedAt: string;
    error: string | null;
  } | null;
}

export interface CncTelegramOrderScreenshotsResponse {
  orderId: number;
  generatedAt: string;
  originalRetentionDays: 30;
  screenshots: CncTelegramOrderScreenshot[];
  manualFiles?: CncTelegramManualSvgOrderFile[];
}

export interface CncTelegramMediaRestoreResponse {
  requestId: string;
  packetId: string;
  status: CncTelegramMediaRestoreStatus;
  requestedAt: string;
  availableUntil: string | null;
}

export type CncTelegramManualSvgUploadFileKind = 'svg' | 'gcode' | 'screenshot';
export type CncTelegramManualSvgTelegramSendStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'unknown';

export interface CncTelegramManualSvgUploadFile {
  kind: CncTelegramManualSvgUploadFileKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  base64Content: string;
}

export interface CncTelegramManualSvgOrderFile {
  fileId: string;
  packetId: string;
  kind: CncTelegramManualSvgUploadFileKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  generated: boolean;
  createdAt: string;
  expiresAt: string;
  downloadUrl: string;
  cutJobId: number | null;
  cutJobDisplayNumber: string | null;
  cutResultId: number | null;
  cutResultNo: number | null;
  telegramSendStatus: CncTelegramManualSvgTelegramSendStatus | null;
}

export interface CncAutoCutStatusConfigureResponse {
  settingEnabled: boolean;
  requestId: string;
  auditId: string;
  completedPacketCount: number;
  matchedDetailCount: number;
  wholeOrderCount: number;
  changedOrderCount: number;
  changedDetailCount: number;
}

export interface CncTelegramManualSvgUploadRequest {
  selectedOrderIds: number[];
  createMdfMachineFileCard: boolean;
  matchMode?: 'order_details' | 'informational';
  validationMode?: 'strict' | 'lenient';
  requestedCutJobId?: number | null;
  svgContentHash: string;
  workday?: string;
  machine?: string | null;
  programName?: string | null;
  materialName?: string | null;
  rework?: boolean;
  comments?: string[];
  tools?: CncTelegramTool[];
  parserVersion?: string | null;
  sourceFiles?: CncTelegramManualSvgUploadFile[];
  generatedScreenshot?: {
    contrast?: number | null;
  };
  telegramSend?: {
    enabled: boolean;
    message?: string | null;
  };
  cutLayout: CncTelegramCutLayout;
  items: Array<{
    sourceItemKey: string;
    orderName: string;
    detailNumber?: number | null;
    widthMm?: number | null;
    heightMm?: number | null;
    quantity: number;
    source: CncTelegramItemSource;
    confidence: number;
    matchOrderId?: number | null;
    matchDetailId?: number | null;
    matchStatus?: CncTelegramMatchStatus;
    reviewNote?: string | null;
  }>;
}

export interface CncTelegramManualSvgUploadResponse {
  packet: CncTelegramPacket;
  requestId: string;
  auditId?: string;
  applied: boolean;
  ignoredStaleSourceVersion: boolean;
  cutJobId: number | null;
  cutJobDisplayNumber: string | null;
  cutResultId: number | null;
  cutJobPath: string | null;
  createdMdfMachineFileCard: boolean;
  storedFileCount?: number;
  telegramSendRequestId?: string | null;
  telegramSendStatus?: CncTelegramManualSvgTelegramSendStatus | null;
}

export interface CncTelegramManualSvgCommentPreset {
  presetId: number;
  label: string;
  commentText: string;
  category: 'general' | 'order' | 'tool' | 'material' | 'rework' | 'custom';
  isActive: boolean;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCncTelegramManualSvgCommentPresetRequest {
  label: string;
  commentText: string;
  category?: CncTelegramManualSvgCommentPreset['category'];
  sortOrder?: number;
}
