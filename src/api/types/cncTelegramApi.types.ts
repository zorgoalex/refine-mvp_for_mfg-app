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

export interface CncTelegramTodayColumn {
  key: 'parsed' | 'completed';
  title: string;
  total: number;
  packets: CncTelegramPacket[];
}

export interface CncTelegramTodayResponse {
  workday: string;
  generatedAt: string;
  columns: CncTelegramTodayColumn[];
}
