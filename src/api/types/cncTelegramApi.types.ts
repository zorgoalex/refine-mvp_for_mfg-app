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

export interface CncTelegramTodayColumn {
  key: 'parsed' | 'completed' | 'baths' | 'baths_ready';
  title: string;
  total: number;
  packets: CncTelegramPacket[];
  baths: CncTelegramBathCard[];
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
