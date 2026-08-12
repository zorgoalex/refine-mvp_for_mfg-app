import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  CreateManualSvgCommentPresetCommand,
  IngestCncTelegramPacketCommand,
  ListManualSvgCommentPresetsCommand,
  ListCncTelegramTodayCommand,
  ManualSvgUploadCommand,
} from './cnc-telegram.types';
import type {
  CncTelegramIngestResponseDto,
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadResponseDto,
  CncTelegramTodayResponseDto,
} from '../dto/cnc-telegram.dto';

export interface CncTelegramServicePorts {
  packets: CncTelegramRepositoryPort;
  deniedAudit?: CncTelegramDeniedAuditPort;
  permissions?: PermissionsService;
}

export class CncTelegramService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: CncTelegramServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listToday(command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра CNC-потока', {
        requiredPermissions: ['orders.view'],
      });
    }
    return this.ports.packets.listToday(command);
  }

  async ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'cut.manage')) {
      await this.recordDenied(command);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для приёма CNC-пакетов', {
        requiredPermissions: ['cut.manage'],
      });
    }
    return this.ports.packets.ingest(command);
  }

  async manualSvgUpload(command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'cut.manage')) {
      await this.recordManualSvgDenied(command);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для загрузки SVG-раскроя', {
        requiredPermissions: ['cut.manage'],
      });
    }
    return this.ports.packets.manualSvgUpload(command);
  }

  async listManualSvgCommentPresets(
    command: ListManualSvgCommentPresetsCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto[]> {
    if (!this.permissions.canUser(command.currentUser, 'cut.manage')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра пресетов комментариев', {
        requiredPermissions: ['cut.manage'],
      });
    }
    return this.ports.packets.listManualSvgCommentPresets(command);
  }

  async createManualSvgCommentPreset(
    command: CreateManualSvgCommentPresetCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto> {
    if (!this.permissions.canUser(command.currentUser, 'cut.manage')) {
      await this.recordPresetDenied(command);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для создания пресета комментария', {
        requiredPermissions: ['cut.manage'],
      });
    }
    return this.ports.packets.createManualSvgCommentPreset(command);
  }

  private async recordDenied(command: IngestCncTelegramPacketCommand): Promise<void> {
    try {
      await this.ports.deniedAudit?.recordIngestDenied({
        currentUser: command.currentUser,
        event: 'cnc.telegram_packet.ingest_denied',
        requestId: command.requestId,
        externalPacketKey: command.dto.externalPacketKey,
        reason: 'PERMISSION_DENIED',
        requiredPermissions: ['cut.manage'],
      });
    } catch {
      // Deny response must not depend on the audit sink.
    }
  }

  private async recordManualSvgDenied(command: ManualSvgUploadCommand): Promise<void> {
    try {
      await this.ports.deniedAudit?.recordIngestDenied({
        currentUser: command.currentUser,
        event: 'cnc.manual_svg_upload.denied',
        requestId: command.requestId,
        externalPacketKey: command.dto.svgContentHash,
        reason: 'PERMISSION_DENIED',
        requiredPermissions: ['cut.manage'],
      });
    } catch {
      // Deny response must not depend on the audit sink.
    }
  }

  private async recordPresetDenied(command: CreateManualSvgCommentPresetCommand): Promise<void> {
    try {
      await this.ports.deniedAudit?.recordIngestDenied({
        currentUser: command.currentUser,
        event: 'cnc.manual_svg_comment_preset.create_denied',
        requestId: command.requestId,
        externalPacketKey: command.dto.label,
        reason: 'PERMISSION_DENIED',
        requiredPermissions: ['cut.manage'],
      });
    } catch {
      // Deny response must not depend on the audit sink.
    }
  }
}
