import { httpClient } from './httpClient';
import type {
  VlmAnalyzeRequest,
  VlmAnalyzeResponse,
  VlmHealthResponse,
  VlmUploadResponse,
} from './types/vlmApi.types';

export const vlmApi = {
  health(): Promise<VlmHealthResponse> {
    return httpClient.get<VlmHealthResponse>('/api/vlm/health');
  },

  upload(file: File | Blob, purpose: 'vlm' | 'order_file' = 'vlm'): Promise<VlmUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('purpose', purpose);

    return httpClient.post<VlmUploadResponse>('/api/vlm/upload', formData);
  },

  analyze(request: VlmAnalyzeRequest): Promise<VlmAnalyzeResponse> {
    return httpClient.post<VlmAnalyzeResponse>('/api/vlm/analyze', normalizeVlmAnalyzeRequest(request));
  },
};

export function normalizeVlmAnalyzeRequest(request: VlmAnalyzeRequest): VlmAnalyzeRequest {
  return {
    ...request,
    uploadId: normalizeNullableText(request.uploadId),
    imageUrl: normalizeNullableText(request.imageUrl),
    provider: normalizeNullableText(request.provider),
    model: normalizeNullableText(request.model),
    promptId: normalizeNullableText(request.promptId),
    providerOrder: request.providerOrder?.map((provider) => provider.trim()).filter(Boolean) ?? null,
  };
}

function normalizeNullableText(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;

  const trimmed = value.trim();
  return trimmed || null;
}
