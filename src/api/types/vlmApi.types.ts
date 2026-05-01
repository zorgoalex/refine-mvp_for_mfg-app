export interface VlmHealthProvider {
  name: string;
  configured: boolean;
  available?: boolean | null;
}

export interface VlmHealthResponse {
  status: 'ok' | 'degraded' | 'unavailable';
  providers?: VlmHealthProvider[];
  detailsVisible?: boolean;
}

export interface VlmUploadResponse {
  success: true;
  uploadId: string;
  url: string;
  key: string;
  width?: number | null;
  height?: number | null;
  size: number;
  contentType: string;
}

export interface VlmPromptKv {
  namespace: string;
  name: string;
  version?: string | null;
  lang?: string | null;
}

export interface VlmAnalyzeRequest {
  uploadId?: string | null;
  imageUrl?: string | null;
  provider?: string | null;
  model?: string | null;
  promptId?: string | null;
  promptKv?: VlmPromptKv | null;
  providerOrder?: string[] | null;
}

export interface VlmAnalyzeResponse {
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
