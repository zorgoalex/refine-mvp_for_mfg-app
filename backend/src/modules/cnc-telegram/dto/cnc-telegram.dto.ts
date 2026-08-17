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
  matchDetailQuantity: number | null;
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
  sourceSvg?: CncTelegramCutLayoutItemSourceSvgDto | null;
  visualLabel?: CncTelegramCutLayoutItemVisualLabelDto | null;
}

export interface CncTelegramCutLayoutItemSourceSvgDto {
  viewBox: {
    xMm: number;
    yMm: number;
    widthMm: number;
    heightMm: number;
  };
  body: string;
}

export interface CncTelegramCutLayoutItemVisualLabelDto {
  rawLines: string[];
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

export interface CncTelegramSvgImportModeDto {
  validationMode?: 'strict' | 'lenient';
  refreshImported?: boolean;
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
  svgCutJobDisplayNumber?: string | null;
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
  packedOrLater: boolean;
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
  /** Operator-facing bath card number without result version, e.g. "В-42". */
  displayCutNumber?: string;
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
  packedOrLater: boolean;
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
    | 'baths_laminated'
    | 'completed_baths';
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

export interface CncTelegramSkippedDuplicateSourceFileDto {
  status: 'skipped';
  sha256: string;
  fileName: string | null;
  cutJobId: number;
  cutJobDisplayNumber: string | null;
  cutResultId: number | null;
  packetId: string | null;
  note: string;
}

export interface CncTelegramIngestResponseDto {
  packet: CncTelegramPacketDto;
  requestId: string;
  auditId?: string;
  applied: boolean;
  ignoredStaleSourceVersion: boolean;
  skippedDuplicateSourceFile?: CncTelegramSkippedDuplicateSourceFileDto;
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

export interface CncTelegramManualSvgUploadResponseDto extends CncTelegramIngestResponseDto {
  cutJobId: number | null;
  cutJobDisplayNumber: string | null;
  cutResultId: number | null;
  cutJobPath: string | null;
  createdMdfMachineFileCard: boolean;
  storedFileCount?: number;
  telegramSendRequestId?: string | null;
  telegramSendStatus?: 'pending' | 'processing' | 'sent' | 'failed' | 'unknown' | null;
}

export type CncTelegramManualSvgUploadFileKind = 'svg' | 'gcode' | 'screenshot';

export interface CncTelegramManualSvgUploadFileDto {
  kind: CncTelegramManualSvgUploadFileKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  base64Content: string;
}

export interface CncTelegramSourceFileIdentityDto {
  kind: CncTelegramManualSvgUploadFileKind;
  fileName: string;
  contentType?: string | null;
  sizeBytes: number;
  sha256: string;
}

export interface CncTelegramManualSvgTelegramSendDto {
  enabled: boolean;
  message?: string | null;
}

export interface CncTelegramManualSvgGeneratedScreenshotDto {
  contrast?: number | null;
}

export interface CncTelegramManualSvgUploadDto {
  idempotencyKey: string;
  selectedOrderIds: number[];
  createMdfMachineFileCard: boolean;
  matchMode: 'order_details' | 'informational';
  validationMode: 'strict' | 'lenient';
  requestedCutJobId?: number | null;
  svgContentHash: string;
  workday?: string;
  machine?: string | null;
  programName?: string | null;
  materialName?: string | null;
  rework?: boolean;
  comments?: string[];
  tools?: CncTelegramToolDto[];
  parserVersion?: string | null;
  cutLayout: CncTelegramCutLayoutDto;
  items: CncTelegramStructuredIngestDto['items'];
  sourceFiles?: CncTelegramManualSvgUploadFileDto[];
  generatedScreenshot?: CncTelegramManualSvgGeneratedScreenshotDto;
  telegramSend?: CncTelegramManualSvgTelegramSendDto;
}

export interface CncTelegramManualSvgCommentPresetDto {
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

export interface CreateCncTelegramManualSvgCommentPresetDto {
  label: string;
  commentText: string;
  category?: CncTelegramManualSvgCommentPresetDto['category'];
  sortOrder?: number;
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
  svgImportMode?: CncTelegramSvgImportModeDto;
  sourceFiles?: CncTelegramSourceFileIdentityDto[];
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
