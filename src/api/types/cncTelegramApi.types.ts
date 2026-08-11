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
    | 'baths_laminated';
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
  packetId: string;
  sourceMessageId: number;
  sourceCreatedAt: string;
  programName: string | null;
  materialName: string;
  matchedDetailCount: number;
  itemQuantityTotal: number;
  previewUrl: string;
  imageUrl: string;
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
}

export interface CncTelegramMediaRestoreResponse {
  requestId: string;
  packetId: string;
  status: CncTelegramMediaRestoreStatus;
  requestedAt: string;
  availableUntil: string | null;
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
