import { createHash } from 'node:crypto';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';

const SOURCE = 'backend-production-tech-settings';
const HDF_THRESHOLD_KEY = 'production.hdf.min_side_threshold_mm';
const HDF_MATERIAL_KEY = 'production.hdf.sheet_material_type_id';

export interface HdfSettingsDto {
  minSideThresholdMm: number | null;
  minSideThresholdVersion: number | null;
  sheetMaterialTypeId: number | null;
  sheetMaterialName: string | null;
  sheetMaterialVersion: number | null;
  configRevision: number;
  millingTypes: HdfMillingSettingsDto[];
}

export interface HdfMillingSettingsDto {
  millingTypeId: number;
  name: string;
  hdfEnabled: boolean;
  hdfEdgeMm: number | null;
  version: number;
  isActive: boolean;
}

export interface UpdateHdfSettingsCommand {
  currentUser: CurrentUser;
  minSideThresholdMm?: number;
  minSideThresholdVersion?: number;
  sheetMaterialTypeId?: number | null;
  sheetMaterialVersion?: number;
  idempotencyKey: string;
  requestId?: string;
}

export interface UpdateHdfMillingCommand {
  currentUser: CurrentUser;
  millingTypeId: number;
  hdfEnabled: boolean;
  hdfEdgeMm: number | null;
  expectedVersion: number;
  idempotencyKey: string;
  requestId?: string;
}

export class OrderHdfSettingsService {
  private readonly permissions = new PermissionsService();

  constructor(private readonly database: DatabaseService) {}

  async get(currentUser: CurrentUser): Promise<HdfSettingsDto> {
    this.requireAny(currentUser, ['settings.view', 'settings.manage']);
    return readHdfSettings(this.database);
  }

  async update(command: UpdateHdfSettingsCommand): Promise<HdfSettingsDto> {
    this.require(command.currentUser, 'settings.manage');
    if (command.minSideThresholdMm !== undefined && command.minSideThresholdMm <= 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'HDF threshold must be positive');
    }
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
      const replay = await reconcileIdempotency(tx, command.idempotencyKey, 'settings.production_hdf_update', {
        actorUserId: command.currentUser.id,
        minSideThresholdMm: command.minSideThresholdMm,
        minSideThresholdVersion: command.minSideThresholdVersion,
        sheetMaterialTypeId: command.sheetMaterialTypeId,
        sheetMaterialVersion: command.sheetMaterialVersion,
      }, command.currentUser.id);
      if (replay.completedResponse) return parseHdfSettingsResponse(replay.completedResponse);
      const before = await readHdfSettings(tx);
      const touchedEvents: string[] = [];
      if (command.minSideThresholdMm !== undefined) {
        await upsertSetting(tx, HDF_THRESHOLD_KEY, command.minSideThresholdMm, command.minSideThresholdVersion);
        touchedEvents.push('settings.production_hdf_threshold_changed');
      }
      if (command.sheetMaterialTypeId !== undefined) {
        if (command.sheetMaterialTypeId !== null) {
          await assertSheetMaterial(tx, command.sheetMaterialTypeId);
        }
        await upsertSetting(tx, HDF_MATERIAL_KEY, command.sheetMaterialTypeId, command.sheetMaterialVersion);
        touchedEvents.push('settings.production_hdf_material_changed');
      }
      if (touchedEvents.length > 0) {
        await bumpHdfRevision(tx);
        const after = await readHdfSettings(tx);
        for (const event of touchedEvents) {
          await recordSettingAudit(tx, command, event, before, after);
          await enqueueOutbox(tx, event.replace('settings.', 'setting.'), 'hdf_settings', 'global', command.idempotencyKey, after);
        }
      }
      const response = await readHdfSettings(tx);
      await completeIdempotency(tx, command.idempotencyKey, response);
      return response;
    });
  }

  async updateMilling(command: UpdateHdfMillingCommand): Promise<void> {
    this.require(command.currentUser, 'settings.manage');
    if (command.hdfEnabled && (command.hdfEdgeMm === null || command.hdfEdgeMm <= 0)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'HDF edge must be positive when HDF is enabled');
    }
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
      const replay = await reconcileIdempotency(tx, command.idempotencyKey, 'settings.production_hdf_milling_update', {
        actorUserId: command.currentUser.id,
        millingTypeId: command.millingTypeId,
        hdfEnabled: command.hdfEnabled,
        hdfEdgeMm: command.hdfEdgeMm,
        expectedVersion: command.expectedVersion,
      }, command.currentUser.id);
      if (replay.completedResponse) return;
      const before = await tx.query(
        `SELECT milling_type_id, milling_type_name, hdf_enabled, hdf_edge_mm, version
         FROM milling_types WHERE milling_type_id = $1 FOR UPDATE`,
        [command.millingTypeId],
      );
      const row = before.rows[0];
      if (!row) throw new ApiError(404, 'MILLING_TYPE_NOT_FOUND', 'Milling type not found');
      if (Number(row.version) !== command.expectedVersion) {
        throw new ApiError(409, 'MILLING_TYPE_VERSION_CONFLICT', 'Milling HDF settings changed', {
          currentVersion: Number(row.version),
          expectedVersion: command.expectedVersion,
        });
      }
      await tx.query(
        `
        UPDATE milling_types
        SET hdf_enabled = $2,
            hdf_edge_mm = $3,
            version = version + 1
        WHERE milling_type_id = $1
        `,
        [command.millingTypeId, command.hdfEnabled, command.hdfEnabled ? command.hdfEdgeMm : null],
      );
      await bumpHdfRevision(tx);
      await auditService.record(tx, {
        event: 'settings.production_hdf_milling_changed',
        entityType: 'milling_type',
        entityId: command.millingTypeId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId ?? 'hdf-milling-settings',
        source: SOURCE,
        before: {
          hdfEnabled: row.hdf_enabled === true,
          hdfEdgeMm: toNullableNumber(row.hdf_edge_mm),
          version: Number(row.version),
        },
        after: {
          hdfEnabled: command.hdfEnabled,
          hdfEdgeMm: command.hdfEnabled ? command.hdfEdgeMm : null,
          version: Number(row.version) + 1,
        },
        diff: {},
        metadata: { action: 'hdf_milling_changed', millingTypeId: command.millingTypeId },
        relatedEntities: [{ entityType: 'milling_type', entityId: command.millingTypeId }],
      });
      await enqueueOutbox(tx, 'setting.production_hdf_milling_changed', 'milling_type', String(command.millingTypeId), command.idempotencyKey, {});
      await completeIdempotency(tx, command.idempotencyKey, { success: true });
    });
  }

  private require(user: CurrentUser, permission: 'settings.manage'): void {
    if (this.permissions.canUser(user, permission)) return;
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для настройки HDF', {
      requiredPermissions: [permission],
    });
  }

  private requireAny(user: CurrentUser, permissions: Array<'settings.view' | 'settings.manage'>): void {
    if (permissions.some((permission) => this.permissions.canUser(user, permission))) return;
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра настроек HDF', {
      requiredPermissions: permissions,
    });
  }
}

interface HdfSettingsIdempotencyResult {
  completedResponse?: unknown;
}

async function reconcileIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  commandName: string,
  requestShape: unknown,
  actorUserId: number | string | null,
): Promise<HdfSettingsIdempotencyResult> {
  const requestHash = createHash('sha256').update(JSON.stringify(requestShape)).digest('hex');
  const inserted = await tx.query(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'settings', 'hdf', $4, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [idempotencyKey, commandName, toNullableNumber(actorUserId), requestHash],
  );
  if (inserted.rowCount && inserted.rowCount > 0) return {};
  const existing = await tx.query<{ request_hash: string; response_json: unknown; status: string }>(
    `SELECT request_hash, response_json, status FROM command_idempotency_keys WHERE idempotency_key = $1 FOR UPDATE`,
    [idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row || row.status === 'processing') {
    throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
  }
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with different HDF settings payload');
  }
  if (row.status === 'completed') {
    return { completedResponse: row.response_json ?? {} };
  }
  if (row.status === 'failed') {
    throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed');
  }
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
}

async function completeIdempotency(tx: TransactionClient, idempotencyKey: string, response: unknown): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed', response_json = $2::jsonb, completed_at = now()
    WHERE idempotency_key = $1 AND status = 'processing'
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function upsertSetting(
  tx: TransactionClient,
  key: string,
  value: number | null,
  expectedVersion: number | undefined,
): Promise<void> {
  if (expectedVersion !== undefined) {
    const current = await tx.query<{ version: string | number }>(
      `SELECT version FROM app_settings WHERE setting_key = $1 FOR UPDATE`,
      [key],
    );
    if (current.rows[0] && Number(current.rows[0].version) !== expectedVersion) {
      throw new ApiError(409, 'SETTING_VERSION_CONFLICT', 'HDF setting changed', {
        key,
        currentVersion: Number(current.rows[0].version),
        expectedVersion,
      });
    }
  }
  await tx.query(
    `
    INSERT INTO app_settings (setting_key, value_json, description, is_active, version)
    VALUES ($1, $2::jsonb, $3, true, 1)
    ON CONFLICT (setting_key)
    DO UPDATE SET value_json = EXCLUDED.value_json,
                  is_active = true,
                  version = app_settings.version + 1,
                  updated_at = now()
    `,
    [key, JSON.stringify({ value }), key],
  );
}

async function assertSheetMaterial(tx: TransactionClient, id: number): Promise<void> {
  const result = await tx.query(
    `SELECT 1 FROM sheet_material_types WHERE sheet_material_type_id = $1 AND is_active = true`,
    [id],
  );
  if (result.rowCount === 0) {
    throw new ApiError(422, 'HDF_MATERIAL_NOT_FOUND', 'HDF sheet material is inactive or missing', { id });
  }
}

async function bumpHdfRevision(tx: TransactionClient): Promise<void> {
  await tx.query(
    `
    INSERT INTO hdf_calculation_config_state (id, revision)
    VALUES (1, 1)
    ON CONFLICT (id)
    DO UPDATE SET revision = hdf_calculation_config_state.revision + 1,
                  updated_at = now()
    `,
  );
}

async function recordSettingAudit(
  tx: TransactionClient,
  command: UpdateHdfSettingsCommand,
  event: string,
  before: HdfSettingsDto,
  after: HdfSettingsDto,
): Promise<void> {
  await auditService.record(tx, {
    event,
    entityType: 'settings',
    entityId: 'hdf',
    actorUserId: command.currentUser.id,
    actorUsername: command.currentUser.username,
    actorRole: command.currentUser.role,
    requestId: command.requestId ?? 'hdf-settings',
    source: SOURCE,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
    diff: {},
    metadata: { action: event, idempotencyKey: command.idempotencyKey },
    relatedEntities: after.sheetMaterialTypeId ? [{ entityType: 'sheet_material_type', entityId: after.sheetMaterialTypeId }] : [],
  });
}

async function enqueueOutbox(
  tx: TransactionClient,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  idempotencyKey: string,
  payload: unknown,
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [eventType, aggregateType, aggregateId, JSON.stringify(payload), `${idempotencyKey}:${eventType}`],
  );
}

async function readHdfSettings(client: { query: TransactionClient['query'] }): Promise<HdfSettingsDto> {
  const settingsResult = await client.query<{
    threshold_value: string | number | null;
    threshold_version: string | number | null;
    material_id: string | number | null;
    material_version: string | number | null;
    material_name: string | null;
    config_revision: string | number;
  }>(
    `
    SELECT
      CASE WHEN COALESCE(threshold_setting.value_json->>'value', '') ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN (threshold_setting.value_json->>'value')::numeric ELSE NULL END AS threshold_value,
      threshold_setting.version AS threshold_version,
      CASE WHEN COALESCE(material_setting.value_json->>'value', '') ~ '^[1-9][0-9]*$'
        THEN (material_setting.value_json->>'value')::bigint ELSE NULL END AS material_id,
      material_setting.version AS material_version,
      smt.name AS material_name,
      state.revision AS config_revision
    FROM hdf_calculation_config_state state
    LEFT JOIN LATERAL (
      SELECT value_json, version
      FROM app_settings
      WHERE setting_key = $1 AND is_active = true
      LIMIT 1
    ) threshold_setting ON true
    LEFT JOIN LATERAL (
      SELECT value_json, version
      FROM app_settings
      WHERE setting_key = $2 AND is_active = true
      LIMIT 1
    ) material_setting ON true
    LEFT JOIN sheet_material_types smt
      ON smt.sheet_material_type_id = CASE WHEN COALESCE(material_setting.value_json->>'value', '') ~ '^[1-9][0-9]*$'
        THEN (material_setting.value_json->>'value')::bigint ELSE NULL END
    WHERE state.id = 1
    `,
    [HDF_THRESHOLD_KEY, HDF_MATERIAL_KEY],
  );
  const millingResult = await client.query<{
    milling_type_id: string | number;
    milling_type_name: string;
    hdf_enabled: boolean | null;
    hdf_edge_mm: string | number | null;
    version: string | number;
    is_active: boolean | null;
  }>(
    `
    SELECT milling_type_id, milling_type_name, hdf_enabled, hdf_edge_mm, version, is_active
    FROM milling_types
    ORDER BY sort_order ASC NULLS LAST, milling_type_id ASC
    `,
  );
  const row = settingsResult.rows[0];
  return {
    minSideThresholdMm: toNullableNumber(row?.threshold_value),
    minSideThresholdVersion: toNullableNumber(row?.threshold_version),
    sheetMaterialTypeId: toNullableNumber(row?.material_id),
    sheetMaterialName: row?.material_name ?? null,
    sheetMaterialVersion: toNullableNumber(row?.material_version),
    configRevision: Number(row?.config_revision ?? 1),
    millingTypes: millingResult.rows.map((milling) => ({
      millingTypeId: Number(milling.milling_type_id),
      name: milling.milling_type_name,
      hdfEnabled: milling.hdf_enabled === true,
      hdfEdgeMm: toNullableNumber(milling.hdf_edge_mm),
      version: Number(milling.version),
      isActive: milling.is_active !== false,
    })),
  };
}

function parseHdfSettingsResponse(value: unknown): HdfSettingsDto {
  if (value && typeof value === 'object') {
    const row = value as Partial<HdfSettingsDto>;
    return {
      minSideThresholdMm: toNullableNumber(row.minSideThresholdMm),
      minSideThresholdVersion: toNullableNumber(row.minSideThresholdVersion),
      sheetMaterialTypeId: toNullableNumber(row.sheetMaterialTypeId),
      sheetMaterialName: typeof row.sheetMaterialName === 'string' ? row.sheetMaterialName : null,
      sheetMaterialVersion: toNullableNumber(row.sheetMaterialVersion),
      configRevision: Number(row.configRevision ?? 1),
      millingTypes: Array.isArray(row.millingTypes)
        ? row.millingTypes.map((milling) => {
            const item = milling as Partial<HdfMillingSettingsDto>;
            return {
              millingTypeId: Number(item.millingTypeId),
              name: typeof item.name === 'string' ? item.name : '',
              hdfEnabled: item.hdfEnabled === true,
              hdfEdgeMm: toNullableNumber(item.hdfEdgeMm),
              version: Number(item.version ?? 1),
              isActive: item.isActive !== false,
            };
          }).filter((milling) => Number.isInteger(milling.millingTypeId) && milling.millingTypeId > 0)
        : [],
    };
  }
  return {
    minSideThresholdMm: null,
    minSideThresholdVersion: null,
    sheetMaterialTypeId: null,
    sheetMaterialName: null,
    sheetMaterialVersion: null,
    configRevision: 1,
    millingTypes: [],
  };
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
