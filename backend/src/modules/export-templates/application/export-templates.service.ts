import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import {
  type CreateExportTemplateInput,
  type UpdateExportTemplateInput,
} from '../dto/export-template.dto';
import { EXPORT_LIMITS, evaluateExpression, validateExportColumns } from './export-expression';
import { EXPORT_FIELD_CATALOG } from './export-template-fields';
import {
  EXPORT_TEMPLATE_SCHEMA_VERSION,
  type BazisExportDetail,
  type ExportTemplateCatalog,
  type ExportTemplateColumn,
  type ExportTemplateFormat,
  type ExportTemplateSnapshot,
  type ExportTemplateSource,
  type ExportTemplateSummary,
  type ExportTemplateTarget,
} from './export-template.types';

const AUDIT_SOURCE = 'backend.export-templates';

interface ExportTemplateRow extends QueryResultRow {
  export_template_id: string | number;
  code: string | null;
  name: string;
  description: string | null;
  target_screen: ExportTemplateTarget;
  source_type: ExportTemplateSource;
  format: ExportTemplateFormat;
  sheet_name: string;
  schema_version: number;
  template_hash: string;
  columns_json: ExportTemplateColumn[] | string;
  is_active: boolean;
  is_default: boolean;
  version: number;
  created_by: string | number | null;
  updated_by: string | number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ExportTemplateListFilters {
  targetScreen?: ExportTemplateTarget;
  sourceType?: ExportTemplateSource;
  format?: ExportTemplateFormat;
  includeInactive: boolean;
}

@Injectable()
export class ExportTemplatesService {
  private readonly permissions = new PermissionsService();

  constructor(private readonly database: DatabaseService) {}

  getCatalog(user: CurrentUser): ExportTemplateCatalog {
    this.requireSettingsView(user);
    return {
      schemaVersion: EXPORT_TEMPLATE_SCHEMA_VERSION,
      targets: [
        { code: 'bazis_cut_set', label: 'Набор Базис-раскрой', sourceType: 'bazis_cut_set_detail' },
        { code: 'bazis_project_card', label: 'Карточка Базис-проекта', sourceType: 'bazis_project_panel' },
      ],
      formats: [{ code: 'xls_biff8', label: 'Excel 97–2003 (.xls)' }],
      fields: EXPORT_FIELD_CATALOG,
      operators: ['exists', 'not_empty', 'equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte'],
      functions: {
        string: ['trim', 'upper', 'lower'],
        number: ['round', 'floor', 'ceil', 'abs'],
        math: ['add', 'subtract', 'multiply', 'divide'],
      },
      limits: {
        maxColumns: EXPORT_LIMITS.maxColumns,
        maxExpressionDepth: EXPORT_LIMITS.maxDepth,
        maxExpressionNodes: EXPORT_LIMITS.maxNodes,
        maxCells: EXPORT_LIMITS.maxCells,
        maxEvaluatedNodes: EXPORT_LIMITS.maxEvaluatedNodes,
      },
    };
  }

  async list(user: CurrentUser, filters: ExportTemplateListFilters): Promise<ExportTemplateSnapshot[]> {
    this.requireSettingsView(user);
    return this.queryList(filters);
  }

  async get(user: CurrentUser, id: number): Promise<ExportTemplateSnapshot> {
    this.requireSettingsView(user);
    return this.load(this.database, id);
  }

  async available(user: CurrentUser, input: {
    targetScreen: ExportTemplateTarget;
    sourceType: ExportTemplateSource;
    format: ExportTemplateFormat;
  }): Promise<ExportTemplateSummary[]> {
    this.assertTargetSource(input.targetScreen, input.sourceType);
    this.require(user, permissionForTarget(input.targetScreen));
    const templates = await this.queryList({ ...input, includeInactive: false });
    return templates.map(toSummary);
  }

  async resolveForExport(input: {
    templateId?: number;
    targetScreen: ExportTemplateTarget;
    sourceType: ExportTemplateSource;
    format: ExportTemplateFormat;
    client?: DatabaseClient;
  }): Promise<ExportTemplateSnapshot> {
    this.assertTargetSource(input.targetScreen, input.sourceType);
    const client = input.client ?? this.database;
    const result = input.templateId
      ? await client.query<ExportTemplateRow>(`${SELECT_TEMPLATE} WHERE export_template_id=$1 AND deleted_at IS NULL`, [input.templateId])
      : await client.query<ExportTemplateRow>(`${SELECT_TEMPLATE}
          WHERE target_screen=$1 AND source_type=$2 AND format=$3
            AND is_active=true AND is_default=true AND deleted_at IS NULL`,
        [input.targetScreen, input.sourceType, input.format]);
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(404, input.templateId ? 'EXPORT_TEMPLATE_NOT_FOUND' : 'EXPORT_TEMPLATE_DEFAULT_NOT_FOUND',
        input.templateId ? 'Export template not found' : 'Default export template not found');
    }
    const template = mapTemplate(row);
    if (!template.isActive) throw new ApiError(409, 'EXPORT_TEMPLATE_INACTIVE', 'Export template is inactive');
    if (template.targetScreen !== input.targetScreen || template.sourceType !== input.sourceType || template.format !== input.format) {
      throw new ApiError(422, 'EXPORT_TEMPLATE_SOURCE_MISMATCH', 'Export template does not match this screen/source');
    }
    validateExportColumns(template.columns);
    return template;
  }

  async preview(user: CurrentUser, input: {
    targetScreen: ExportTemplateTarget;
    sourceType: ExportTemplateSource;
    format: ExportTemplateFormat;
    columns: ExportTemplateColumn[];
  }): Promise<Array<{ columnKey: string; header: string; value: unknown; valueType: string }>> {
    this.requireSettingsView(user);
    this.assertTargetSource(input.targetScreen, input.sourceType);
    validateExportColumns(input.columns);
    const sample = sampleDetail(input.targetScreen);
    const context = { rowNumber: 1, exportedAt: new Date('2026-08-05T12:34:56.000Z'), templateName: 'Предпросмотр' };
    return input.columns.map((column) => {
      const value = evaluateExpression(column.expression, sample, context);
      return { columnKey: column.columnKey, header: column.header, value, valueType: value === null ? 'blank' : typeof value };
    });
  }

  async create(user: CurrentUser, requestId: string, input: CreateExportTemplateInput): Promise<ExportTemplateSnapshot> {
    await this.requireWrite(user, requestId, 'create');
    this.assertTargetSource(input.targetScreen, input.sourceType);
    validateExportColumns(input.columns);
    const requestHash = hashPayload(input);
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, user);
      const replay = await claimIdempotency<ExportTemplateSnapshot>(tx, input.idempotencyKey,
        'export_template.create', user.id, 'export_template', 'new', requestHash);
      if (replay) return replay;
      const templateHash = hashTemplate(input.schemaVersion, input.columns);
      let inserted;
      try {
        inserted = await tx.query<ExportTemplateRow>(`${INSERT_TEMPLATE} RETURNING ${TEMPLATE_COLUMNS}`, [
          input.name, input.description ?? null, input.targetScreen, input.sourceType, input.format,
          input.sheetName, input.schemaVersion, templateHash, JSON.stringify(input.columns), input.isActive, user.id,
        ]);
      } catch (error) {
        throw mapConstraintError(error);
      }
      const template = mapTemplate(inserted.rows[0]);
      await auditService.record(tx, auditEvent(user, requestId, 'export_template.created', template.exportTemplateId,
        {}, template as unknown as Record<string, unknown>, { command: 'create' }));
      await completeIdempotency(tx, input.idempotencyKey, template);
      return template;
    });
  }

  async update(user: CurrentUser, requestId: string, id: number, input: UpdateExportTemplateInput): Promise<ExportTemplateSnapshot> {
    await this.requireWrite(user, requestId, 'update', id);
    validateExportColumns(input.columns);
    const requestHash = hashPayload({ id, ...input });
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, user);
      const replay = await claimIdempotency<ExportTemplateSnapshot>(tx, input.idempotencyKey,
        'export_template.update', user.id, 'export_template', String(id), requestHash);
      if (replay) return replay;
      const before = await this.load(tx, id, true);
      if (before.version !== input.expectedVersion) throw staleError(id, input.expectedVersion, before.version);
      if (before.isDefault && !input.isActive) {
        throw new ApiError(409, 'EXPORT_TEMPLATE_DEFAULT_REQUIRED', 'Choose another default before deactivating this template');
      }
      const templateHash = hashTemplate(input.schemaVersion, input.columns);
      let updated;
      try {
        updated = await tx.query<ExportTemplateRow>(`UPDATE export_templates
          SET name=$2, description=$3, sheet_name=$4, schema_version=$5, template_hash=$6,
              columns_json=$7::jsonb, is_active=$8, version=version+1, updated_by=$9, updated_at=now()
          WHERE export_template_id=$1 AND deleted_at IS NULL AND version=$10
          RETURNING ${TEMPLATE_COLUMNS}`,
        [id, input.name, input.description ?? null, input.sheetName, input.schemaVersion, templateHash,
          JSON.stringify(input.columns), input.isActive, user.id, input.expectedVersion]);
      } catch (error) {
        throw mapConstraintError(error);
      }
      if (!updated.rows[0]) throw staleError(id, input.expectedVersion, before.version);
      const template = mapTemplate(updated.rows[0]);
      await assertSeededDefaults(tx);
      await auditService.record(tx, auditEvent(user, requestId, 'export_template.updated', id,
        before as unknown as Record<string, unknown>, template as unknown as Record<string, unknown>,
        { command: 'update', previousVersion: before.version }));
      await completeIdempotency(tx, input.idempotencyKey, template);
      return template;
    });
  }

  async delete(user: CurrentUser, requestId: string, id: number, input: {
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<void> {
    await this.requireWrite(user, requestId, 'delete', id);
    const requestHash = hashPayload({ id, ...input });
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, user);
      const replay = await claimIdempotency<{ deleted: boolean }>(tx, input.idempotencyKey,
        'export_template.delete', user.id, 'export_template', String(id), requestHash);
      if (replay) return;
      const before = await this.load(tx, id, true);
      if (before.version !== input.expectedVersion) throw staleError(id, input.expectedVersion, before.version);
      if (before.isDefault) throw new ApiError(409, 'EXPORT_TEMPLATE_DEFAULT_REQUIRED', 'Choose another default before deleting this template');
      await tx.query(`UPDATE export_templates
        SET deleted_at=now(), deleted_by=$2, is_active=false, version=version+1, updated_by=$2, updated_at=now()
        WHERE export_template_id=$1 AND deleted_at IS NULL AND version=$3`, [id, user.id, input.expectedVersion]);
      await assertSeededDefaults(tx);
      await auditService.record(tx, auditEvent(user, requestId, 'export_template.deleted', id,
        before as unknown as Record<string, unknown>, {}, { command: 'delete' }));
      await completeIdempotency(tx, input.idempotencyKey, { deleted: true });
    });
  }

  async setDefault(user: CurrentUser, requestId: string, id: number, input: {
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<ExportTemplateSnapshot> {
    await this.requireWrite(user, requestId, 'set_default', id);
    const requestHash = hashPayload({ id, ...input });
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, user);
      const replay = await claimIdempotency<ExportTemplateSnapshot>(tx, input.idempotencyKey,
        'export_template.set_default', user.id, 'export_template', String(id), requestHash);
      if (replay) return replay;
      // Target/source/format are immutable. Read them without a row lock so
      // every concurrent default change acquires locks in one global order:
      // advisory lock first, row locks second.
      const targetMetadata = await this.load(tx, id);
      const lockKey = `${targetMetadata.targetScreen}:${targetMetadata.sourceType}:${targetMetadata.format}`;
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey]);
      const target = await this.load(tx, id, true);
      if (target.version !== input.expectedVersion) throw staleError(id, input.expectedVersion, target.version);
      if (!target.isActive) throw new ApiError(409, 'EXPORT_TEMPLATE_INACTIVE', 'Inactive template cannot be default');
      const currentResult = await tx.query<ExportTemplateRow>(`${SELECT_TEMPLATE}
        WHERE target_screen=$1 AND source_type=$2 AND format=$3 AND is_default=true
          AND is_active=true AND deleted_at IS NULL FOR UPDATE`,
      [target.targetScreen, target.sourceType, target.format]);
      const current = currentResult.rows[0] ? mapTemplate(currentResult.rows[0]) : null;
      if (!current || current.exportTemplateId !== id) {
        await tx.query(`UPDATE export_templates SET is_default=false, version=version+1, updated_by=$4, updated_at=now()
          WHERE target_screen=$1 AND source_type=$2 AND format=$3 AND is_default=true AND deleted_at IS NULL`,
        [target.targetScreen, target.sourceType, target.format, user.id]);
        await tx.query(`UPDATE export_templates SET is_default=true, version=version+1, updated_by=$2, updated_at=now()
          WHERE export_template_id=$1 AND is_active=true AND deleted_at IS NULL`, [id, user.id]);
      }
      await assertSeededDefaults(tx);
      const after = await this.load(tx, id);
      if (!current || current.exportTemplateId !== id) {
        await auditService.record(tx, auditEvent(user, requestId, 'export_template.default_changed', id,
          current ? { defaultTemplateId: current.exportTemplateId } : {},
          { defaultTemplateId: id }, {
            command: 'set_default', targetScreen: target.targetScreen,
            sourceType: target.sourceType, format: target.format,
          }));
      }
      await completeIdempotency(tx, input.idempotencyKey, after);
      return after;
    });
  }

  private async queryList(filters: ExportTemplateListFilters): Promise<ExportTemplateSnapshot[]> {
    const values: unknown[] = [];
    const predicates = ['deleted_at IS NULL'];
    const add = (column: string, value: unknown) => {
      values.push(value);
      predicates.push(`${column}=$${values.length}`);
    };
    if (!filters.includeInactive) predicates.push('is_active=true');
    if (filters.targetScreen) add('target_screen', filters.targetScreen);
    if (filters.sourceType) add('source_type', filters.sourceType);
    if (filters.format) add('format', filters.format);
    const result = await this.database.query<ExportTemplateRow>(`${SELECT_TEMPLATE}
      WHERE ${predicates.join(' AND ')} ORDER BY target_screen, source_type, is_default DESC, name`, values);
    return result.rows.map(mapTemplate);
  }

  private async load(client: DatabaseClient, id: number, forUpdate = false): Promise<ExportTemplateSnapshot> {
    const result = await client.query<ExportTemplateRow>(`${SELECT_TEMPLATE}
      WHERE export_template_id=$1 AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'EXPORT_TEMPLATE_NOT_FOUND', 'Export template not found');
    return mapTemplate(result.rows[0]);
  }

  private assertTargetSource(target: ExportTemplateTarget, source: ExportTemplateSource): void {
    const expected = target === 'bazis_cut_set' ? 'bazis_cut_set_detail' : 'bazis_project_panel';
    if (source !== expected) throw new ApiError(422, 'EXPORT_TEMPLATE_SOURCE_MISMATCH', 'Source does not match target screen');
  }

  private require(user: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(user, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient permissions', { requiredPermissions: [permission] });
    }
  }

  private requireSettingsView(user: CurrentUser): void {
    if (!this.permissions.canUserAny(user, ['settings.view', 'settings.manage'])) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient permissions', {
        requiredPermissions: ['settings.view', 'settings.manage'],
      });
    }
  }

  private async requireWrite(user: CurrentUser, requestId: string, action: string, id?: number): Promise<void> {
    if (this.permissions.canUser(user, 'settings.manage')) return;
    try {
      await auditService.recordDenied(this.database, {
        event: 'export_template.permission_denied', entityType: 'export_template', entityId: id ?? action,
        actorUserId: user.id, actorUsername: user.username, actorRole: user.role,
        requestId, source: AUDIT_SOURCE, reason: 'PERMISSION_DENIED', requiredPermissions: ['settings.manage'],
        metadata: { action },
      });
    } catch {
      // Denied audit is best-effort and must never mask the 403.
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient permissions', { requiredPermissions: ['settings.manage'] });
  }
}

const TEMPLATE_COLUMNS = `export_template_id, code, name, description, target_screen, source_type, format,
  sheet_name, schema_version, template_hash, columns_json, is_active, is_default, version,
  created_by, updated_by, created_at, updated_at`;
const SELECT_TEMPLATE = `SELECT ${TEMPLATE_COLUMNS} FROM export_templates`;
const INSERT_TEMPLATE = `INSERT INTO export_templates
  (name, description, target_screen, source_type, format, sheet_name, schema_version,
   template_hash, columns_json, is_active, is_default, version, created_by, updated_by)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,false,1,$11,$11)`;

function mapTemplate(row: ExportTemplateRow): ExportTemplateSnapshot {
  if (row.schema_version !== EXPORT_TEMPLATE_SCHEMA_VERSION) {
    throw new ApiError(422, 'EXPORT_TEMPLATE_SCHEMA_UNSUPPORTED', `Unsupported template schema version: ${row.schema_version}`);
  }
  const columns = typeof row.columns_json === 'string' ? JSON.parse(row.columns_json) : row.columns_json;
  return {
    exportTemplateId: Number(row.export_template_id), code: row.code, name: row.name,
    description: row.description, targetScreen: row.target_screen, sourceType: row.source_type,
    format: row.format, sheetName: row.sheet_name, schemaVersion: EXPORT_TEMPLATE_SCHEMA_VERSION,
    templateHash: row.template_hash, columns, isActive: row.is_active, isDefault: row.is_default,
    version: row.version, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
    createdBy: nullableNumber(row.created_by), updatedBy: nullableNumber(row.updated_by),
  };
}

function toSummary(template: ExportTemplateSnapshot): ExportTemplateSummary {
  return {
    exportTemplateId: template.exportTemplateId, code: template.code, name: template.name,
    targetScreen: template.targetScreen, sourceType: template.sourceType, format: template.format,
    isDefault: template.isDefault, version: template.version,
  };
}

function nullableNumber(value: string | number | null): number | null { return value == null ? null : Number(value); }
function toIso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function hashPayload(value: unknown): string { return createHash('sha256').update(stableStringify(value)).digest('hex'); }
function hashTemplate(schemaVersion: number, columns: ExportTemplateColumn[]): string {
  return hashPayload({ schemaVersion, columns });
}

async function claimIdempotency<T>(client: DatabaseClient, key: string, command: string, actorUserId: string,
  entityType: string, entityId: string, requestHash: string): Promise<T | null> {
  const inserted = await client.query(`INSERT INTO command_idempotency_keys
    (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
    VALUES ($1,$2,$3,$4,$5,$6,'processing') ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
  [key, command, actorUserId, entityType, entityId, requestHash]);
  if (inserted.rowCount === 1) return null;
  const result = await client.query<{
    request_hash: string;
    response_json: T | string | null;
    status: string;
    command_name: string;
    actor_user_id: string | number | null;
    entity_type: string;
    entity_id: string;
  }>(`SELECT request_hash,response_json,status,command_name,actor_user_id,entity_type,entity_id
        FROM command_idempotency_keys WHERE idempotency_key=$1 FOR UPDATE`, [key]);
  const row = result.rows[0];
  if (!row || row.request_hash !== requestHash || row.command_name !== command
    || String(row.actor_user_id ?? '') !== actorUserId || row.entity_type !== entityType || row.entity_id !== entityId) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused');
  }
  if (row.status === 'completed' && row.response_json) {
    return typeof row.response_json === 'string' ? JSON.parse(row.response_json) as T : row.response_json;
  }
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
}

async function completeIdempotency(client: DatabaseClient, key: string, response: unknown): Promise<void> {
  await client.query(`UPDATE command_idempotency_keys SET status='completed', response_json=$2::jsonb, completed_at=now()
    WHERE idempotency_key=$1`, [key, JSON.stringify(response)]);
}

async function setSessionUser(client: TransactionClient, user: CurrentUser): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
}

async function assertSeededDefaults(client: DatabaseClient): Promise<void> {
  const result = await client.query<{ target_screen: string; default_count: string | number }>(`
    SELECT expected.target_screen, count(template.export_template_id) AS default_count
    FROM (VALUES ('bazis_cut_set','bazis_cut_set_detail','xls_biff8'),
                 ('bazis_project_card','bazis_project_panel','xls_biff8'))
         AS expected(target_screen, source_type, format)
    LEFT JOIN export_templates template
      ON template.target_screen=expected.target_screen AND template.source_type=expected.source_type
     AND template.format=expected.format AND template.is_active=true AND template.is_default=true
     AND template.deleted_at IS NULL
    GROUP BY expected.target_screen`);
  if (result.rows.some((row) => Number(row.default_count) !== 1)) {
    throw new ApiError(409, 'EXPORT_TEMPLATE_DEFAULT_REQUIRED', 'Every supported export source must have exactly one active default');
  }
}

function auditEvent(user: CurrentUser, requestId: string, event: string, id: number,
  before: Record<string, unknown>, after: Record<string, unknown>, metadata: Record<string, unknown>) {
  return {
    event, entityType: 'export_template', entityId: id, actorUserId: user.id,
    actorUsername: user.username, actorRole: user.role, requestId, source: AUDIT_SOURCE,
    before, after, diff: { changed: true }, metadata,
    relatedEntities: [{ entityType: 'export_template', entityId: id }],
  };
}

function permissionForTarget(target: ExportTemplateTarget): PermissionName {
  return target === 'bazis_cut_set' ? 'cut.view' : 'bazis.view';
}

function staleError(id: number, expected: number, actual: number): ApiError {
  return new ApiError(409, 'EXPORT_TEMPLATE_VERSION_CONFLICT', 'Export template version is stale',
    { exportTemplateId: id, expectedVersion: expected, actualVersion: actual });
}

function mapConstraintError(error: unknown): ApiError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === '23505') return new ApiError(409, 'EXPORT_TEMPLATE_NAME_CONFLICT', 'Export template name already exists');
  if (code === '23514') return new ApiError(422, 'VALIDATION_ERROR', 'Export template violates database constraints');
  throw error;
}

function sampleDetail(target: ExportTemplateTarget): BazisExportDetail {
  return {
    cutEnabled: true, materialType: 'Площадной', materialName: 'ЛДСП Белый', materialArticle: 'W-001',
    thicknessMm: 16, position: '.A-01', partName: 'Боковина', finishedLengthMm: 720,
    finishedWidthMm: 500, cutLengthMm: 724, cutWidthMm: 504, quantity: 2, orientation: 'Вертикальная',
    groove: '', l1Name: 'Кромка', l1Designation: 'ABS-1', l1ThicknessMm: 1,
    l2Name: '', l2Designation: '', l2ThicknessMm: 0, w1Name: 'Кромка', w1Designation: 'ABS-1',
    w1ThicknessMm: 1, w2Name: '', w2Designation: '', w2ThicknessMm: 0, priority: 1,
    comment: 'Пример', customProperty: '', glue: '', milling: 'Фасад', route: 'ЧПУ', film: 'Матовая',
    sourceBazisProjectName: target === 'bazis_project_card' ? 'BP-100' : 'BP-200',
    sourceBazisOrderNo: 'BZ-42', sourceBazisProductName: 'Шкаф', sourceBathCutNumber: '123-4',
    sourceOrderName: 'ERP-100', sourceOrderFullNumber: 'ERP-100/1', sourceProjectCode: 'PR-10',
    sourceOrderDetailId: 1, sourceOrderId: 2, sourceProjectId: 3, sourceBazisProjectId: 4,
    sourceBazisRevisionId: 5, sourceBazisNodeId: 6,
    ...(target === 'bazis_project_card' ? { xlsOrder: 'BP-100' } : {}),
  };
}
