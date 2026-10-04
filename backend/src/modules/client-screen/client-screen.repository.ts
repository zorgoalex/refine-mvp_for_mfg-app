import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { computeDiff } from '../../common/audit/audit-diff';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { normalizeClientScreenCodes } from './client-screen.registry';
import type {
  ClientScreenSettingsDto,
  UpdateClientScreenSettingsCommand,
  UpdateClientScreenSettingsResult,
} from './client-screen.types';

export const CLIENT_SCREEN_AUDIT_SOURCE = 'backend-client-screen';
export const CLIENT_SCREEN_ENTITY_TYPE = 'client_screen_settings';

interface SettingsRow extends QueryResultRow {
  enabled: boolean;
  visible_codes: string[];
  version: string;
  updated_at: Date;
}

const SETTINGS_SELECT = `
  SELECT s.enabled, s.visible_codes, s.version, s.updated_at
    FROM client_screen_settings s
   WHERE s.config_id = 1`;

/** The one row of client_screen_settings: what the customer screen may show and whether it may run at all. */
@Injectable()
export class ClientScreenRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async getSettings(): Promise<ClientScreenSettingsDto> {
    const row = (await this.database.query<SettingsRow>(SETTINGS_SELECT)).rows[0];
    if (!row) throw settingsMissing();
    return settingsDto(row);
  }

  /**
   * Row lock, then: the same values are a no-op (no version bump, no audit), a stale version is a 409,
   * otherwise the row is replaced and audited in the same transaction.
   */
  async updateSettings(command: UpdateClientScreenSettingsCommand): Promise<UpdateClientScreenSettingsResult> {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const row = (await tx.query<SettingsRow>(`${SETTINGS_SELECT} FOR UPDATE OF s`)).rows[0];
      if (!row) throw settingsMissing();
      const current = settingsDto(row);
      const before = comparable(current);
      const after = { enabled: command.enabled, visibleCodes: normalizeClientScreenCodes(command.visibleCodes) };
      if (before.enabled === after.enabled && sameCodes(before.visibleCodes, after.visibleCodes)) {
        return { changed: false, settings: current };
      }
      if (command.expectedVersion !== current.version) {
        throw new ApiError(409, 'CLIENT_SCREEN_SETTINGS_VERSION_CONFLICT', 'Настройки уже изменил другой пользователь. Показаны актуальные', {
          settings: current,
        });
      }
      await tx.query(
        `UPDATE client_screen_settings
            SET enabled = $1, visible_codes = $2::text[], version = version + 1, updated_by_user_id = $3, updated_at = now()
          WHERE config_id = 1`,
        [after.enabled, after.visibleCodes, actor.userId],
      );
      const updated = settingsDto((await tx.query<SettingsRow>(SETTINGS_SELECT)).rows[0]);
      await auditService.record(tx, {
        event: 'client_screen.settings_updated',
        entityType: CLIENT_SCREEN_ENTITY_TYPE,
        entityId: '1',
        actorUserId: actor.userId,
        actorUsername: actor.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: CLIENT_SCREEN_AUDIT_SOURCE,
        before: { ...before, version: current.version },
        after: { ...comparable(updated), version: updated.version },
        diff: computeDiff(before, comparable(updated)),
        metadata: { correlationId: command.requestId },
      });
      return { changed: true, settings: updated };
    });
  }
}

async function lockActor(tx: DatabaseClient, currentUser: CurrentUser): Promise<{ userId: number; username: string }> {
  const userId = Number(currentUser.id);
  const actor = Number.isSafeInteger(userId) && userId > 0
    ? (await tx.query<{ username: string }>(
      `SELECT username::text AS username FROM users
        WHERE user_id = $1 AND is_active = true AND is_service_account = false
        FOR SHARE`,
      [userId],
    )).rows[0]
    : undefined;
  if (!actor) {
    throw new ApiError(403, 'CLIENT_SCREEN_ACTOR_INVALID', 'Настройки экрана клиента меняет только активный пользователь ERP');
  }
  return { userId, username: actor.username };
}

function settingsDto(row: SettingsRow): ClientScreenSettingsDto {
  return {
    enabled: row.enabled,
    // A code dropped from the registry later may still sit in the row; it is simply not shown.
    visibleCodes: normalizeClientScreenCodes(row.visible_codes),
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString(),
  };
}

function comparable(settings: ClientScreenSettingsDto): Pick<ClientScreenSettingsDto, 'enabled' | 'visibleCodes'> {
  return { enabled: settings.enabled, visibleCodes: settings.visibleCodes };
}

function sameCodes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((code, index) => code === right[index]);
}

function settingsMissing(): ApiError {
  return new ApiError(503, 'CLIENT_SCREEN_SETTINGS_MISSING', 'Настройки экрана клиента не найдены — примените миграции');
}
