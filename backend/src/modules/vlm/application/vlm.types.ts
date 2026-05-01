import type { CurrentUser } from '../../../permissions/current-user';
import type {
  VlmAnalyzeRequestDto,
  VlmAnalyzeResponseDto,
  VlmHealthResponseDto,
  VlmUploadRequestDto,
  VlmUploadResponseDto,
} from '../dto/vlm.dto';

export interface GetVlmHealthCommand {
  currentUser: CurrentUser;
  detailsVisible: boolean;
}

export interface UploadVlmImageCommand {
  currentUser: CurrentUser;
  dto: VlmUploadRequestDto;
}

export interface AnalyzeVlmImageCommand {
  currentUser: CurrentUser;
  dto: VlmAnalyzeRequestDto;
}

export interface VlmProviderPort {
  getHealth(command: GetVlmHealthCommand): Promise<VlmHealthResponseDto>;
  uploadImage(command: UploadVlmImageCommand): Promise<VlmUploadResponseDto>;
  analyzeImage(command: AnalyzeVlmImageCommand): Promise<VlmAnalyzeResponseDto>;
}
