import { ApiError } from '../../../common/errors/api-error';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  IngestCncTelegramPacketCommand,
  ListCncTelegramTodayCommand,
  RecordCncTelegramDeniedAuditCommand,
} from '../application/cnc-telegram.types';
import type {
  CncTelegramIngestResponseDto,
  CncTelegramTodayResponseDto,
} from '../dto/cnc-telegram.dto';

export class UnavailableCncTelegramRepository
  implements CncTelegramRepositoryPort, CncTelegramDeniedAuditPort
{
  async listToday(_command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto> {
    throw unavailable();
  }

  async ingest(_command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto> {
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
