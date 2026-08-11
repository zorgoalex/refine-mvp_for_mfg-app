export type CncTelegramParseStatus = 'received' | 'parsed' | 'needs_review';
export type CncTelegramCompletionStatus = 'pending' | 'completed';
export type CncTelegramItemSource = 'vector' | 'ocr' | 'gcode' | 'manual';
export type CncTelegramMatchStatus = 'unmatched' | 'matched' | 'conflict' | 'needs_review';

export interface CncTelegramToolDto {
  toolNumber: number;
  spindleRpm?: number | null;
}

export interface CncTelegramDowelingLinkDto {
  orderName: string;
  dowelingNumber: string;
}

export interface CncTelegramPacketItemDto {
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

export interface CncTelegramCutLayoutItemDto {
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

export interface CncTelegramCutLayoutDto {
  status: 'valid' | 'invalid';
  reasons: string[];
  sheet: {
    widthMm: number;
    heightMm: number;
  } | null;
  rawCommentCount?: number | null;
  partContourCount?: number | null;
  acceptedItemCount?: number | null;
  items: CncTelegramCutLayoutItemDto[];
}

export interface CncTelegramPacketCutSheetDto {
  cutGroupId: number;
  sheetIndex: number;
  sheetNumber: number;
  variant: 'auto' | 'manual';
  detailIds: number[];
}

export interface CncTelegramPacketDto {
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
  tools: CncTelegramToolDto[];
  dowelingLinks: CncTelegramDowelingLinkDto[];
  analysisWarnings: string[];
  ocrEngine: string | null;
  parserVersion: string;
  cutLayout: CncTelegramCutLayoutDto | null;
  svgCutJobId?: number | null;
  svgCutResultId?: number | null;
  svgCutResultNo?: number | null;
  svgCutImportStatus?: 'none' | 'skipped' | 'needs_review' | 'imported';
  svgCutImportNote?: string | null;
  allLinkedOrderDetailsPackedOrLater: boolean;
  svgCutSheets?: CncTelegramPacketCutSheetDto[];
  itemCount: number;
  itemQuantityTotal: number;
  updatedAt: string;
  items: CncTelegramPacketItemDto[];
}

export interface CncTelegramBathItemDto {
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

export interface CncTelegramBathSheetDto {
  cutGroupId: number;
  sheetIndex: number;
  sheetNumber: number;
  variant: 'auto' | 'manual';
  sheetWidthMm: number | null;
  sheetHeightMm: number | null;
}

export interface CncTelegramBathCardDto {
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
  items: CncTelegramBathItemDto[];
  sheets: CncTelegramBathSheetDto[];
}

export interface CncTelegramBazisCutSetItemDto {
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

export interface CncTelegramBazisCutSetCardDto {
  bazisCutSetId: number;
  name: string;
  createdAt: string;
  orderCount: number;
  positionCount: number;
  itemQuantityTotal: number;
  items: CncTelegramBazisCutSetItemDto[];
}

export interface CncTelegramTodayColumnDto {
  key:
    | 'parsed'
    | 'completed'
    | 'baths'
    | 'baths_ready'
    | 'completed_laminated'
    | 'baths_laminated';
  title: string;
  total: number;
  packets: CncTelegramPacketDto[];
  baths: CncTelegramBathCardDto[];
  bazisCutSets: CncTelegramBazisCutSetCardDto[];
}

export interface CncTelegramTodayResponseDto {
  workday: string;
  generatedAt: string;
  columns: CncTelegramTodayColumnDto[];
}

export interface CncTelegramOrderCuttingSequenceDto {
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

export interface CncTelegramOrderCuttingSequencesResponseDto {
  orderId: number;
  sequences: CncTelegramOrderCuttingSequenceDto[];
}

export interface CncTelegramIngestResponseDto {
  packet: CncTelegramPacketDto;
  requestId: string;
  auditId?: string;
  applied: boolean;
  ignoredStaleSourceVersion: boolean;
}

export interface CncAutoCutStatusConfigureResponseDto {
  settingEnabled: boolean;
  requestId: string;
  auditId: string;
  completedPacketCount: number;
  matchedDetailCount: number;
  wholeOrderCount: number;
  changedOrderCount: number;
  changedDetailCount: number;
}

export interface CncTelegramStructuredIngestDto {
  idempotencyKey: string;
  externalPacketKey: string;
  source: {
    chatId: string;
    messageId?: number | null;
    threadId?: number | null;
    version: number;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  workday?: string;
  cuttingSequenceNo?: number | null;
  machine?: string | null;
  programName?: string | null;
  materialName?: string | null;
  sheetImage?: {
    storageKey: string;
    contentType?: string | null;
    sizeBytes?: number | null;
  } | null;
  parseStatus?: CncTelegramParseStatus;
  completionStatus?: CncTelegramCompletionStatus;
  thumbsUp?: boolean;
  completedAt?: string | null;
  rework?: boolean;
  comments?: string[];
  tools?: CncTelegramToolDto[];
  dowelingLinks?: CncTelegramDowelingLinkDto[];
  analysisWarnings?: string[];
  ocrEngine?: string | null;
  parserVersion?: string | null;
  cutLayout?: CncTelegramCutLayoutDto | null;
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
