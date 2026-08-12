import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadDto,
  CncTelegramManualSvgUploadResponseDto,
  CreateCncTelegramManualSvgCommentPresetDto,
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
  ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto>;
  manualSvgUpload(command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto>;
  listManualSvgCommentPresets(command: ListManualSvgCommentPresetsCommand): Promise<CncTelegramManualSvgCommentPresetDto[]>;
  createManualSvgCommentPreset(command: CreateManualSvgCommentPresetCommand): Promise<CncTelegramManualSvgCommentPresetDto>;
}

export interface RecordCncTelegramDeniedAuditCommand {
  currentUser: CurrentUser;
  event:
    | 'cnc.telegram_packet.ingest_denied'
    | 'cnc.manual_svg_upload.denied'
    | 'cnc.manual_svg_comment_preset.create_denied';
  requestId?: string;
  externalPacketKey?: string;
  reason: 'PERMISSION_DENIED';
  requiredPermissions: ['cut.manage'];
}

export interface CncTelegramDeniedAuditPort {
  recordIngestDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void>;
}
