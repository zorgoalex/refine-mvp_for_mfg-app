import { ApiError } from '../../../common/errors/api-error';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  CreateCncMdfCardCommand,
  CreateManualSvgCommentPresetCommand,
  IngestCncTelegramPacketCommand,
  ListManualSvgCommentPresetsCommand,
  ListCncTelegramTodayCommand,
  ListCncTelegramOriginalBoardCommand,
  ManualSvgUploadCommand,
  RecordCncTelegramDeniedAuditCommand,
} from '../application/cnc-telegram.types';
import type {
  CncTelegramIngestResponseDto,
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadResponseDto,
  CncTelegramTodayResponseDto,
  CncTelegramOriginalBoardResponseDto,
  CreateCncMdfCardResponseDto,
} from '../dto/cnc-telegram.dto';

export class UnavailableCncTelegramRepository
  implements CncTelegramRepositoryPort, CncTelegramDeniedAuditPort
{
  async listToday(_command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto> {
    throw unavailable();
  }

  async listOriginalBoard(
    _command: ListCncTelegramOriginalBoardCommand,
  ): Promise<CncTelegramOriginalBoardResponseDto> {
    throw unavailable();
  }

  async ingest(_command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto> {
    throw unavailable();
  }

  async manualSvgUpload(_command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto> {
    throw unavailable();
  }

  async createMdfCard(_command: CreateCncMdfCardCommand): Promise<CreateCncMdfCardResponseDto> {
    throw unavailable();
  }

  async listManualSvgCommentPresets(
    _command: ListManualSvgCommentPresetsCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto[]> {
    throw unavailable();
  }

  async createManualSvgCommentPreset(
    _command: CreateManualSvgCommentPresetCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto> {
    throw unavailable();
  }

  async recordIngestDenied(_command: RecordCncTelegramDeniedAuditCommand): Promise<void> {
    // No database, no denied-audit sink.
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is unavailable', {
    feature: 'cnc_telegram',
  });
}
