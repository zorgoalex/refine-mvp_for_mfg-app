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
  extraResources: ExtraResourceDto[];
  millingTypes: HdfMillingSettingsDto[];
}

export interface HdfMillingSettingsDto {
  millingTypeId: number;
  name: string;
  hdfEnabled: boolean;
  hdfEdgeMm: number | null;
  hdfParameterName: string | null;
  extraResources: MillingExtraResourceDto[];
  version: number;
  isActive: boolean;
}

export interface MillingExtraResourceDto {
  id: number;
  millingTypeId: number;
  extraResourceId: number | null;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  parameterName: string;
  parameterMm: number | null;
  hdfAutoEnabled: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface ExtraResourceDto {
  id: number;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  defaultParameterName: string;
  defaultParameterMm: number | null;
  hdfAutoDefault: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
  version: number;
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
  hdfEnabled?: boolean;
  hdfEdgeMm?: number | null;
  hdfParameterName?: string | null;
  extraResources?: UpdateMillingExtraResourceCommand[];
  expectedVersion: number;
  idempotencyKey: string;
  requestId?: string;
}

export interface UpdateMillingExtraResourceCommand {
  id?: number;
  version?: number;
  extraResourceId?: number | null;
  resourceKind?: string;
  resourceRefType?: string | null;
  resourceRefId?: number | null;
  resourceName?: string;
  unitId?: number | null;
  accountingMethod?: string;
  parameterName?: string;
  parameterMm?: number | null;
  hdfAutoEnabled?: boolean;
  comment?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpsertExtraResourceCommand {
  currentUser: CurrentUser;
  id?: number;
  version?: number;
  resourceKind: string;
  resourceRefType?: string | null;
  resourceRefId?: number | null;
  resourceName: string;
  unitId?: number | null;
  accountingMethod?: string;
  defaultParameterName?: string;
  defaultParameterMm?: number | null;
  hdfAutoDefault?: boolean;
  comment?: string;
  isActive?: boolean;
  sortOrder?: number;
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

  async getExtraResources(currentUser: CurrentUser): Promise<ExtraResourceDto[]> {
    this.requireAny(currentUser, ['settings.view', 'settings.manage']);
    return readExtraResources(this.database);
  }

  async createExtraResource(command: UpsertExtraResourceCommand): Promise<ExtraResourceDto> {
    this.require(command.currentUser, 'settings.manage');
    const resource = normalizeExtraResourceInput(command, false);
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
      const replay = await reconcileIdempotency(tx, command.idempotencyKey, 'settings.extra_resource_create', {
        actorUserId: command.currentUser.id,
        resource,
      }, command.currentUser.id);
      if (replay.completedResponse) return parseExtraResourceResponse(replay.completedResponse);
      const created = await insertExtraResource(tx, resource);
      await bumpHdfRevision(tx);
      await auditService.record(tx, {
        event: 'settings.extra_resource_created',
        entityType: 'extra_resource',
        entityId: created.id,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId ?? 'extra-resource-create',
        source: SOURCE,
        before: null,
        after: created as unknown as Record<string, unknown>,
        diff: {},
        metadata: { action: 'extra_resource_created' },
        relatedEntities: [{ entityType: 'extra_resource', entityId: created.id }],
      });
      await completeIdempotency(tx, command.idempotencyKey, created);
      return created;
    });
  }

  async updateExtraResource(command: UpsertExtraResourceCommand): Promise<ExtraResourceDto> {
    this.require(command.currentUser, 'settings.manage');
    const id = normalizeOptionalPositiveInt(command.id, 'extraResourceId');
    if (id === undefined) throw new ApiError(400, 'BAD_REQUEST', 'Invalid extra resource id');
    const version = normalizeOptionalPositiveInt(command.version, 'version');
    if (version === undefined) throw new ApiError(422, 'VALIDATION_ERROR', 'Extra resource version is required');
    const resource = normalizeExtraResourceInput(command, true);
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
      const replay = await reconcileIdempotency(tx, command.idempotencyKey, 'settings.extra_resource_update', {
        actorUserId: command.currentUser.id,
        id,
        version,
        resource,
      }, command.currentUser.id);
      if (replay.completedResponse) return parseExtraResourceResponse(replay.completedResponse);
      const before = await readExtraResourceForUpdate(tx, id);
      if (!before) throw new ApiError(404, 'EXTRA_RESOURCE_NOT_FOUND', 'Extra resource not found');
      if (before.version !== version) {
        throw new ApiError(409, 'EXTRA_RESOURCE_VERSION_CONFLICT', 'Extra resource changed', {
          currentVersion: before.version,
          expectedVersion: version,
        });
      }
      const updated = await updateExtraResourceRow(tx, id, resource);
      await refreshMillingLinksForExtraResource(tx, updated);
      await bumpHdfRevision(tx);
      await auditService.record(tx, {
        event: 'settings.extra_resource_changed',
        entityType: 'extra_resource',
        entityId: id,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId ?? 'extra-resource-update',
        source: SOURCE,
        before: before as unknown as Record<string, unknown>,
        after: updated as unknown as Record<string, unknown>,
        diff: {},
        metadata: { action: 'extra_resource_changed' },
        relatedEntities: [{ entityType: 'extra_resource', entityId: id }],
      });
      await completeIdempotency(tx, command.idempotencyKey, updated);
      return updated;
    });
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
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [command.currentUser.id]);
      const replay = await reconcileIdempotency(tx, command.idempotencyKey, 'settings.production_hdf_milling_update', {
        actorUserId: command.currentUser.id,
        millingTypeId: command.millingTypeId,
        hdfEnabled: command.hdfEnabled ?? null,
        hdfEdgeMm: command.hdfEdgeMm ?? null,
        hdfParameterName: command.hdfParameterName ?? null,
        extraResources: command.extraResources ?? null,
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
      const existingResources = await readMillingResources(tx, command.millingTypeId);
      const nextResources = normalizeMillingResources(command, existingResources);
      const nextHdfResource = pickActiveHdfResource(nextResources);
      const nextHdfEnabled = nextHdfResource !== null;
      const nextHdfEdgeMm = nextHdfResource?.parameterMm ?? null;
      if (nextHdfEnabled && (nextHdfEdgeMm === null || nextHdfEdgeMm <= 0)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'HDF parameter must be positive when auto HDF is enabled');
      }
      await tx.query(
        `
        UPDATE milling_types
        SET hdf_enabled = $2,
            hdf_edge_mm = $3,
            version = version + 1
        WHERE milling_type_id = $1
        `,
        [command.millingTypeId, nextHdfEnabled, nextHdfEnabled ? nextHdfEdgeMm : null],
      );
      await syncMillingResources(tx, command.millingTypeId, existingResources, nextResources);
      const beforeHdfEnabled = row.hdf_enabled === true;
      const beforeHdfEdgeMm = toNullableNumber(row.hdf_edge_mm);
      if (beforeHdfEnabled !== nextHdfEnabled || beforeHdfEdgeMm !== (nextHdfEnabled ? nextHdfEdgeMm : null)) {
        await bumpHdfRevision(tx);
      }
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
          hdfEnabled: beforeHdfEnabled,
          hdfEdgeMm: beforeHdfEdgeMm,
          extraResources: existingResources,
          version: Number(row.version),
        },
        after: {
          hdfEnabled: nextHdfEnabled,
          hdfEdgeMm: nextHdfEnabled ? nextHdfEdgeMm : null,
          extraResources: nextResources.map(resourceToAuditShape),
          version: Number(row.version) + 1,
        },
        diff: {},
        metadata: { action: 'milling_extra_resources_changed', millingTypeId: command.millingTypeId },
        relatedEntities: [{ entityType: 'milling_type', entityId: command.millingTypeId }],
      });
      await enqueueOutbox(tx, 'setting.production_hdf_milling_changed', 'milling_type', String(command.millingTypeId), command.idempotencyKey, {
        hdfEnabled: nextHdfEnabled,
        hdfEdgeMm: nextHdfEnabled ? nextHdfEdgeMm : null,
      });
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

interface MillingResourceRow {
  milling_type_extra_resource_id: string | number;
  milling_type_id: string | number;
  extra_resource_id: string | number | null;
  resource_kind: string;
  resource_ref_type: string | null;
  resource_ref_id: string | number | null;
  resource_name: string;
  unit_id: string | number | null;
  accounting_method: string;
  parameter_name: string;
  parameter_mm: string | number | null;
  hdf_auto_enabled: boolean | null;
  comment: string | null;
  is_active: boolean | null;
  sort_order: string | number | null;
  version: string | number;
}

interface NormalizedMillingResource {
  id?: number;
  version?: number;
  extraResourceId: number | null;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  parameterName: string;
  parameterMm: number | null;
  hdfAutoEnabled: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
}

interface ExtraResourceRow {
  extra_resource_id: string | number;
  resource_kind: string;
  resource_ref_type: string | null;
  resource_ref_id: string | number | null;
  resource_name: string;
  unit_id: string | number | null;
  accounting_method: string;
  default_parameter_name: string | null;
  default_parameter_mm: string | number | null;
  hdf_auto_default: boolean | null;
  comment: string | null;
  is_active: boolean | null;
  sort_order: string | number | null;
  version: string | number;
}

interface NormalizedExtraResource {
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  defaultParameterName: string;
  defaultParameterMm: number | null;
  hdfAutoDefault: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
}

async function readExtraResources(client: { query: TransactionClient['query'] }): Promise<ExtraResourceDto[]> {
  const result = await client.query<ExtraResourceRow>(
    `
    SELECT extra_resource_id,
           resource_kind,
           resource_ref_type,
           resource_ref_id,
           resource_name,
           unit_id,
           accounting_method,
           default_parameter_name,
           default_parameter_mm,
           hdf_auto_default,
           comment,
           is_active,
           sort_order,
           version
    FROM extra_resources
    ORDER BY is_active DESC, sort_order ASC, resource_name ASC, extra_resource_id ASC
    `,
  );
  return result.rows.map(mapExtraResourceRow);
}

function mapExtraResourceRow(row: ExtraResourceRow): ExtraResourceDto {
  return {
    id: Number(row.extra_resource_id),
    resourceKind: row.resource_kind,
    resourceRefType: row.resource_ref_type ?? null,
    resourceRefId: toNullableNumber(row.resource_ref_id),
    resourceName: row.resource_name,
    unitId: toNullableNumber(row.unit_id),
    accountingMethod: row.accounting_method ?? '',
    defaultParameterName: row.default_parameter_name ?? '',
    defaultParameterMm: toNullableNumber(row.default_parameter_mm),
    hdfAutoDefault: row.hdf_auto_default === true,
    comment: row.comment ?? '',
    isActive: row.is_active !== false,
    sortOrder: Number(row.sort_order ?? 100),
    version: Number(row.version),
  };
}

function normalizeExtraResourceInput(command: UpsertExtraResourceCommand, update: boolean): NormalizedExtraResource {
  const defaultParameterMm = toNullableNumber(command.defaultParameterMm);
  if (defaultParameterMm !== null && defaultParameterMm <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Extra resource default parameter must be positive', {
      field: 'defaultParameterMm',
    });
  }
  return {
    resourceKind: normalizeRequiredText(command.resourceKind, 'resourceKind', 50),
    resourceRefType: normalizeOptionalText(command.resourceRefType, 50),
    resourceRefId: normalizeOptionalPositiveInt(command.resourceRefId ?? undefined, 'resourceRefId') ?? null,
    resourceName: normalizeRequiredText(command.resourceName, 'resourceName', 200),
    unitId: normalizeOptionalPositiveInt(command.unitId ?? undefined, 'unitId') ?? null,
    accountingMethod: normalizeOptionalText(command.accountingMethod, 500) ?? '',
    defaultParameterName: normalizeOptionalText(command.defaultParameterName, 100) ?? '',
    defaultParameterMm,
    hdfAutoDefault: command.hdfAutoDefault === true,
    comment: normalizeOptionalText(command.comment, 1000) ?? '',
    isActive: update ? command.isActive !== false : command.isActive !== false,
    sortOrder: normalizeSortOrder(command.sortOrder, 0),
  };
}

async function insertExtraResource(tx: TransactionClient, resource: NormalizedExtraResource): Promise<ExtraResourceDto> {
  const result = await tx.query<ExtraResourceRow>(
    `
    INSERT INTO extra_resources (
      resource_kind,
      resource_ref_type,
      resource_ref_id,
      resource_name,
      unit_id,
      accounting_method,
      default_parameter_name,
      default_parameter_mm,
      hdf_auto_default,
      comment,
      is_active,
      sort_order
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING extra_resource_id,
              resource_kind,
              resource_ref_type,
              resource_ref_id,
              resource_name,
              unit_id,
              accounting_method,
              default_parameter_name,
              default_parameter_mm,
              hdf_auto_default,
              comment,
              is_active,
              sort_order,
              version
    `,
    [
      resource.resourceKind,
      resource.resourceRefType,
      resource.resourceRefId,
      resource.resourceName,
      resource.unitId,
      resource.accountingMethod,
      resource.defaultParameterName,
      resource.defaultParameterMm,
      resource.hdfAutoDefault,
      resource.comment,
      resource.isActive,
      resource.sortOrder,
    ],
  );
  return mapExtraResourceRow(result.rows[0]);
}

async function updateExtraResourceRow(
  tx: TransactionClient,
  id: number,
  resource: NormalizedExtraResource,
): Promise<ExtraResourceDto> {
  const result = await tx.query<ExtraResourceRow>(
    `
    UPDATE extra_resources
    SET resource_kind = $2,
        resource_ref_type = $3,
        resource_ref_id = $4,
        resource_name = $5,
        unit_id = $6,
        accounting_method = $7,
        default_parameter_name = $8,
        default_parameter_mm = $9,
        hdf_auto_default = $10,
        comment = $11,
        is_active = $12,
        sort_order = $13,
        version = version + 1,
        updated_at = now()
    WHERE extra_resource_id = $1
    RETURNING extra_resource_id,
              resource_kind,
              resource_ref_type,
              resource_ref_id,
              resource_name,
              unit_id,
              accounting_method,
              default_parameter_name,
              default_parameter_mm,
              hdf_auto_default,
              comment,
              is_active,
              sort_order,
              version
    `,
    [
      id,
      resource.resourceKind,
      resource.resourceRefType,
      resource.resourceRefId,
      resource.resourceName,
      resource.unitId,
      resource.accountingMethod,
      resource.defaultParameterName,
      resource.defaultParameterMm,
      resource.hdfAutoDefault,
      resource.comment,
      resource.isActive,
      resource.sortOrder,
    ],
  );
  return mapExtraResourceRow(result.rows[0]);
}

async function readExtraResourceForUpdate(tx: TransactionClient, id: number): Promise<ExtraResourceDto | null> {
  const result = await tx.query<ExtraResourceRow>(
    `
    SELECT extra_resource_id,
           resource_kind,
           resource_ref_type,
           resource_ref_id,
           resource_name,
           unit_id,
           accounting_method,
           default_parameter_name,
           default_parameter_mm,
           hdf_auto_default,
           comment,
           is_active,
           sort_order,
           version
    FROM extra_resources
    WHERE extra_resource_id = $1
    FOR UPDATE
    `,
    [id],
  );
  return result.rows[0] ? mapExtraResourceRow(result.rows[0]) : null;
}

async function readExtraResourceById(tx: TransactionClient, id: number): Promise<ExtraResourceDto | null> {
  const result = await tx.query<ExtraResourceRow>(
    `
    SELECT extra_resource_id,
           resource_kind,
           resource_ref_type,
           resource_ref_id,
           resource_name,
           unit_id,
           accounting_method,
           default_parameter_name,
           default_parameter_mm,
           hdf_auto_default,
           comment,
           is_active,
           sort_order,
           version
    FROM extra_resources
    WHERE extra_resource_id = $1
    `,
    [id],
  );
  return result.rows[0] ? mapExtraResourceRow(result.rows[0]) : null;
}

async function refreshMillingLinksForExtraResource(tx: TransactionClient, resource: ExtraResourceDto): Promise<void> {
  await tx.query(
    `
    UPDATE milling_type_extra_resources
    SET resource_kind = $2,
        resource_ref_type = $3,
        resource_ref_id = $4,
        resource_name = $5,
        unit_id = $6,
        accounting_method = $7,
        parameter_name = CASE WHEN btrim(parameter_name) = '' THEN $8 ELSE parameter_name END,
        parameter_mm = COALESCE(parameter_mm, $9),
        version = version + 1,
        updated_at = now()
    WHERE extra_resource_id = $1
    `,
    [
      resource.id,
      resource.resourceKind,
      resource.resourceRefType,
      resource.resourceRefId,
      resource.resourceName,
      resource.unitId,
      resource.accountingMethod,
      resource.defaultParameterName,
      resource.defaultParameterMm,
    ],
  );
}

function extraResourceToMillingDefaults(resource: ExtraResourceDto): Pick<NormalizedMillingResource,
  'resourceKind' | 'resourceRefType' | 'resourceRefId' | 'resourceName' | 'unitId' | 'accountingMethod' | 'parameterName' | 'parameterMm' | 'hdfAutoEnabled'
> {
  return {
    resourceKind: resource.resourceKind,
    resourceRefType: resource.resourceRefType,
    resourceRefId: resource.resourceRefId,
    resourceName: resource.resourceName,
    unitId: resource.unitId,
    accountingMethod: resource.accountingMethod,
    parameterName: resource.defaultParameterName,
    parameterMm: resource.defaultParameterMm,
    hdfAutoEnabled: resource.hdfAutoDefault,
  };
}

async function readMillingResources(
  client: { query: TransactionClient['query'] },
  millingTypeId?: number,
): Promise<MillingExtraResourceDto[]> {
  const params = millingTypeId ? [millingTypeId] : [];
  const result = await client.query<MillingResourceRow>(
    `
    SELECT milling_type_extra_resource_id,
           link.milling_type_id,
           link.extra_resource_id,
           COALESCE(resource.resource_kind, link.resource_kind) AS resource_kind,
           COALESCE(resource.resource_ref_type, link.resource_ref_type) AS resource_ref_type,
           COALESCE(resource.resource_ref_id, link.resource_ref_id) AS resource_ref_id,
           COALESCE(resource.resource_name, link.resource_name) AS resource_name,
           COALESCE(resource.unit_id, link.unit_id) AS unit_id,
           COALESCE(resource.accounting_method, link.accounting_method) AS accounting_method,
           COALESCE(NULLIF(link.parameter_name, ''), resource.default_parameter_name, '') AS parameter_name,
           COALESCE(link.parameter_mm, resource.default_parameter_mm) AS parameter_mm,
           link.hdf_auto_enabled,
           link.comment,
           link.is_active,
           link.sort_order,
           link.version
    FROM milling_type_extra_resources link
    LEFT JOIN extra_resources resource ON resource.extra_resource_id = link.extra_resource_id
    ${millingTypeId ? 'WHERE link.milling_type_id = $1' : ''}
    ORDER BY link.milling_type_id ASC, link.sort_order ASC, link.milling_type_extra_resource_id ASC
    `,
    params,
  );
  return result.rows.map(mapMillingResourceRow);
}

function mapMillingResourceRow(row: MillingResourceRow): MillingExtraResourceDto {
  return {
    id: Number(row.milling_type_extra_resource_id),
    millingTypeId: Number(row.milling_type_id),
    extraResourceId: toNullableNumber(row.extra_resource_id),
    resourceKind: row.resource_kind,
    resourceRefType: row.resource_ref_type ?? null,
    resourceRefId: toNullableNumber(row.resource_ref_id),
    resourceName: row.resource_name,
    unitId: toNullableNumber(row.unit_id),
    accountingMethod: row.accounting_method ?? '',
    parameterName: row.parameter_name ?? '',
    parameterMm: toNullableNumber(row.parameter_mm),
    hdfAutoEnabled: row.hdf_auto_enabled === true,
    comment: row.comment ?? '',
    isActive: row.is_active !== false,
    sortOrder: Number(row.sort_order ?? 100),
    version: Number(row.version),
  };
}

function normalizeMillingResources(
  command: UpdateHdfMillingCommand,
  existingResources: MillingExtraResourceDto[],
): NormalizedMillingResource[] {
  if (command.extraResources === undefined) {
    return normalizeLegacyMillingResources(command, existingResources);
  }
  const seen = new Set<number>();
  return command.extraResources.map((resource, index) => {
    const normalized = normalizeMillingResourceInput(resource, index);
    if (normalized.id !== undefined) {
      if (seen.has(normalized.id)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Duplicate milling extra resource id', {
          field: `extraResources.${index}.id`,
          id: normalized.id,
        });
      }
      seen.add(normalized.id);
    }
    return normalized;
  });
}

function normalizeLegacyMillingResources(
  command: UpdateHdfMillingCommand,
  existingResources: MillingExtraResourceDto[],
): NormalizedMillingResource[] {
  if (command.hdfEnabled === undefined) return existingResources.map(resourceToNormalized);
  const next = existingResources.map(resourceToNormalized).map((resource) => (
    resource.hdfAutoEnabled ? { ...resource, isActive: false } : resource
  ));
  if (command.hdfEnabled !== true) return next;

  const parameterMm = toNullableNumber(command.hdfEdgeMm);
  if (parameterMm === null || parameterMm <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'HDF parameter must be positive when auto HDF is enabled');
  }
  const existingHdfIndex = next.findIndex((resource) => resource.hdfAutoEnabled);
  const existingHdf = existingHdfIndex >= 0 ? next[existingHdfIndex] : null;
  const hdfResource: NormalizedMillingResource = {
    ...(existingHdf ?? {
      extraResourceId: null,
      resourceKind: 'sheet_material',
      resourceRefType: null,
      resourceRefId: null,
      resourceName: 'ХДФ',
      unitId: null,
      accountingMethod: 'Автоматический расчет ХДФ-детали по размерам исходной детали',
      comment: '',
      sortOrder: 100,
    }),
    parameterName: normalizeOptionalText(command.hdfParameterName, 100) || existingHdf?.parameterName || 'Параметр',
    parameterMm,
    hdfAutoEnabled: true,
    isActive: true,
  };
  if (existingHdfIndex >= 0) {
    next[existingHdfIndex] = hdfResource;
  } else {
    next.push(hdfResource);
  }
  return next;
}

function resourceToNormalized(resource: MillingExtraResourceDto): NormalizedMillingResource {
  return {
    id: resource.id,
    version: resource.version,
    extraResourceId: resource.extraResourceId,
    resourceKind: resource.resourceKind,
    resourceRefType: resource.resourceRefType,
    resourceRefId: resource.resourceRefId,
    resourceName: resource.resourceName,
    unitId: resource.unitId,
    accountingMethod: resource.accountingMethod,
    parameterName: resource.parameterName,
    parameterMm: resource.parameterMm,
    hdfAutoEnabled: resource.hdfAutoEnabled,
    comment: resource.comment,
    isActive: resource.isActive,
    sortOrder: resource.sortOrder,
  };
}

function normalizeMillingResourceInput(
  resource: UpdateMillingExtraResourceCommand,
  index: number,
): NormalizedMillingResource {
  const id = normalizeOptionalPositiveInt(resource.id, `extraResources.${index}.id`);
  const version = normalizeOptionalPositiveInt(resource.version, `extraResources.${index}.version`);
  if (id !== undefined && version === undefined) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Existing milling extra resource must include version', {
      field: `extraResources.${index}.version`,
    });
  }
  const parameterMm = toNullableNumber(resource.parameterMm);
  if (parameterMm !== null && parameterMm <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Milling extra resource parameter must be positive', {
      field: `extraResources.${index}.parameterMm`,
    });
  }
  const hdfAutoEnabled = resource.hdfAutoEnabled === true;
  const isActive = resource.isActive !== false;
  const extraResourceId = normalizeOptionalPositiveInt(resource.extraResourceId ?? undefined, `extraResources.${index}.extraResourceId`) ?? null;
  const resourceKind = normalizeOptionalText(resource.resourceKind, 50) ?? '';
  const resourceName = normalizeOptionalText(resource.resourceName, 200) ?? '';
  if (extraResourceId === null && (!resourceKind || !resourceName)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Milling extra resource must reference a directory item or include resource fields', {
      field: `extraResources.${index}.extraResourceId`,
    });
  }
  if (isActive && hdfAutoEnabled && parameterMm === null) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Auto HDF resource must include a positive parameter', {
      field: `extraResources.${index}.parameterMm`,
    });
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(version === undefined ? {} : { version }),
    extraResourceId,
    resourceKind,
    resourceRefType: normalizeOptionalText(resource.resourceRefType, 50),
    resourceRefId: normalizeOptionalPositiveInt(resource.resourceRefId ?? undefined, `extraResources.${index}.resourceRefId`) ?? null,
    resourceName,
    unitId: normalizeOptionalPositiveInt(resource.unitId ?? undefined, `extraResources.${index}.unitId`) ?? null,
    accountingMethod: normalizeOptionalText(resource.accountingMethod, 500) ?? '',
    parameterName: normalizeOptionalText(resource.parameterName, 100) ?? '',
    parameterMm,
    hdfAutoEnabled,
    comment: normalizeOptionalText(resource.comment, 1000) ?? '',
    isActive,
    sortOrder: normalizeSortOrder(resource.sortOrder, index),
  };
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = normalizeOptionalText(value, maxLength);
  if (!normalized) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Required text field is empty', { field });
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Text field is too long', { maxLength });
  }
  return normalized;
}

function normalizeOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Expected a positive integer', { field });
  }
  return parsed;
}

function normalizeSortOrder(value: unknown, index: number): number {
  if (value === null || value === undefined || value === '') return 100 + index;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 32767) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid sort order', { field: `extraResources.${index}.sortOrder` });
  }
  return parsed;
}

function pickActiveHdfResource<T extends { hdfAutoEnabled: boolean; isActive: boolean; sortOrder: number; id?: number; parameterMm: number | null }>(
  resources: T[],
): T | null {
  return resources
    .filter((resource) => resource.isActive && resource.hdfAutoEnabled)
    .sort((left, right) => left.sortOrder - right.sortOrder || (left.id ?? 0) - (right.id ?? 0))[0] ?? null;
}

async function syncMillingResources(
  tx: TransactionClient,
  millingTypeId: number,
  existingResources: MillingExtraResourceDto[],
  nextResources: NormalizedMillingResource[],
): Promise<void> {
  const existingById = new Map(existingResources.map((resource) => [resource.id, resource]));
  const incomingExistingIds = new Set<number>();
  for (const inputResource of nextResources) {
    let resource = inputResource;
    if (inputResource.extraResourceId !== null) {
      const selected = await readExtraResourceById(tx, inputResource.extraResourceId);
      if (!selected || selected.isActive === false) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Selected extra resource is not available', {
          field: 'extraResourceId',
          extraResourceId: inputResource.extraResourceId,
        });
      }
      const defaults = extraResourceToMillingDefaults(selected);
      resource = {
        ...inputResource,
        ...defaults,
        parameterName: inputResource.parameterName || defaults.parameterName,
        parameterMm: inputResource.parameterMm ?? defaults.parameterMm,
        hdfAutoEnabled: inputResource.hdfAutoEnabled,
      };
    }
    if (resource.id !== undefined) {
      incomingExistingIds.add(resource.id);
      const existing = existingById.get(resource.id);
      if (!existing) {
        throw new ApiError(404, 'MILLING_EXTRA_RESOURCE_NOT_FOUND', 'Milling extra resource not found', {
          id: resource.id,
          millingTypeId,
        });
      }
      if (resource.version !== undefined && existing.version !== resource.version) {
        throw new ApiError(409, 'MILLING_EXTRA_RESOURCE_VERSION_CONFLICT', 'Milling extra resource changed', {
          id: resource.id,
          currentVersion: existing.version,
          expectedVersion: resource.version,
        });
      }
      await tx.query(
        `
        UPDATE milling_type_extra_resources
        SET extra_resource_id = $3,
            resource_kind = $4,
            resource_ref_type = $5,
            resource_ref_id = $6,
            resource_name = $7,
            unit_id = $8,
            accounting_method = $9,
            parameter_name = $10,
            parameter_mm = $11,
            hdf_auto_enabled = $12,
            comment = $13,
            is_active = $14,
            sort_order = $15,
            version = version + 1,
            updated_at = now()
        WHERE milling_type_extra_resource_id = $1
          AND milling_type_id = $2
        `,
        [
          resource.id,
          millingTypeId,
          resource.extraResourceId,
          resource.resourceKind,
          resource.resourceRefType,
          resource.resourceRefId,
          resource.resourceName,
          resource.unitId,
          resource.accountingMethod,
          resource.parameterName,
          resource.parameterMm,
          resource.hdfAutoEnabled,
          resource.comment,
          resource.isActive,
          resource.sortOrder,
        ],
      );
      continue;
    }
    await tx.query(
      `
      INSERT INTO milling_type_extra_resources (
        milling_type_id,
        extra_resource_id,
        resource_kind,
        resource_ref_type,
        resource_ref_id,
        resource_name,
        unit_id,
        accounting_method,
        parameter_name,
        parameter_mm,
        hdf_auto_enabled,
        comment,
        is_active,
        sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        millingTypeId,
        resource.extraResourceId,
        resource.resourceKind,
        resource.resourceRefType,
        resource.resourceRefId,
        resource.resourceName,
        resource.unitId,
        resource.accountingMethod,
        resource.parameterName,
        resource.parameterMm,
        resource.hdfAutoEnabled,
        resource.comment,
        resource.isActive,
        resource.sortOrder,
      ],
    );
  }
  for (const existing of existingResources) {
    if (incomingExistingIds.has(existing.id)) continue;
    await tx.query(
      `
      UPDATE milling_type_extra_resources
      SET is_active = false,
          version = version + 1,
          updated_at = now()
      WHERE milling_type_extra_resource_id = $1
        AND milling_type_id = $2
        AND is_active IS DISTINCT FROM false
      `,
      [existing.id, millingTypeId],
    );
  }
}

function resourceToAuditShape(resource: NormalizedMillingResource): Record<string, unknown> {
  return {
    id: resource.id ?? null,
    extraResourceId: resource.extraResourceId,
    resourceKind: resource.resourceKind,
    resourceRefType: resource.resourceRefType,
    resourceRefId: resource.resourceRefId,
    resourceName: resource.resourceName,
    unitId: resource.unitId,
    accountingMethod: resource.accountingMethod,
    parameterName: resource.parameterName,
    parameterMm: resource.parameterMm,
    hdfAutoEnabled: resource.hdfAutoEnabled,
    comment: resource.comment,
    isActive: resource.isActive,
    sortOrder: resource.sortOrder,
    version: resource.version ?? null,
  };
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
  const resources = await readMillingResources(client);
  const extraResourcesDirectory = await readExtraResources(client);
  const resourcesByMilling = new Map<number, MillingExtraResourceDto[]>();
  for (const resource of resources) {
    const list = resourcesByMilling.get(resource.millingTypeId) ?? [];
    list.push(resource);
    resourcesByMilling.set(resource.millingTypeId, list);
  }
  const row = settingsResult.rows[0];
  return {
    minSideThresholdMm: toNullableNumber(row?.threshold_value),
    minSideThresholdVersion: toNullableNumber(row?.threshold_version),
    sheetMaterialTypeId: toNullableNumber(row?.material_id),
    sheetMaterialName: row?.material_name ?? null,
    sheetMaterialVersion: toNullableNumber(row?.material_version),
    configRevision: Number(row?.config_revision ?? 1),
    extraResources: extraResourcesDirectory,
    millingTypes: millingResult.rows.map((milling) => {
      const millingTypeId = Number(milling.milling_type_id);
      const extraResources = resourcesByMilling.get(millingTypeId) ?? [];
      const hdfResource = pickActiveHdfResource(extraResources);
      const legacyHdfEnabled = milling.hdf_enabled === true;
      const legacyHdfEdgeMm = toNullableNumber(milling.hdf_edge_mm);
      return {
        millingTypeId,
        name: milling.milling_type_name,
        hdfEnabled: hdfResource !== null || legacyHdfEnabled,
        hdfEdgeMm: hdfResource?.parameterMm ?? legacyHdfEdgeMm,
        hdfParameterName: hdfResource?.parameterName || (hdfResource !== null || legacyHdfEnabled ? 'Параметр' : null),
        extraResources,
        version: Number(milling.version),
        isActive: milling.is_active !== false,
      };
    }),
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
      extraResources: parseExtraResources(row.extraResources),
      millingTypes: Array.isArray(row.millingTypes)
        ? row.millingTypes.map((milling) => {
            const item = milling as Partial<HdfMillingSettingsDto>;
            const millingTypeId = Number(item.millingTypeId);
            return {
              millingTypeId,
              name: typeof item.name === 'string' ? item.name : '',
              hdfEnabled: item.hdfEnabled === true,
              hdfEdgeMm: toNullableNumber(item.hdfEdgeMm),
              hdfParameterName: typeof item.hdfParameterName === 'string' ? item.hdfParameterName : null,
              extraResources: parseMillingExtraResources(item.extraResources, millingTypeId),
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
    extraResources: [],
    millingTypes: [],
  };
}

function parseExtraResourceResponse(value: unknown): ExtraResourceDto {
  const parsed = parseExtraResources([value])[0];
  if (!parsed) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'Invalid extra resource response');
  }
  return parsed;
}

function parseExtraResources(value: unknown): ExtraResourceDto[] {
  if (!Array.isArray(value)) return [];
  return value.map((resource) => {
    const item = resource as Partial<ExtraResourceDto>;
    return {
      id: Number(item.id),
      resourceKind: typeof item.resourceKind === 'string' && item.resourceKind.trim() ? item.resourceKind : 'other',
      resourceRefType: typeof item.resourceRefType === 'string' && item.resourceRefType.trim() ? item.resourceRefType : null,
      resourceRefId: toNullableNumber(item.resourceRefId),
      resourceName: typeof item.resourceName === 'string' ? item.resourceName : '',
      unitId: toNullableNumber(item.unitId),
      accountingMethod: typeof item.accountingMethod === 'string' ? item.accountingMethod : '',
      defaultParameterName: typeof item.defaultParameterName === 'string' ? item.defaultParameterName : '',
      defaultParameterMm: toNullableNumber(item.defaultParameterMm),
      hdfAutoDefault: item.hdfAutoDefault === true,
      comment: typeof item.comment === 'string' ? item.comment : '',
      isActive: item.isActive !== false,
      sortOrder: Number(item.sortOrder ?? 100),
      version: Number(item.version ?? 1),
    };
  }).filter((resource) => Number.isInteger(resource.id) && resource.id > 0);
}

function parseMillingExtraResources(value: unknown, fallbackMillingTypeId: number): MillingExtraResourceDto[] {
  if (!Array.isArray(value)) return [];
  return value.map((resource) => {
    const item = resource as Partial<MillingExtraResourceDto>;
    return {
      id: Number(item.id),
      millingTypeId: Number(item.millingTypeId ?? fallbackMillingTypeId),
      extraResourceId: toNullableNumber(item.extraResourceId),
      resourceKind: typeof item.resourceKind === 'string' && item.resourceKind.trim() ? item.resourceKind : 'other',
      resourceRefType: typeof item.resourceRefType === 'string' && item.resourceRefType.trim() ? item.resourceRefType : null,
      resourceRefId: toNullableNumber(item.resourceRefId),
      resourceName: typeof item.resourceName === 'string' ? item.resourceName : '',
      unitId: toNullableNumber(item.unitId),
      accountingMethod: typeof item.accountingMethod === 'string' ? item.accountingMethod : '',
      parameterName: typeof item.parameterName === 'string' ? item.parameterName : '',
      parameterMm: toNullableNumber(item.parameterMm),
      hdfAutoEnabled: item.hdfAutoEnabled === true,
      comment: typeof item.comment === 'string' ? item.comment : '',
      isActive: item.isActive !== false,
      sortOrder: Number(item.sortOrder ?? 100),
      version: Number(item.version ?? 1),
    };
  }).filter((resource) => Number.isInteger(resource.id) && resource.id > 0);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
