import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CncAutoCutStatusConfigureResponseDto,
  CncTelegramIngestResponseDto,
  CncTelegramOrderCuttingSequencesResponseDto,
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

export interface ListCncTelegramOrderCuttingSequencesCommand {
  currentUser: CurrentUser;
  orderId: number;
  requestId?: string;
}

export interface IngestCncTelegramPacketCommand {
  currentUser: CurrentUser;
  dto: CncTelegramStructuredIngestDto;
  requestId?: string;
}

export interface ConfigureCncAutoCutStatusCommand {
  currentUser: CurrentUser;
  enabled: boolean;
  idempotencyKey: string;
  requestId?: string;
}

export interface CncTelegramRepositoryPort {
  listToday(command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto>;
  listOrderCuttingSequences(
    command: ListCncTelegramOrderCuttingSequencesCommand,
  ): Promise<CncTelegramOrderCuttingSequencesResponseDto>;
  ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto>;
  configureAutoCutStatus(
    command: ConfigureCncAutoCutStatusCommand,
  ): Promise<CncAutoCutStatusConfigureResponseDto>;
}

export interface RecordCncTelegramDeniedAuditCommand {
  currentUser: CurrentUser;
  event:
    | 'cnc.telegram_packet.ingest_denied'
    | 'cnc.telegram_packet.auto_cut_status_configure_denied'
    | 'cnc.telegram_worker.audit_write_denied';
  requestId?: string;
  externalPacketKey?: string;
  reason: 'PERMISSION_DENIED' | 'CNC_TELEGRAM_CHAT_DENIED';
  requiredPermissions: ['cut.manage'] | ['status_automation.manage'];
}

export interface CncTelegramDeniedAuditPort {
  recordIngestDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
  recordAutoCutStatusConfigureDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
  recordWorkerAuditWriteDenied?(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
}
