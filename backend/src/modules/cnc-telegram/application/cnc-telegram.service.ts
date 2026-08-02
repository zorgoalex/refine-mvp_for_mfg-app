import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  ConfigureCncAutoCutStatusCommand,
  IngestCncTelegramPacketCommand,
  ListCncTelegramOrderCuttingSequencesCommand,
  ListCncTelegramTodayCommand,
} from './cnc-telegram.types';
import type {
  CncAutoCutStatusConfigureResponseDto,
  CncTelegramIngestResponseDto,
  CncTelegramOrderCuttingSequencesResponseDto,
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
    return this.ports.packets.ingest(command);
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
