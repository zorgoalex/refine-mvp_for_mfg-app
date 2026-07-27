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
}

export interface CncTelegramPacketDto {
  packetId: string;
  externalPacketKey: string;
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

export interface CncTelegramTodayColumnDto {
  key: 'parsed' | 'completed' | 'baths' | 'baths_ready';
  title: string;
  total: number;
  packets: CncTelegramPacketDto[];
  baths: CncTelegramBathCardDto[];
}

export interface CncTelegramTodayResponseDto {
  workday: string;
  generatedAt: string;
  columns: CncTelegramTodayColumnDto[];
}

export interface CncTelegramIngestResponseDto {
  packet: CncTelegramPacketDto;
  requestId: string;
  auditId?: string;
  applied: boolean;
  ignoredStaleSourceVersion: boolean;
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
