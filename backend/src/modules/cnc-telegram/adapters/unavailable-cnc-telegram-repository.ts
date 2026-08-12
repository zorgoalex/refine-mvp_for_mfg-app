import { ApiError } from '../../../common/errors/api-error';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  ConfigureCncAutoCutStatusCommand,
  CreateManualSvgCommentPresetCommand,
  IngestCncTelegramPacketCommand,
  ListManualSvgCommentPresetsCommand,
  ListCncTelegramOrderCuttingSequencesCommand,
  ListCncTelegramTodayCommand,
  ManualSvgUploadCommand,
  RecordCncTelegramDeniedAuditCommand,
} from '../application/cnc-telegram.types';
import type {
  CncAutoCutStatusConfigureResponseDto,
  CncTelegramIngestResponseDto,
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadResponseDto,
  CncTelegramOrderCuttingSequencesResponseDto,
  CncTelegramTodayResponseDto,
} from '../dto/cnc-telegram.dto';

export class UnavailableCncTelegramRepository
  implements CncTelegramRepositoryPort, CncTelegramDeniedAuditPort
{
  async listToday(_command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto> {
    throw unavailable();
  }

  async listOrderCuttingSequences(
    _command: ListCncTelegramOrderCuttingSequencesCommand,
  ): Promise<CncTelegramOrderCuttingSequencesResponseDto> {
    throw unavailable();
  }

  async ingest(_command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto> {
    throw unavailable();
  }

  async manualSvgUpload(_command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto> {
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

  async configureAutoCutStatus(
    _command: ConfigureCncAutoCutStatusCommand,
  ): Promise<CncAutoCutStatusConfigureResponseDto> {
    throw unavailable();
  }

  async recordIngestDenied(_command: RecordCncTelegramDeniedAuditCommand): Promise<void> {
    // No database, no denied-audit sink.
  }

  async recordAutoCutStatusConfigureDenied(
    _command: RecordCncTelegramDeniedAuditCommand,
  ): Promise<void> {
    // No database, no denied-audit sink.
  }

  async recordWorkerAuditWriteDenied(
    _command: RecordCncTelegramDeniedAuditCommand,
  ): Promise<void> {
    // No database, no denied-audit sink.
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is unavailable', {
    feature: 'cnc_telegram',
  });
}
