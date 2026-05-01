import { ApiError } from '../../../common/errors/api-error';
import type {
  AnalyzeVlmImageCommand,
  GetVlmHealthCommand,
  UploadVlmImageCommand,
  VlmProviderPort,
} from '../application/vlm.types';
import type {
  VlmAnalyzeResponseDto,
  VlmHealthResponseDto,
  VlmUploadResponseDto,
} from '../dto/vlm.dto';

export class UnavailableVlmProvider implements VlmProviderPort {
  async getHealth(_command: GetVlmHealthCommand): Promise<VlmHealthResponseDto> {
    throw unavailableVlmProviderError();
  }

  async uploadImage(_command: UploadVlmImageCommand): Promise<VlmUploadResponseDto> {
    throw unavailableVlmProviderError();
  }

  async analyzeImage(_command: AnalyzeVlmImageCommand): Promise<VlmAnalyzeResponseDto> {
    throw unavailableVlmProviderError();
  }
}

function unavailableVlmProviderError(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'VLM provider is not configured', {
    feature: 'vlm',
    adapter: 'vlm_provider',
  });
}
