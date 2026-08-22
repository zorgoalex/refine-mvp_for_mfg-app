import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CncAutoCutStatusConfigureResponseDto,
  CncTelegramIngestResponseDto,
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadDto,
  CncTelegramManualSvgUploadResponseDto,
  CncTelegramOrderCuttingSequencesResponseDto,
  CncTelegramOriginalBoardResponseDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayResponseDto,
  CreateCncTelegramManualSvgCommentPresetDto,
} from '../dto/cnc-telegram.dto';

export interface ListCncTelegramTodayCommand {
  currentUser: CurrentUser;
  workday?: string | null;
  workdayFrom?: string | null;
  workdayTo?: string | null;
  requestId?: string;
}

export interface ListCncTelegramOriginalBoardCommand {
  currentUser: CurrentUser;
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

export interface ManualSvgUploadCommand {
  currentUser: CurrentUser;
  dto: CncTelegramManualSvgUploadDto;
  requestId?: string;
}

export interface CreateManualSvgCommentPresetCommand {
  currentUser: CurrentUser;
  dto: CreateCncTelegramManualSvgCommentPresetDto;
  idempotencyKey: string;
  requestId?: string;
}

export interface ListManualSvgCommentPresetsCommand {
  currentUser: CurrentUser;
  requestId?: string;
}

export interface CncTelegramRepositoryPort {
  listToday(command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto>;
  listOriginalBoard(command: ListCncTelegramOriginalBoardCommand): Promise<CncTelegramOriginalBoardResponseDto>;
  listOrderCuttingSequences(
    command: ListCncTelegramOrderCuttingSequencesCommand,
  ): Promise<CncTelegramOrderCuttingSequencesResponseDto>;
  ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto>;
  manualSvgUpload(command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto>;
  listManualSvgCommentPresets(
    command: ListManualSvgCommentPresetsCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto[]>;
  createManualSvgCommentPreset(
    command: CreateManualSvgCommentPresetCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto>;
  configureAutoCutStatus(
    command: ConfigureCncAutoCutStatusCommand,
  ): Promise<CncAutoCutStatusConfigureResponseDto>;
}

export interface RecordCncTelegramDeniedAuditCommand {
  currentUser: CurrentUser;
  event:
    | 'cnc.telegram_packet.ingest_denied'
    | 'cnc.manual_svg_upload.denied'
    | 'cnc.manual_svg_comment_preset.create_denied'
    | 'cnc.telegram_packet.auto_cut_status_configure_denied'
    | 'cnc.telegram_worker.audit_write_denied';
  requestId?: string;
  externalPacketKey?: string;
  reason: 'PERMISSION_DENIED' | 'CNC_TELEGRAM_CHAT_DENIED' | 'BACKGROUND_INGEST_DISABLED' | 'BACKGROUND_INGEST_APPROVAL_REQUIRED';
  requiredPermissions: ['cut.manage'] | ['status_automation.manage'];
}

export interface CncTelegramDeniedAuditPort {
  recordIngestDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
  recordAutoCutStatusConfigureDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
  recordWorkerAuditWriteDenied?(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
}
