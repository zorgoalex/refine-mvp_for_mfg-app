import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { PermissionsService } from '../../permissions/permissions.service';
import { CLIENT_SCREEN_AUDIT_SOURCE, CLIENT_SCREEN_ENTITY_TYPE, ClientScreenRepository } from './client-screen.repository';
import type {
  ClientScreenSettingsDto,
  UpdateClientScreenSettingsCommand,
  UpdateClientScreenSettingsResult,
} from './client-screen.types';

const ORDERS_VIEW = 'orders.view';
const SETTINGS_MANAGE = 'settings.manage';

@Injectable()
export class ClientScreenService {
  constructor(
    @Inject(ClientScreenRepository) private readonly repository: ClientScreenRepository,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
    /** Denied attempts are audited outside the command transaction. */
    @Inject(DatabaseService) private readonly auditClient: DatabaseService,
  ) {}

  /** Read by everyone who can open an order (they present it) and by whoever edits the settings. */
  async getSettings(user: CurrentUser): Promise<ClientScreenSettingsDto> {
    if (!this.permissions.canUserAny(user, [ORDERS_VIEW, SETTINGS_MANAGE])) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра настроек экрана клиента', {
        requiredPermissions: [ORDERS_VIEW, SETTINGS_MANAGE],
      });
    }
    return this.repository.getSettings();
  }

  async updateSettings(command: UpdateClientScreenSettingsCommand): Promise<UpdateClientScreenSettingsResult> {
    if (!this.permissions.canUser(command.currentUser, SETTINGS_MANAGE)) {
      await auditService.recordDenied(this.auditClient, {
        event: 'client_screen.settings_denied',
        entityType: CLIENT_SCREEN_ENTITY_TYPE,
        entityId: '1',
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: CLIENT_SCREEN_AUDIT_SOURCE,
        reason: 'missing_permission',
        requiredPermissions: [SETTINGS_MANAGE],
        relatedEntities: [],
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для изменения настроек экрана клиента', {
        requiredPermissions: [SETTINGS_MANAGE],
      });
    }
    return this.repository.updateSettings(command);
  }
}
