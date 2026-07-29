import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CncTelegramIngestResponseDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayResponseDto,
} from '../dto/cnc-telegram.dto';

export interface ListCncTelegramTodayCommand {
  currentUser: CurrentUser;
  workday?: string | null;
  workdayFrom?: string | null;
  workdayTo?: string | null;
  requestId?: string;
}

export interface IngestCncTelegramPacketCommand {
  currentUser: CurrentUser;
  dto: CncTelegramStructuredIngestDto;
  requestId?: string;
}

export interface CncTelegramRepositoryPort {
  listToday(command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto>;
  ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto>;
}

export interface RecordCncTelegramDeniedAuditCommand {
  currentUser: CurrentUser;
  event: 'cnc.telegram_packet.ingest_denied';
  requestId?: string;
  externalPacketKey?: string;
  reason: 'PERMISSION_DENIED';
  requiredPermissions: ['cut.manage'];
}

export interface CncTelegramDeniedAuditPort {
  recordIngestDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
}
