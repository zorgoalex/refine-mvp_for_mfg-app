export interface VlmHealthProviderDto {
  name: string;
  configured: boolean;
  available?: boolean | null;
}

export interface VlmHealthResponseDto {
  status: 'ok' | 'degraded' | 'unavailable';
  providers?: VlmHealthProviderDto[];
  detailsVisible?: boolean;
}

export interface VlmUploadFileLike {
  filename?: string;
  originalname?: string;
  mimetype?: string;
  contentType?: string;
  type?: string;
  size?: number;
  buffer?: Buffer | Uint8Array;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export interface VlmUploadRequestDto {
  file: VlmUploadFileLike;
  purpose: 'vlm' | 'order_file';
}

export interface VlmUploadResponseDto {
  success: true;
  uploadId: string;
  url: string;
  key: string;
  width?: number | null;
  height?: number | null;
  size: number;
  contentType: string;
}

export interface VlmPromptKvDto {
  namespace: string;
  name: string;
  version?: string | null;
  lang?: string | null;
}

export interface VlmAnalyzeRequestDto {
  uploadId?: string | null;
  imageUrl?: string | null;
  provider?: string | null;
  model?: string | null;
  promptId?: string | null;
  promptKv?: VlmPromptKvDto | null;
  providerOrder?: string[] | null;
}

export interface VlmAnalyzeResponseDto {
  success: true;
  provider?: string | null;
  model?: string | null;
  uploadId?: string | null;
  result: Record<string, unknown>;
  rawResult?: Record<string, unknown> | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cost?: number | null;
  } | null;
}
