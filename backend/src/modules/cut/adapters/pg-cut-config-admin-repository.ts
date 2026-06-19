import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
import {
  type CutConfigAdminPort,
  type CutConfigContext,
  type CutConfigDto,
  type CutParamProfileDto,
  type CutRenderPresetDto,
  type CutSettingRowDto,
  type DeleteCatalogRowCommand,
  type UpdateCutSettingCommand,
  type UpsertCutParamProfileCommand,
  type UpsertCutRenderPresetCommand,
} from '../application/cut-config-admin.types';
import {
  validateParamProfileInput,
  validateRenderPresetInput,
  validateSettingValue,
} from '../application/cut-config-validation';
import { CutConfigRowNotFoundError, CutStaleVersionError } from '../errors/cut.errors';

const AUDIT_SOURCE = 'backend-cut-config';

export const CUT_CONFIG_AUDIT_EVENTS = {
  settingUpdated: 'cut_config.setting_updated',
  paramProfileUpserted: 'cut_config.param_profile_upserted',
  paramProfileDeleted: 'cut_config.param_profile_deleted',
  renderPresetUpserted: 'cut_config.render_preset_upserted',
  renderPresetDeleted: 'cut_config.render_preset_deleted',
} as const;

/**
 * Backend-owned cut-configuration CRUD (plan §4a). Every write is audited in-tx
 * (cut_config.* events, before/after diff), optimistic-version-guarded, and
 * write-time validated (grain enum, positive dims). Reads are served here too,
 * so the /configuration "Раскрой" tab needs no new Hasura access.
 */
export class PgCutConfigAdminRepository implements CutConfigAdminPort {
  constructor(private readonly database: DatabaseService) {}

  async recordPermissionDenied(input: import('../application/cut-config-admin.types').CutConfigPermissionDeniedInput): Promise<void> {
    await auditService.recordDenied(this.database, {
      event: 'cut_config.permission_denied',
      entityType: 'cut_config',
      entityId: 'config',
      actorUserId: input.currentUser.id,
      actorUsername: input.currentUser.username ?? null,
      actorRole: input.currentUser.role ?? null,
      requestId: input.requestId ?? AUDIT_SOURCE,
      source: AUDIT_SOURCE,
      reason: 'permission_denied',
      requiredPermissions: input.requiredPermissions,
    });
  }

  async getConfig(_context: CutConfigContext): Promise<CutConfigDto> {
    const [settings, profiles, presets] = await Promise.all([
      this.database.query<{ key: string; value: unknown; version: number }>(
        `SELECT key, value, version FROM cut_settings ORDER BY key`,
      ),
      this.database.query(
        `SELECT cut_param_profile_id, name, params, is_default, is_active, version FROM cut_param_profiles ORDER BY name`,
      ),
      this.database.query(
        `SELECT cut_render_preset_id, name, target_px, background, is_active, version FROM cut_render_presets ORDER BY target_px`,
      ),
    ]);

    return {
      settings: settings.rows.map((r) => ({ key: r.key, value: r.value, version: toNum(r.version) })),
      paramProfiles: profiles.rows.map(mapProfile),
      renderPresets: presets.rows.map(mapPreset),
    };
  }

  async updateSetting(command: UpdateCutSettingCommand): Promise<CutSettingRowDto> {
    const cleanValue = validateSettingValue(command.key, command.value);
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const existing = await tx.query<{ value: unknown; version: number }>(
        `SELECT value, version FROM cut_settings WHERE key = $1 FOR UPDATE`,
        [command.key],
      );
      if (existing.rowCount === 0) {
        throw new CutConfigRowNotFoundError('cut_settings', command.key);
      }
      assertVersion(toNum(existing.rows[0].version), command.expectedVersion, command.key);

      const updated = await tx.query<{ value: unknown; version: number }>(
        `UPDATE cut_settings SET value = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now()
         WHERE key = $1 RETURNING value, version`,
        [command.key, JSON.stringify(cleanValue), numOrNull(command.currentUser.id)],
      );
      await this.audit(tx, command.currentUser, {
        event: CUT_CONFIG_AUDIT_EVENTS.settingUpdated,
        entityType: 'cut_config',
        entityId: command.key,
        before: asObj(existing.rows[0].value),
        after: cleanValue,
        requestId: command.requestId,
      });
      return { key: command.key, value: updated.rows[0].value, version: toNum(updated.rows[0].version) };
    });
  }

  async upsertParamProfile(command: UpsertCutParamProfileCommand): Promise<CutParamProfileDto> {
    const input = validateParamProfileInput(command.input);
    return this.writeCatalog(() => this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      // Only one default profile (partial unique index): clear others first.
      if (input.isDefault) {
        await tx.query(`UPDATE cut_param_profiles SET is_default = false WHERE is_default = true`);
      }
      if (command.cutParamProfileId === undefined) {
        const inserted = await tx.query(
          `INSERT INTO cut_param_profiles (name, params, is_default, is_active, created_by, edited_by)
           VALUES ($1, $2::jsonb, COALESCE($3, false), COALESCE($4, true), $5, $5)
           RETURNING cut_param_profile_id, name, params, is_default, is_active, version`,
          [input.name, JSON.stringify(input.params), input.isDefault ?? null, input.isActive ?? null, numOrNull(command.currentUser.id)],
        );
        const row = mapProfile(inserted.rows[0]);
        await this.audit(tx, command.currentUser, {
          event: CUT_CONFIG_AUDIT_EVENTS.paramProfileUpserted,
          entityType: 'cut_param_profile',
          entityId: row.cutParamProfileId,
          before: null,
          after: profileDiffShape(row),
          requestId: command.requestId,
        });
        return row;
      }

      const existing = await tx.query(
        `SELECT cut_param_profile_id, name, params, is_default, is_active, version FROM cut_param_profiles WHERE cut_param_profile_id = $1 FOR UPDATE`,
        [command.cutParamProfileId],
      );
      if (existing.rowCount === 0) {
        throw new CutConfigRowNotFoundError('cut_param_profiles', command.cutParamProfileId);
      }
      const before = mapProfile(existing.rows[0]);
      assertVersion(before.version, command.expectedVersion ?? -1, String(command.cutParamProfileId));
      const updated = await tx.query(
        `UPDATE cut_param_profiles
         SET name = $2, params = $3::jsonb, is_default = COALESCE($4, is_default), is_active = COALESCE($5, is_active),
             version = version + 1, edited_by = $6, updated_at = now()
         WHERE cut_param_profile_id = $1
         RETURNING cut_param_profile_id, name, params, is_default, is_active, version`,
        [command.cutParamProfileId, input.name, JSON.stringify(input.params), input.isDefault ?? null, input.isActive ?? null, numOrNull(command.currentUser.id)],
      );
      const after = mapProfile(updated.rows[0]);
      await this.audit(tx, command.currentUser, {
        event: CUT_CONFIG_AUDIT_EVENTS.paramProfileUpserted,
        entityType: 'cut_param_profile',
        entityId: after.cutParamProfileId,
        before: profileDiffShape(before),
        after: profileDiffShape(after),
        requestId: command.requestId,
      });
      return after;
    }));
  }

  deleteParamProfile(command: DeleteCatalogRowCommand): Promise<void> {
    return this.softDeleteCatalog({
      table: 'cut_param_profiles',
      idColumn: 'cut_param_profile_id',
      event: CUT_CONFIG_AUDIT_EVENTS.paramProfileDeleted,
      entityType: 'cut_param_profile',
      command,
    });
  }

  async upsertRenderPreset(command: UpsertCutRenderPresetCommand): Promise<CutRenderPresetDto> {
    const input = validateRenderPresetInput(command.input);
    return this.writeCatalog(() => this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      if (command.cutRenderPresetId === undefined) {
        const inserted = await tx.query(
          `INSERT INTO cut_render_presets (name, target_px, background, is_active, created_by, edited_by)
           VALUES ($1, $2, COALESCE($3, '#ffffff'), COALESCE($4, true), $5, $5)
           RETURNING cut_render_preset_id, name, target_px, background, is_active, version`,
          [input.name, input.targetPx, input.background ?? null, input.isActive ?? null, numOrNull(command.currentUser.id)],
        );
        const row = mapPreset(inserted.rows[0]);
        await this.audit(tx, command.currentUser, {
          event: CUT_CONFIG_AUDIT_EVENTS.renderPresetUpserted,
          entityType: 'cut_render_preset',
          entityId: row.cutRenderPresetId,
          before: null,
          after: presetDiffShape(row),
          requestId: command.requestId,
        });
        return row;
      }
      const existing = await tx.query(
        `SELECT cut_render_preset_id, name, target_px, background, is_active, version FROM cut_render_presets WHERE cut_render_preset_id = $1 FOR UPDATE`,
        [command.cutRenderPresetId],
      );
      if (existing.rowCount === 0) {
        throw new CutConfigRowNotFoundError('cut_render_presets', command.cutRenderPresetId);
      }
      const before = mapPreset(existing.rows[0]);
      assertVersion(before.version, command.expectedVersion ?? -1, String(command.cutRenderPresetId));
      const updated = await tx.query(
        `UPDATE cut_render_presets
         SET name = $2, target_px = $3, background = COALESCE($4, background), is_active = COALESCE($5, is_active),
             version = version + 1, edited_by = $6, updated_at = now()
         WHERE cut_render_preset_id = $1
         RETURNING cut_render_preset_id, name, target_px, background, is_active, version`,
        [command.cutRenderPresetId, input.name, input.targetPx, input.background ?? null, input.isActive ?? null, numOrNull(command.currentUser.id)],
      );
      const after = mapPreset(updated.rows[0]);
      await this.audit(tx, command.currentUser, {
        event: CUT_CONFIG_AUDIT_EVENTS.renderPresetUpserted,
        entityType: 'cut_render_preset',
        entityId: after.cutRenderPresetId,
        before: presetDiffShape(before),
        after: presetDiffShape(after),
        requestId: command.requestId,
      });
      return after;
    }));
  }

  deleteRenderPreset(command: DeleteCatalogRowCommand): Promise<void> {
    return this.softDeleteCatalog({
      table: 'cut_render_presets',
      idColumn: 'cut_render_preset_id',
      event: CUT_CONFIG_AUDIT_EVENTS.renderPresetDeleted,
      entityType: 'cut_render_preset',
      command,
    });
  }

  /** Soft delete = deactivate (is_active=false): catalog rows may be referenced by
   *  existing cut_groups (ON DELETE RESTRICT), so a physical delete is unsafe. */
  private softDeleteCatalog(opts: {
    table: string;
    idColumn: string;
    event: string;
    entityType: string;
    command: DeleteCatalogRowCommand;
  }): Promise<void> {
    const { command } = opts;
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const existing = await tx.query<{ version: number; is_active: boolean }>(
        `SELECT version, is_active FROM ${opts.table} WHERE ${opts.idColumn} = $1 FOR UPDATE`,
        [command.id],
      );
      if (existing.rowCount === 0) {
        throw new CutConfigRowNotFoundError(opts.table, command.id);
      }
      assertVersion(toNum(existing.rows[0].version), command.expectedVersion, String(command.id));
      await tx.query(
        `UPDATE ${opts.table} SET is_active = false, version = version + 1, updated_at = now() WHERE ${opts.idColumn} = $1`,
        [command.id],
      );
      await this.audit(tx, command.currentUser, {
        event: opts.event,
        entityType: opts.entityType,
        entityId: command.id,
        // Factual before-state (a repeat deactivation logs isActive:false -> false).
        before: { isActive: Boolean(existing.rows[0].is_active) },
        after: { isActive: false },
        requestId: command.requestId,
      });
    });
  }

  /** Map a unique-constraint violation (duplicate name, or the single-default
   *  partial index under concurrency) to a 409 instead of a raw 500. */
  private async writeCatalog<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ApiError(409, 'CUT_CONFIG_CONFLICT', 'Конфликт уникальности (имя или признак "по умолчанию" уже заняты)', {});
      }
      throw error;
    }
  }

  private async audit(
    tx: TransactionClient,
    currentUser: CurrentUser,
    input: {
      event: string;
      entityType: string;
      entityId: string | number;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      requestId?: string;
    },
  ): Promise<void> {
    const diff = input.before && input.after ? computeDiff(input.before, input.after) : null;
    const event: AuditEvent = {
      event: input.event,
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: currentUser.id,
      actorUsername: currentUser.username ?? null,
      actorRole: currentUser.role ?? null,
      requestId: input.requestId ?? AUDIT_SOURCE,
      source: AUDIT_SOURCE,
      before: input.before,
      after: input.after,
      diff,
      relatedEntities: [],
    };
    await auditService.record(tx, event);
  }
}

function mapProfile(r: Record<string, unknown>): CutParamProfileDto {
  return {
    cutParamProfileId: toNum(r.cut_param_profile_id),
    name: String(r.name),
    params: (r.params as Record<string, unknown>) ?? {},
    isDefault: Boolean(r.is_default),
    isActive: Boolean(r.is_active),
    version: toNum(r.version),
  };
}

function mapPreset(r: Record<string, unknown>): CutRenderPresetDto {
  return {
    cutRenderPresetId: toNum(r.cut_render_preset_id),
    name: String(r.name),
    targetPx: toNum(r.target_px),
    background: String(r.background),
    isActive: Boolean(r.is_active),
    version: toNum(r.version),
  };
}

function profileDiffShape(p: CutParamProfileDto): Record<string, unknown> {
  return { name: p.name, params: p.params, isDefault: p.isDefault, isActive: p.isActive };
}

function presetDiffShape(p: CutRenderPresetDto): Record<string, unknown> {
  return { name: p.name, targetPx: p.targetPx, background: p.background, isActive: p.isActive };
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function assertVersion(actual: number, expected: number, id: string): void {
  if (actual !== expected) {
    throw new CutStaleVersionError(Number(id) || 0, expected, actual);
  }
}

function toNum(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function setSessionUser(tx: TransactionClient, userId: string | number): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [String(userId)]);
}
