import { ApiError } from '../../../common/errors/api-error';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  ConfigureCncAutoCutStatusCommand,
  IngestCncTelegramPacketCommand,
  ListCncTelegramOrderCuttingSequencesCommand,
  ListCncTelegramTodayCommand,
  RecordCncTelegramDeniedAuditCommand,
} from '../application/cnc-telegram.types';
import type {
  CncAutoCutStatusConfigureResponseDto,
  CncTelegramIngestResponseDto,
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
