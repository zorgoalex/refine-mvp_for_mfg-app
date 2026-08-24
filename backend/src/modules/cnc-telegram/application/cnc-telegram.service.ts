import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  ConfigureCncAutoCutStatusCommand,
  CreateManualSvgCommentPresetCommand,
  IngestCncTelegramPacketCommand,
  ListManualSvgCommentPresetsCommand,
  ListCncTelegramOrderCuttingSequencesCommand,
  ListCncTelegramOriginalBoardCommand,
  ListCncTelegramTodayCommand,
  ManualSvgUploadCommand,
} from './cnc-telegram.types';
import type {
  CncAutoCutStatusConfigureResponseDto,
  CncTelegramIngestResponseDto,
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadResponseDto,
  CncTelegramOrderCuttingSequencesResponseDto,
  CncTelegramOriginalBoardResponseDto,
  CncTelegramTodayResponseDto,
} from '../dto/cnc-telegram.dto';

export interface CncTelegramServicePorts {
  packets: CncTelegramRepositoryPort;
  deniedAudit?: CncTelegramDeniedAuditPort;
  permissions?: PermissionsService;
  backgroundIngestEnabled?: boolean;
  manualSvgDestinationChatIds?: readonly string[];
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

  async listOriginalBoard(
    command: ListCncTelegramOriginalBoardCommand,
  ): Promise<CncTelegramOriginalBoardResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра CNC-потока', {
        requiredPermissions: ['orders.view'],
      });
    }
    return this.ports.packets.listOriginalBoard(command);
  }

  assertCanViewMedia(currentUser: ListCncTelegramTodayCommand['currentUser']): void {
    if (!this.permissions.canUser(currentUser, 'cut.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра изображения раскроя', {
        requiredPermissions: ['cut.view'],
      });
    }
  }

  async listOrderCuttingSequences(
    command: ListCncTelegramOrderCuttingSequencesCommand,
  ): Promise<CncTelegramOrderCuttingSequencesResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра CNC-раскроев заказа', {
        requiredPermissions: ['orders.view'],
      });
    }
    return this.ports.packets.listOrderCuttingSequences(command);
  }

  async ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'cut.manage')) {
      await this.recordDenied(command);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для приёма CNC-пакетов', {
        requiredPermissions: ['cut.manage'],
      });
    }
    // Phase A deliberately has no approved bounded scan artifact. Keep this
    // legacy endpoint fail-closed even if an operator enables the env switch;
    // Phase B will add the persisted approval and explicit import path.
    await this.recordBackgroundIngestDenied(command);
    throw new ApiError(
      503,
      this.ports.backgroundIngestEnabled
        ? 'CNC_TELEGRAM_BACKGROUND_INGEST_APPROVAL_REQUIRED'
        : 'CNC_TELEGRAM_BACKGROUND_INGEST_DISABLED',
      this.ports.backgroundIngestEnabled
        ? 'Legacy CNC Telegram ingest requires an approved bounded scan request'
        : 'Legacy CNC Telegram background ingest is disabled',
    );
  }

  async manualSvgUpload(command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'cut.manage')) {
      await this.recordManualSvgUploadDenied(command);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для загрузки SVG-раскроя', {
        requiredPermissions: ['cut.manage'],
      });
    }
    if (command.dto.telegramSend?.enabled !== true) {
      return this.ports.packets.manualSvgUpload(command);
    }
    const destinations = (this.ports.manualSvgDestinationChatIds ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    if (destinations.length !== 1) {
      throw new ApiError(
        503,
        'CNC_TELEGRAM_MANUAL_SEND_DESTINATION_UNAVAILABLE',
        'Для ручной отправки SVG должен быть настроен ровно один Telegram-чат',
        { configuredDestinationCount: destinations.length },
      );
    }
    return this.ports.packets.manualSvgUpload({
      ...command,
      telegramDestinationChatId: destinations[0],
    });
  }

  async listManualSvgCommentPresets(
    command: ListManualSvgCommentPresetsCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto[]> {
    if (!this.permissions.canUser(command.currentUser, 'cut.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра пресетов SVG-раскроя', {
        requiredPermissions: ['cut.view'],
      });
    }
    return this.ports.packets.listManualSvgCommentPresets(command);
  }

  async createManualSvgCommentPreset(
    command: CreateManualSvgCommentPresetCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto> {
    if (!this.permissions.canUser(command.currentUser, 'cut.manage')) {
      await this.recordManualSvgCommentPresetDenied(command);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для создания пресета SVG-раскроя', {
        requiredPermissions: ['cut.manage'],
      });
    }
    return this.ports.packets.createManualSvgCommentPreset(command);
  }

  async configureAutoCutStatus(
    command: ConfigureCncAutoCutStatusCommand,
  ): Promise<CncAutoCutStatusConfigureResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'status_automation.manage')) {
      await this.recordAutoCutStatusConfigureDenied(command);
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Недостаточно прав для настройки автостатуса распила',
        { requiredPermissions: ['status_automation.manage'] },
      );
    }
    return this.ports.packets.configureAutoCutStatus(command);
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

  private async recordBackgroundIngestDenied(command: IngestCncTelegramPacketCommand): Promise<void> {
    try {
      await this.ports.deniedAudit?.recordIngestDenied({
        currentUser: command.currentUser,
        event: 'cnc.telegram_packet.ingest_denied',
        requestId: command.requestId,
        externalPacketKey: command.dto.externalPacketKey,
        reason: this.ports.backgroundIngestEnabled
          ? 'BACKGROUND_INGEST_APPROVAL_REQUIRED'
          : 'BACKGROUND_INGEST_DISABLED',
        requiredPermissions: ['cut.manage'],
      });
    } catch {
      // Fail-closed response must not depend on the audit sink.
    }
  }

  private async recordManualSvgUploadDenied(command: ManualSvgUploadCommand): Promise<void> {
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

  private async recordManualSvgCommentPresetDenied(
    command: CreateManualSvgCommentPresetCommand,
  ): Promise<void> {
    try {
      await this.ports.deniedAudit?.recordIngestDenied({
        currentUser: command.currentUser,
        event: 'cnc.manual_svg_comment_preset.create_denied',
        requestId: command.requestId,
        reason: 'PERMISSION_DENIED',
        requiredPermissions: ['cut.manage'],
      });
    } catch {
      // Deny response must not depend on the audit sink.
    }
  }

  private async recordAutoCutStatusConfigureDenied(
    command: ConfigureCncAutoCutStatusCommand,
  ): Promise<void> {
    try {
      await this.ports.deniedAudit?.recordAutoCutStatusConfigureDenied({
        currentUser: command.currentUser,
        event: 'cnc.telegram_packet.auto_cut_status_configure_denied',
        requestId: command.requestId,
        reason: 'PERMISSION_DENIED',
        requiredPermissions: ['status_automation.manage'],
      });
    } catch {
      // Deny response must not depend on the audit sink.
    }
  }
}
