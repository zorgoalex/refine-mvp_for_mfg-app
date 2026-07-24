import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import { DatabaseService } from '../../../database/database.service';
import { actorId } from '../application/labels.service';
import { buildLabelRows, hashLabelRows, type LabelRow, type LabelRowCutMapSnapshot } from '../application/label-row-builder';
import { renderLabelsZip, renderSvgPages, type LabelCutMapAssets } from '../application/label-renderer';
import type {
  CreateLabelOcrTemplateCommand,
  CreateLabelQrTemplateCommand,
  CreateLabelTemplateCommand,
  DeleteLabelOcrTemplateCommand,
  DeleteLabelQrTemplateCommand,
  DeleteLabelTemplateCommand,
  DetailFieldColumnDto,
  ExportOrderLabelsQuery,
  ExportDetailLabelsQuery,
  GenerateOrderLabelsCommand,
  GenerateDetailLabelsCommand,
  GetOrderLabelDataQuery,
  GetLabelTemplateQuery,
  LabelExportFormat,
  LabelOcrTemplateDto,
  LabelQrTemplateDto,
  LabelTemplateDto,
  LabelTemplateElementDto,
  LabelTemplateElementInput,
  LabelsPermissionDeniedInput,
  LabelsPort,
  DetailLabelsPreviewDto,
  LatestOrderLabelsPreviewDto,
  ListLabelOcrTemplatesQuery,
  ListLabelQrTemplatesQuery,
  ListLabelTemplatesQuery,
  ListOrderLabelCutMapOptionsQuery,
  OrderLabelCutMapOptionsDto,
  LabelCutMapSelectionInput,
  OrderLabelDataDetailDto,
  OrderLabelDataDto,
  OrderLabelGenerationDto,
  OrderLabelsPreviewDto,
  PreviewDetailLabelsCommand,
  PreviewOrderLabelsCommand,
  ScanCandidateRow,
  ScanSearchInput,
  UpdateLabelOcrTemplateCommand,
  UpdateLabelQrTemplateCommand,
  UpdateOrderLabelDataCommand,
  UpdateLabelTemplateCommand,
} from '../application/labels.types';
import { assertRenderableTemplateShape, LABEL_RENDERER_CAPABILITIES } from '../application/label-template-advanced';
import type { OcrTemplateForMatch, OcrTemplateRule } from '../application/scan/ocr-template-matcher';
import {
  LabelCustomFieldSchemaStaleError,
  LabelOcrTemplateNotFoundError,
  LabelOcrTemplateStaleVersionError,
  LabelQrTemplateNotFoundError,
  LabelQrTemplateStaleVersionError,
  LabelTemplateNotFoundError,
  LabelTemplateStaleVersionError,
  OrderLabelDataNotFoundError,
  OrderLabelDataStaleVersionError,
  OrderLabelDetailNotFoundError,
} from '../errors/labels.errors';

interface TemplateRow extends QueryResultRow {
  label_template_id: string | number;
  name: string;
  description: string | null;
  version: string | number;
  is_active: boolean;
  canvas_width_mm: string | number;
  canvas_height_mm: string | number;
  dpi: string | number;
  default_export_formats: LabelExportFormat[];
  custom_field_schema: Record<string, unknown>;
  field_catalog_snapshot: LabelTemplateDto['fieldCatalogSnapshot'];
}

interface ElementRow extends QueryResultRow {
  label_template_element_id: string | number;
  element_key: string;
  kind: 'text' | 'line' | 'rect' | 'qr' | 'cut_map';
  source_field: string | null;
  static_text: string | null;
  x_mm: string | number;
  y_mm: string | number;
  width_mm: string | number;
  height_mm: string | number;
  rotation_deg: string | number;
  z_index: string | number;
  style_json: Record<string, unknown>;
  condition_json: Record<string, unknown>;
}

interface OrderLabelDetailRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  detail_number: string | null;
  detail_name: string | null;
  height: string | number | null;
  width: string | number | null;
  quantity: string | number | null;
  material_name: string | null;
  note: string | null;
  basis_project: string | null;
  basis_data: string | null;
  detail_fields: Record<string, unknown> | null;
  bazis_fields: Record<string, unknown> | null;
  custom_fields: Record<string, unknown> | null;
  custom_field_schema_snapshot: Record<string, unknown> | null;
  version: string | number | null;
}

interface OrderFieldsRow extends QueryResultRow {
  order_fields: Record<string, unknown> | null;
}

interface GenerationRow extends QueryResultRow {
  order_label_generation_id: string | number;
  order_id: string | number | null;
  label_template_id: string | number;
  template_version: string | number;
  label_count: string | number;
  generated_at: Date | string;
  template_snapshot: LabelTemplateDto;
  rows_snapshot: LabelRow[];
  export_formats: LabelExportFormat[];
}

interface CutMapOptionRow extends QueryResultRow {
  detail_id: string | number;
  detail_number: string | null;
  detail_name: string | null;
  quantity: string | number;
  cut_result_placement_id: string | number | null;
  instance: string | number | null;
  cut_result_id: string | number | null;
  cut_job_id: string | number | null;
  cut_job_name: string | null;
  result_no: string | number | null;
  result_kind: 'auto' | 'manual' | 'legacy' | null;
  variant: 'auto' | 'manual' | null;
  sheet_index: string | number | null;
  sheet_ordinal: string | number | null;
  created_at: Date | string | null;
  is_current: boolean | null;
  is_archived: boolean | null;
  dimensions_match: boolean | null;
}

interface ResolvedCutMapRow extends QueryResultRow {
  cut_result_placement_id: string | number;
  cut_result_sheet_map_id: string | number;
  cut_result_id: string | number;
  cut_job_id: string | number;
  order_id: string | number;
  order_detail_id: string | number;
  instance: string | number;
  variant: 'auto' | 'manual';
  sheet_index: string | number;
  sheet_ordinal: string | number;
  sheet_width_mm: string | number;
  sheet_height_mm: string | number;
  x_mm: string | number;
  y_mm: string | number;
  width_mm: string | number;
  height_mm: string | number;
  result_no: string | number;
  cut_job_name: string;
  base_svg: string;
  dimensions_match: boolean;
}

const TEMPLATE_COLUMNS = `label_template_id, name, description, version, is_active,
  canvas_width_mm, canvas_height_mm, dpi, default_export_formats, custom_field_schema, field_catalog_snapshot`;

const QR_TEMPLATE_COLUMNS = `label_qr_template_id, name, content_template, error_correction,
  default_size_mm, is_active, version, field_catalog_snapshot`;

interface QrTemplateRow extends QueryResultRow {
  label_qr_template_id: string | number;
  name: string;
  content_template: string;
  error_correction: string;
  default_size_mm: string | number;
  is_active: boolean;
  version: string | number;
  field_catalog_snapshot: LabelQrTemplateDto['fieldCatalogSnapshot'];
}

function mapQrTemplateRow(row: QrTemplateRow): LabelQrTemplateDto {
  return {
    labelQrTemplateId: toNumber(row.label_qr_template_id),
    name: row.name,
    contentTemplate: row.content_template,
    errorCorrection: (row.error_correction as 'L' | 'M' | 'Q' | 'H') ?? 'M',
    defaultSizeMm: toNumber(row.default_size_mm),
    isActive: row.is_active,
    version: toNumber(row.version),
    fieldCatalogSnapshot: row.field_catalog_snapshot ?? {},
  };
}

interface QrTemplateStringRow extends QueryResultRow {
  tpl: string | null;
}

interface ScanCandidateQueryRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  order_name: string | null;
  detail_number: string | null;
  width: string | number | null;
  height: string | number | null;
  quantity: string | number | null;
  material_name: string | null;
  production_status_name: string | null;
  snapshot_match: boolean;
  detail_number_match?: boolean;
}

function qrAuditShape(dto: LabelQrTemplateDto): Record<string, unknown> {
  return {
    name: dto.name,
    contentTemplate: dto.contentTemplate,
    errorCorrection: dto.errorCorrection,
    defaultSizeMm: dto.defaultSizeMm,
    isActive: dto.isActive,
  };
}

const OCR_TEMPLATE_COLUMNS = `label_ocr_template_id, name, rules, sample_lines, is_active, version,
  created_at, created_by, updated_at, updated_by`;

interface OcrTemplateRow extends QueryResultRow {
  label_ocr_template_id: string | number;
  name: string;
  rules: OcrTemplateRule[];
  sample_lines: string[];
  is_active: boolean;
  version: string | number;
  created_at: string | Date;
  created_by: string | number | null;
  updated_at: string | Date;
  updated_by: string | number | null;
}

interface OcrTemplateForMatchRow extends QueryResultRow {
  id: string | number;
  name: string;
  rules: OcrTemplateRule[];
}

function mapOcrTemplateRow(row: OcrTemplateRow): LabelOcrTemplateDto {
  return {
    labelOcrTemplateId: toNumber(row.label_ocr_template_id),
    name: row.name,
    rules: row.rules ?? [],
    sampleLines: row.sample_lines ?? [],
    isActive: row.is_active,
    version: toNumber(row.version),
    createdAt: toIsoString(row.created_at),
    createdBy: nullableNumber(row.created_by),
    updatedAt: toIsoString(row.updated_at),
    updatedBy: nullableNumber(row.updated_by),
  };
}

// Includes full rule content (not just fieldCodes) so anchor/sampleText-only
// edits still produce a non-identical diff, matching the qrAuditShape precedent.
function ocrAuditShape(dto: LabelOcrTemplateDto): Record<string, unknown> {
  return {
    name: dto.name,
    isActive: dto.isActive,
    version: dto.version,
    rules: dto.rules,
    fieldCodes: dto.rules.map((rule) => rule.field),
  };
}

export class PgLabelsRepository implements LabelsPort {
  constructor(private readonly database: DatabaseService) {}

  async listDetailFieldColumns(): Promise<DetailFieldColumnDto[]> {
    const result = await this.database.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'order_details_view'
       ORDER BY ordinal_position`,
    );
    return result.rows.map((row) => ({ columnName: row.column_name, dataType: row.data_type }));
  }

  async listTemplates(query: ListLabelTemplatesQuery): Promise<LabelTemplateDto[]> {
    const result = await this.database.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS}
       FROM label_templates
       WHERE deleted_at IS NULL AND ($1::boolean IS TRUE OR is_active = true)
       ORDER BY lower(name), label_template_id`,
      [query.includeInactive ?? false],
    );
    const templates = result.rows.map(mapTemplateRow);
    if (templates.length === 0) {
      return [];
    }
    const elementsByTemplate = await this.loadElementsByTemplateIds(
      this.database,
      templates.map((template) => template.labelTemplateId),
    );
    return templates.map((template) => {
      const hydrated = { ...template, elements: elementsByTemplate.get(template.labelTemplateId) ?? [] };
      assertRenderableTemplateShape(hydrated);
      return hydrated;
    });
  }

  async getTemplateById(query: GetLabelTemplateQuery): Promise<LabelTemplateDto> {
    return this.readTemplate(this.database, query.id, true);
  }

  async createTemplate(command: CreateLabelTemplateCommand): Promise<LabelTemplateDto> {
    return this.database.transaction(async (tx) => {
      const input = command.input;
      const requestHash = hashRequest({ command: 'label_template.create', input });
      const existing = await claimIdempotency<LabelTemplateDto>(
        tx,
        input.idempotencyKey,
        'label_template.create',
        actorId(command.currentUser),
        'label_template',
        'pending',
        requestHash,
      );
      if (existing) {
        return existing;
      }
      const inserted = await tx.query<TemplateRow>(
        `INSERT INTO label_templates
          (name, description, canvas_width_mm, canvas_height_mm, dpi, default_export_formats,
           custom_field_schema, field_catalog_snapshot, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6::text[],$7::jsonb,$8::jsonb,$9,$9)
         RETURNING ${TEMPLATE_COLUMNS}`,
        [
          input.name,
          input.description ?? null,
          input.canvasWidthMm,
          input.canvasHeightMm,
          input.dpi,
          input.defaultExportFormats,
          JSON.stringify(input.customFieldSchema),
          JSON.stringify(command.fieldCatalogSnapshot ?? {}),
          actorId(command.currentUser),
        ],
      );
      const template = mapTemplateRow(inserted.rows[0]);
      const elements = await replaceElements(tx, template.labelTemplateId, input.elements);
      const after = { ...template, elements };
      await auditService.record(tx, {
        event: 'label_template.created',
        entityType: 'label_template',
        entityId: template.labelTemplateId,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: null,
        after: auditShape(after),
        diff: auditShape(after),
        metadata: { idempotencyKey: input.idempotencyKey },
        relatedEntities: [{ entityType: 'label_template', entityId: template.labelTemplateId }],
      });
      await completeIdempotency(tx, input.idempotencyKey, after);
      return after;
    });
  }

  async updateTemplate(command: UpdateLabelTemplateCommand): Promise<LabelTemplateDto> {
    return this.database.transaction(async (tx) => {
      const requestHash = hashRequest({
        command: 'label_template.update',
        id: command.id,
        expectedVersion: command.expectedVersion,
        input: command.input,
      });
      const existing = await claimIdempotency<LabelTemplateDto>(
        tx,
        command.input.idempotencyKey,
        'label_template.update',
        actorId(command.currentUser),
        'label_template',
        String(command.id),
        requestHash,
      );
      if (existing) {
        return existing;
      }
      const before = await this.readTemplate(tx, command.id, true, true);
      if (before.version !== command.expectedVersion) {
        throw new LabelTemplateStaleVersionError(command.expectedVersion, before.version);
      }
      const input = command.input;
      const updated = await tx.query<TemplateRow>(
        `UPDATE label_templates SET
           name=$2, description=$3, canvas_width_mm=$4, canvas_height_mm=$5, dpi=$6,
           default_export_formats=$7::text[], custom_field_schema=$8::jsonb,
           field_catalog_snapshot=$9::jsonb, version=version+1, updated_by=$10, updated_at=now()
         WHERE label_template_id=$1 AND deleted_at IS NULL
         RETURNING ${TEMPLATE_COLUMNS}`,
        [
          command.id,
          input.name,
          input.description ?? null,
          input.canvasWidthMm,
          input.canvasHeightMm,
          input.dpi,
          input.defaultExportFormats,
          JSON.stringify(input.customFieldSchema),
          JSON.stringify(command.fieldCatalogSnapshot ?? {}),
          actorId(command.currentUser),
        ],
      );
      if (updated.rowCount === 0) {
        throw new LabelTemplateNotFoundError(command.id);
      }
      const template = mapTemplateRow(updated.rows[0]);
      const elements = await replaceElements(tx, template.labelTemplateId, input.elements);
      const after = { ...template, elements };
      await auditService.record(tx, {
        event: 'label_template.updated',
        entityType: 'label_template',
        entityId: command.id,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: auditShape(before),
        after: auditShape(after),
        diff: auditShape(after),
        metadata: { idempotencyKey: input.idempotencyKey },
        relatedEntities: [{ entityType: 'label_template', entityId: command.id }],
      });
      await completeIdempotency(tx, input.idempotencyKey, after);
      return after;
    });
  }

  async deleteTemplate(command: DeleteLabelTemplateCommand): Promise<void> {
    await this.database.transaction(async (tx) => {
      const requestHash = hashRequest({
        command: 'label_template.delete',
        id: command.id,
        expectedVersion: command.expectedVersion,
      });
      const existing = await claimIdempotency<{ deleted: true }>(
        tx,
        command.idempotencyKey,
        'label_template.delete',
        actorId(command.currentUser),
        'label_template',
        String(command.id),
        requestHash,
      );
      if (existing) {
        return;
      }
      const before = await this.readTemplate(tx, command.id, true, true);
      if (before.version !== command.expectedVersion) {
        throw new LabelTemplateStaleVersionError(command.expectedVersion, before.version);
      }
      await tx.query(
        `UPDATE label_templates
         SET is_active=false, version=version+1, updated_by=$2, updated_at=now()
         WHERE label_template_id=$1 AND deleted_at IS NULL`,
        [command.id, actorId(command.currentUser)],
      );
      await auditService.record(tx, {
        event: 'label_template.deleted',
        entityType: 'label_template',
        entityId: command.id,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: auditShape(before),
        after: { isActive: false },
        diff: { isActive: false },
        metadata: { idempotencyKey: command.idempotencyKey },
        relatedEntities: [{ entityType: 'label_template', entityId: command.id }],
      });
      await completeIdempotency(tx, command.idempotencyKey, { deleted: true });
    });
  }

  async listQrTemplates(query: ListLabelQrTemplatesQuery): Promise<LabelQrTemplateDto[]> {
    const result = await this.database.query<QrTemplateRow>(
      `SELECT ${QR_TEMPLATE_COLUMNS} FROM label_qr_templates
       WHERE ($1::boolean IS TRUE OR is_active = true)
       ORDER BY lower(name), label_qr_template_id`,
      [query.includeInactive ?? false],
    );
    return result.rows.map(mapQrTemplateRow);
  }

  async createQrTemplate(command: CreateLabelQrTemplateCommand): Promise<LabelQrTemplateDto> {
    return this.database.transaction(async (tx) => {
      const input = command.input;
      const requestHash = hashRequest({ command: 'label_qr_template.create', input });
      const existing = await claimIdempotency<LabelQrTemplateDto>(
        tx, input.idempotencyKey, 'label_qr_template.create',
        actorId(command.currentUser), 'label_qr_template', 'pending', requestHash,
      );
      if (existing) return existing;
      let inserted;
      try {
        inserted = await tx.query<QrTemplateRow>(
          `INSERT INTO label_qr_templates
            (name, content_template, error_correction, default_size_mm, field_catalog_snapshot, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
           RETURNING ${QR_TEMPLATE_COLUMNS}`,
          [input.name, input.contentTemplate, input.errorCorrection, input.defaultSizeMm,
           JSON.stringify(command.fieldCatalogSnapshot ?? {}),
           actorId(command.currentUser)],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ApiError(409, 'LABEL_QR_TEMPLATE_NAME_TAKEN', 'QR template name already exists', { field: 'name' });
        }
        throw error;
      }
      const dto = mapQrTemplateRow(inserted.rows[0]);
      await auditService.record(tx, {
        event: 'label_qr_template.created',
        entityType: 'label_qr_template',
        entityId: dto.labelQrTemplateId,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: null,
        after: qrAuditShape(dto),
        diff: qrAuditShape(dto),
        metadata: { idempotencyKey: input.idempotencyKey },
        relatedEntities: [{ entityType: 'label_qr_template', entityId: dto.labelQrTemplateId }],
      });
      await completeIdempotency(tx, input.idempotencyKey, dto);
      return dto;
    });
  }

  async updateQrTemplate(command: UpdateLabelQrTemplateCommand): Promise<LabelQrTemplateDto> {
    return this.database.transaction(async (tx) => {
      const requestHash = hashRequest({
        command: 'label_qr_template.update',
        id: command.id,
        expectedVersion: command.expectedVersion,
        input: command.input,
      });
      const existing = await claimIdempotency<LabelQrTemplateDto>(
        tx,
        command.input.idempotencyKey,
        'label_qr_template.update',
        actorId(command.currentUser),
        'label_qr_template',
        String(command.id),
        requestHash,
      );
      if (existing) {
        return existing;
      }
      const before = await this.readQrTemplate(tx, command.id, true);
      if (before.version !== command.expectedVersion) {
        throw new LabelQrTemplateStaleVersionError(command.expectedVersion, before.version);
      }
      const input = command.input;
      let updated;
      try {
        updated = await tx.query<QrTemplateRow>(
          `UPDATE label_qr_templates SET
             name=$2, content_template=$3, error_correction=$4, default_size_mm=$5,
             field_catalog_snapshot=$6::jsonb, version=version+1, updated_by=$7, updated_at=now()
           WHERE label_qr_template_id=$1
           RETURNING ${QR_TEMPLATE_COLUMNS}`,
          [
            command.id,
            input.name,
            input.contentTemplate,
            input.errorCorrection,
            input.defaultSizeMm,
            JSON.stringify(command.fieldCatalogSnapshot ?? {}),
            actorId(command.currentUser),
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ApiError(409, 'LABEL_QR_TEMPLATE_NAME_TAKEN', 'QR template name already exists', { field: 'name' });
        }
        throw error;
      }
      if (updated.rowCount === 0) {
        throw new LabelQrTemplateNotFoundError(command.id);
      }
      const dto = mapQrTemplateRow(updated.rows[0]);
      await auditService.record(tx, {
        event: 'label_qr_template.updated',
        entityType: 'label_qr_template',
        entityId: command.id,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: qrAuditShape(before),
        after: qrAuditShape(dto),
        diff: qrAuditShape(dto),
        metadata: { idempotencyKey: input.idempotencyKey },
        relatedEntities: [{ entityType: 'label_qr_template', entityId: command.id }],
      });
      await completeIdempotency(tx, input.idempotencyKey, dto);
      return dto;
    });
  }

  async deleteQrTemplate(command: DeleteLabelQrTemplateCommand): Promise<void> {
    await this.database.transaction(async (tx) => {
      const requestHash = hashRequest({
        command: 'label_qr_template.delete',
        id: command.id,
        expectedVersion: command.expectedVersion,
      });
      const existing = await claimIdempotency<{ deleted: true }>(
        tx,
        command.idempotencyKey,
        'label_qr_template.delete',
        actorId(command.currentUser),
        'label_qr_template',
        String(command.id),
        requestHash,
      );
      if (existing) {
        return;
      }
      const before = await this.readQrTemplate(tx, command.id, true);
      if (before.version !== command.expectedVersion) {
        throw new LabelQrTemplateStaleVersionError(command.expectedVersion, before.version);
      }
      await tx.query(
        `UPDATE label_qr_templates
         SET is_active=false, version=version+1, updated_by=$2, updated_at=now()
         WHERE label_qr_template_id=$1`,
        [command.id, actorId(command.currentUser)],
      );
      await auditService.record(tx, {
        event: 'label_qr_template.deleted',
        entityType: 'label_qr_template',
        entityId: command.id,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: qrAuditShape(before),
        after: { isActive: false },
        diff: { isActive: false },
        metadata: { idempotencyKey: command.idempotencyKey },
        relatedEntities: [{ entityType: 'label_qr_template', entityId: command.id }],
      });
      await completeIdempotency(tx, command.idempotencyKey, { deleted: true });
    });
  }

  async listOcrTemplates(query: ListLabelOcrTemplatesQuery): Promise<LabelOcrTemplateDto[]> {
    const result = await this.database.query<OcrTemplateRow>(
      `SELECT ${OCR_TEMPLATE_COLUMNS} FROM label_ocr_templates
       WHERE ($1::boolean IS TRUE OR is_active = true)
       ORDER BY lower(name), label_ocr_template_id`,
      [query.includeInactive ?? false],
    );
    return result.rows.map(mapOcrTemplateRow);
  }

  async createOcrTemplate(command: CreateLabelOcrTemplateCommand): Promise<LabelOcrTemplateDto> {
    return this.database.transaction(async (tx) => {
      const input = command.input;
      const requestHash = hashRequest({ command: 'label_ocr_template.create', input });
      const existing = await claimIdempotency<LabelOcrTemplateDto>(
        tx, input.idempotencyKey, 'label_ocr_template.create',
        actorId(command.currentUser), 'label_ocr_template', 'pending', requestHash,
      );
      if (existing) return existing;
      let inserted;
      try {
        inserted = await tx.query<OcrTemplateRow>(
          `INSERT INTO label_ocr_templates
            (name, rules, sample_lines, is_active, created_by, updated_by)
           VALUES ($1,$2::jsonb,$3::jsonb,$4,$5,$5)
           RETURNING ${OCR_TEMPLATE_COLUMNS}`,
          [
            input.name,
            JSON.stringify(input.rules),
            JSON.stringify(input.sampleLines),
            input.isActive,
            actorId(command.currentUser),
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ApiError(409, 'LABEL_OCR_TEMPLATE_NAME_TAKEN', 'OCR template name already exists', { field: 'name' });
        }
        throw error;
      }
      const dto = mapOcrTemplateRow(inserted.rows[0]);
      await auditService.record(tx, {
        event: 'label_ocr_template.created',
        entityType: 'label_ocr_template',
        entityId: dto.labelOcrTemplateId,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: null,
        after: ocrAuditShape(dto),
        diff: ocrAuditShape(dto),
        metadata: { idempotencyKey: input.idempotencyKey },
        relatedEntities: [{ entityType: 'label_ocr_template', entityId: dto.labelOcrTemplateId }],
      });
      await completeIdempotency(tx, input.idempotencyKey, dto);
      return dto;
    });
  }

  async updateOcrTemplate(command: UpdateLabelOcrTemplateCommand): Promise<LabelOcrTemplateDto> {
    return this.database.transaction(async (tx) => {
      const requestHash = hashRequest({
        command: 'label_ocr_template.update',
        id: command.id,
        expectedVersion: command.expectedVersion,
        input: command.input,
      });
      const existing = await claimIdempotency<LabelOcrTemplateDto>(
        tx,
        command.input.idempotencyKey,
        'label_ocr_template.update',
        actorId(command.currentUser),
        'label_ocr_template',
        String(command.id),
        requestHash,
      );
      if (existing) {
        return existing;
      }
      const before = await this.readOcrTemplate(tx, command.id, true);
      if (before.version !== command.expectedVersion) {
        throw new LabelOcrTemplateStaleVersionError(command.expectedVersion, before.version);
      }
      const input = command.input;
      let updated;
      try {
        updated = await tx.query<OcrTemplateRow>(
          `UPDATE label_ocr_templates SET
             name=$2, rules=$3::jsonb, sample_lines=$4::jsonb, is_active=$5,
             version=version+1, updated_by=$6, updated_at=now()
           WHERE label_ocr_template_id=$1
           RETURNING ${OCR_TEMPLATE_COLUMNS}`,
          [
            command.id,
            input.name,
            JSON.stringify(input.rules),
            JSON.stringify(input.sampleLines),
            input.isActive,
            actorId(command.currentUser),
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ApiError(409, 'LABEL_OCR_TEMPLATE_NAME_TAKEN', 'OCR template name already exists', { field: 'name' });
        }
        throw error;
      }
      if (updated.rowCount === 0) {
        throw new LabelOcrTemplateNotFoundError(command.id);
      }
      const dto = mapOcrTemplateRow(updated.rows[0]);
      await auditService.record(tx, {
        event: 'label_ocr_template.updated',
        entityType: 'label_ocr_template',
        entityId: command.id,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: ocrAuditShape(before),
        after: ocrAuditShape(dto),
        diff: ocrAuditShape(dto),
        metadata: { idempotencyKey: input.idempotencyKey },
        relatedEntities: [{ entityType: 'label_ocr_template', entityId: command.id }],
      });
      await completeIdempotency(tx, input.idempotencyKey, dto);
      return dto;
    });
  }

  async deleteOcrTemplate(command: DeleteLabelOcrTemplateCommand): Promise<void> {
    await this.database.transaction(async (tx) => {
      const requestHash = hashRequest({
        command: 'label_ocr_template.delete',
        id: command.id,
        expectedVersion: command.expectedVersion,
      });
      const existing = await claimIdempotency<{ deleted: true }>(
        tx,
        command.idempotencyKey,
        'label_ocr_template.delete',
        actorId(command.currentUser),
        'label_ocr_template',
        String(command.id),
        requestHash,
      );
      if (existing) {
        return;
      }
      const before = await this.readOcrTemplate(tx, command.id, true);
      if (before.version !== command.expectedVersion) {
        throw new LabelOcrTemplateStaleVersionError(command.expectedVersion, before.version);
      }
      await tx.query(
        `UPDATE label_ocr_templates
         SET is_active=false, version=version+1, updated_by=$2, updated_at=now()
         WHERE label_ocr_template_id=$1`,
        [command.id, actorId(command.currentUser)],
      );
      await auditService.record(tx, {
        event: 'label_ocr_template.deleted',
        entityType: 'label_ocr_template',
        entityId: command.id,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: ocrAuditShape(before),
        after: { isActive: false },
        diff: { isActive: false },
        metadata: { idempotencyKey: command.idempotencyKey },
        relatedEntities: [{ entityType: 'label_ocr_template', entityId: command.id }],
      });
      await completeIdempotency(tx, command.idempotencyKey, { deleted: true });
    });
  }

  async listActiveOcrTemplatesForMatch(): Promise<OcrTemplateForMatch[]> {
    const result = await this.database.query<OcrTemplateForMatchRow>(
      `SELECT label_ocr_template_id AS id, name, rules
         FROM label_ocr_templates
        WHERE is_active
        ORDER BY lower(name), label_ocr_template_id`,
    );
    return result.rows.map((row) => ({
      id: toNumber(row.id),
      name: row.name,
      rules: (row.rules ?? []) as OcrTemplateRule[],
    }));
  }

  async getOrderLabelData(query: GetOrderLabelDataQuery): Promise<OrderLabelDataDto> {
    const template = await this.readTemplate(this.database, query.templateId, true);
    await assertOrderExists(this.database, query.orderId);
    const details = await readOrderLabelDetails(this.database, query.orderId, query.templateId, template.customFieldSchema);
    return {
      orderId: query.orderId,
      templateId: query.templateId,
      templateVersion: template.version,
      customFieldSchema: template.customFieldSchema,
      details,
    };
  }

  async updateOrderLabelData(command: UpdateOrderLabelDataCommand): Promise<OrderLabelDataDto> {
    return this.database.transaction(async (tx) => {
      const requestHash = hashRequest({
        command: 'order_label_data.update',
        orderId: command.orderId,
        input: command.input,
      });
      const existing = await claimIdempotency<OrderLabelDataDto>(
        tx,
        command.input.idempotencyKey,
        'order_label_data.update',
        actorId(command.currentUser),
        'order',
        String(command.orderId),
        requestHash,
      );
      if (existing) {
        return existing;
      }
      const template = await this.readTemplate(tx, command.input.templateId, true, true);
      await assertOrderExists(tx, command.orderId);
      const requestedDetailIds = command.input.rows.map((row) => row.detailId);
      await assertDetailsBelongToOrder(tx, command.orderId, requestedDetailIds);
      const currentSchema = template.customFieldSchema;

      for (const row of command.input.rows) {
        const existing = await tx.query<OrderLabelDetailRow>(
          `SELECT bazis_fields, custom_fields, custom_field_schema_snapshot, version
           FROM order_label_detail_data
           WHERE order_id=$1 AND detail_id=$2 AND label_template_id=$3
           FOR UPDATE`,
          [command.orderId, row.detailId, command.input.templateId],
        );
        const before = existing.rows[0] ?? null;
        const beforeVersion = before ? toNumber(before.version ?? 0) : null;
        if (beforeVersion != null && row.version == null) {
          throw new OrderLabelDataStaleVersionError(row.detailId, null, beforeVersion);
        }
        if (row.version != null && beforeVersion !== row.version) {
          throw new OrderLabelDataStaleVersionError(row.detailId, row.version, beforeVersion);
        }

        const staleIds = staleCustomFieldIds(before?.custom_field_schema_snapshot ?? {}, currentSchema);
        const clear = new Set(row.clearStaleFieldIds ?? []);
        const touchedStale = Object.keys(row.customFields ?? {}).filter((fieldId) => staleIds.includes(fieldId) && !clear.has(fieldId));
        if (touchedStale.length > 0) {
          throw new LabelCustomFieldSchemaStaleError(row.detailId, touchedStale);
        }

        validateCurrentCustomFields(row.detailId, row.customFields ?? {}, currentSchema);

        const nextBazis = { ...(before?.bazis_fields ?? {}), ...(row.bazisFields ?? {}) };
        const nextCustom = { ...(before?.custom_fields ?? {}), ...(row.customFields ?? {}) };
        for (const fieldId of clear) {
          delete nextCustom[fieldId];
        }

        await tx.query(
          `INSERT INTO order_label_detail_data
             (order_id, detail_id, label_template_id, bazis_fields, custom_fields,
              custom_field_schema_snapshot, created_by, edited_by)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$7)
           ON CONFLICT (order_id, detail_id, label_template_id)
           DO UPDATE SET
             bazis_fields=EXCLUDED.bazis_fields,
             custom_fields=EXCLUDED.custom_fields,
             custom_field_schema_snapshot=EXCLUDED.custom_field_schema_snapshot,
             version=order_label_detail_data.version+1,
             edited_by=EXCLUDED.edited_by,
             updated_at=now()`,
          [
            command.orderId,
            row.detailId,
            command.input.templateId,
            JSON.stringify(nextBazis),
            JSON.stringify(nextCustom),
            JSON.stringify(currentSchema),
            actorId(command.currentUser),
          ],
        );
      }

      await auditService.record(tx, {
        event: 'order_label_data.updated',
        entityType: 'order',
        entityId: command.orderId,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        relatedOrderId: command.orderId,
        before: {},
        after: { templateId: command.input.templateId, detailIds: requestedDetailIds },
        diff: { templateId: command.input.templateId, detailIds: requestedDetailIds },
        metadata: { idempotencyKey: command.input.idempotencyKey },
        relatedEntities: requestedDetailIds.map((detailId) => ({ entityType: 'order_detail', entityId: detailId })),
      });

      const details = await readOrderLabelDetails(tx, command.orderId, command.input.templateId, currentSchema);
      const response = {
        orderId: command.orderId,
        templateId: command.input.templateId,
        templateVersion: template.version,
        customFieldSchema: currentSchema,
        details,
      };
      await completeIdempotency(tx, command.input.idempotencyKey, response);
      return response;
    });
  }

  async listOrderCutMapOptions(query: ListOrderLabelCutMapOptionsQuery): Promise<OrderLabelCutMapOptionsDto> {
    await assertOrderExists(this.database, query.orderId);
    const result = await this.database.query<CutMapOptionRow>(
      `SELECT od.detail_id, od.detail_number, od.detail_name, od.quantity,
              maps.cut_result_placement_id, maps.instance, maps.cut_result_id,
              maps.cut_job_id, maps.variant, maps.sheet_index, maps.sheet_ordinal,
              r.result_no, r.result_kind, r.created_at,
              COALESCE(r.snapshot_job ->> 'name', 'Раскрой ' || maps.cut_job_id::text) AS cut_job_name,
              (j.current_cut_result_id = r.cut_result_id) AS is_current,
              (j.status = 'archived') AS is_archived,
              CASE WHEN maps.cut_result_placement_id IS NULL THEN NULL ELSE
                EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(r.snapshot_job -> 'items') AS snapshot_item(item_json)
                  WHERE (snapshot_item.item_json ->> 'orderDetailId')::BIGINT = od.detail_id
                    AND od.width IS NOT NULL AND od.height IS NOT NULL
                    AND abs((snapshot_item.item_json #>> '{detail,width}')::NUMERIC - od.width) <= 0.01
                    AND abs((snapshot_item.item_json #>> '{detail,height}')::NUMERIC - od.height) <= 0.01
                )
              END AS dimensions_match
       FROM order_details_view od
       LEFT JOIN (
         SELECT p.cut_result_placement_id, p.order_detail_id, p.instance,
                p.cut_result_id, p.cut_job_id, p.variant, p.sheet_index,
                s.sheet_ordinal, projection.snapshot_digest
         FROM cut_result_placement p
         JOIN cut_result_sheet_map s
           ON s.cut_result_sheet_map_id = p.cut_result_sheet_map_id
          AND s.is_effective = true
         JOIN cut_result_label_map_projection projection
           ON projection.cut_result_id = p.cut_result_id
       ) maps ON maps.order_detail_id = od.detail_id
       LEFT JOIN cut_result r
         ON r.cut_result_id = maps.cut_result_id
        AND r.snapshot_digest = maps.snapshot_digest
       LEFT JOIN cut_job j ON j.cut_job_id = maps.cut_job_id
       WHERE od.order_id = $1
       ORDER BY od.detail_id,
                (j.status <> 'archived') DESC NULLS LAST,
                (j.current_cut_result_id = r.cut_result_id) DESC NULLS LAST,
                r.created_at DESC NULLS LAST,
                r.cut_result_id DESC NULLS LAST,
                maps.instance`,
      [query.orderId],
    );

    const details = new Map<number, OrderLabelCutMapOptionsDto['details'][number]>();
    for (const row of result.rows) {
      const detailId = toNumber(row.detail_id);
      const detail = details.get(detailId) ?? {
        detailId,
        detailNumber: row.detail_number,
        detailName: row.detail_name,
        quantity: Math.max(0, Math.trunc(toNumber(row.quantity))),
        options: [],
      };
      if (
        row.cut_result_placement_id !== null
        && row.cut_result_id !== null
        && row.cut_job_id !== null
        && row.result_no !== null
        && row.result_kind !== null
        && row.variant !== null
        && row.sheet_index !== null
        && row.sheet_ordinal !== null
        && row.instance !== null
        && row.created_at !== null
      ) {
        detail.options.push({
          cutResultPlacementId: toNumber(row.cut_result_placement_id),
          detailId,
          instance: toNumber(row.instance),
          cutResultId: toNumber(row.cut_result_id),
          cutJobId: toNumber(row.cut_job_id),
          cutNumber: `${toNumber(row.cut_job_id)}-${toNumber(row.result_no)}`,
          cutJobName: row.cut_job_name ?? `Раскрой ${toNumber(row.cut_job_id)}`,
          resultNo: toNumber(row.result_no),
          resultKind: row.result_kind,
          variant: row.variant,
          sheetIndex: toNumber(row.sheet_index),
          sheetNumber: toNumber(row.sheet_ordinal),
          createdAt: toIsoString(row.created_at),
          isCurrent: row.is_current === true,
          isArchived: row.is_archived === true,
          dimensionsMatch: row.dimensions_match === true,
        });
      }
      details.set(detailId, detail);
    }
    return { orderId: query.orderId, details: [...details.values()] };
  }

  async previewOrderLabels(command: PreviewOrderLabelsCommand): Promise<OrderLabelsPreviewDto> {
    const template = await this.readTemplate(this.database, command.input.templateId, true);
    assertTemplateVersion(template.version, command.input.templateVersion);
    await assertOrderExists(this.database, command.orderId);
    const detailIds = command.input.detailFilters?.detailIds ?? [];
    const useBasisFields = command.input.useBasisFields ?? true;
    await assertDetailsBelongToOrder(this.database, command.orderId, detailIds);
    const orderFields = await readOrderFields(this.database, command.orderId);
    const orderName = readOrderNameFromFields(orderFields);
    const details = filterDetails(
      await readOrderLabelDetails(this.database, command.orderId, template.labelTemplateId, template.customFieldSchema),
      detailIds,
    );
    const resolved = await resolveLabelCutMaps(
      this.database,
      template,
      buildLabelRows({ orderName, orderFields, template, details, useBasisFields }),
      command.input.cutMapSelections,
      command.orderId,
    );
    const rows = resolved.rows;
    const rowHash = hashLabelRows(rows);
    const svgPages = renderSvgPages(template, rows, resolved.assets).pages;
    return {
      orderId: command.orderId,
      templateId: template.labelTemplateId,
      templateVersion: template.version,
      labelCount: rows.length,
      rows,
      svgPages,
      previewToken: encodePreviewToken({
        orderId: command.orderId,
        templateId: template.labelTemplateId,
        templateVersion: template.version,
        detailIds,
        useBasisFields,
        rowHash,
      }),
    };
  }

  async generateOrderLabels(command: GenerateOrderLabelsCommand): Promise<OrderLabelGenerationDto> {
    return this.database.transaction(async (tx) => {
      const detailIds = command.input.detailFilters?.detailIds ?? [];
      const useBasisFields = command.input.useBasisFields ?? true;
      const token = decodePreviewToken(command.input.previewToken);
      if (
        token.orderId !== command.orderId
        || token.templateId !== command.input.templateId
        || token.templateVersion !== command.input.templateVersion
        || JSON.stringify(token.detailIds ?? []) !== JSON.stringify(detailIds)
        || (token.useBasisFields ?? true) !== useBasisFields
      ) {
        throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
      }
      const requestHash = hashRequest({
        orderId: command.orderId,
        templateId: command.input.templateId,
        templateVersion: command.input.templateVersion,
        detailIds,
        useBasisFields,
        rowHash: token.rowHash,
        exportFormats: command.input.exportFormats,
        ...(command.input.cutMapSelections !== undefined
          ? { cutMapSelections: canonicalCutMapSelections(command.input.cutMapSelections) }
          : {}),
      });
      const existing = await claimIdempotency<OrderLabelGenerationDto>(
        tx,
        command.input.idempotencyKey,
        'order_labels.generate',
        actorId(command.currentUser),
        'order',
        String(command.orderId),
        requestHash,
      );
      if (existing) return existing;

      const template = await this.readTemplate(tx, command.input.templateId, true, true);
      assertTemplateVersion(template.version, command.input.templateVersion);
      await assertOrderExists(tx, command.orderId);
      await assertDetailsBelongToOrder(tx, command.orderId, detailIds);
      const orderFields = await readOrderFields(tx, command.orderId);
      const orderName = readOrderNameFromFields(orderFields);
      const details = filterDetails(
        await readOrderLabelDetails(tx, command.orderId, template.labelTemplateId, template.customFieldSchema),
        detailIds,
      );
      const resolved = await resolveLabelCutMaps(
        tx,
        template,
        buildLabelRows({ orderName, orderFields, template, details, useBasisFields }),
        command.input.cutMapSelections,
        command.orderId,
      );
      const rows = resolved.rows;
      const rowHash = hashLabelRows(rows);
      if (
        token.rowHash !== rowHash
      ) {
        throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
      }

      const inserted = await tx.query<GenerationRow>(
        `INSERT INTO order_label_generations
          (order_id, label_template_id, template_version, idempotency_key, request_hash, preview_token_hash,
           detail_filters, template_snapshot, rows_snapshot, label_count, export_formats, export_artifacts,
           generated_by, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::text[],'{}'::jsonb,$12,$13)
         RETURNING order_label_generation_id, order_id, label_template_id, template_version, label_count, generated_at,
                   template_snapshot, rows_snapshot, export_formats`,
        [
          command.orderId,
          template.labelTemplateId,
          template.version,
          command.input.idempotencyKey,
          requestHash,
          sha256(command.input.previewToken),
          JSON.stringify({ detailIds, useBasisFields }),
          JSON.stringify(template),
          JSON.stringify(rows),
          rows.length,
          command.input.exportFormats,
          actorId(command.currentUser),
          command.requestId,
        ],
      );
      const generation = mapGenerationRow(inserted.rows[0]);
      await insertGenerationCutPlacements(tx, generation.generationId, rows);
      const cutResultIds = [...new Set(rows.flatMap((row) => row.cutMap ? [row.cutMap.cutResultId] : []))];
      const cutJobIds = [...new Set(rows.flatMap((row) => row.cutMap ? [row.cutMap.cutJobId] : []))];
      await auditService.record(tx, {
        event: 'order_labels.generated',
        entityType: 'order_label_generation',
        entityId: generation.generationId,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        relatedOrderId: command.orderId,
        before: null,
        after: { ...generation, exportFormats: command.input.exportFormats, cutResultIds },
        diff: { labelCount: generation.labelCount },
        metadata: { idempotencyKey: command.input.idempotencyKey },
        relatedEntities: [
          { entityType: 'order_label_generation', entityId: generation.generationId },
          ...details.map((detail) => ({ entityType: 'order_detail', entityId: detail.detailId })),
          ...cutResultIds.map((cutResultId) => ({ entityType: 'cut_result', entityId: cutResultId })),
          ...cutJobIds.map((cutJobId) => ({ entityType: 'cut_job', entityId: cutJobId })),
        ],
      });
      await tx.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('order_labels.generated','order',$1,$2::jsonb,$3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          command.orderId,
          JSON.stringify({ ...generation, templateId: template.labelTemplateId, cutResultIds, cutJobIds }),
          `${command.input.idempotencyKey}:order_labels.generated`,
        ],
      );
      await completeIdempotency(tx, command.input.idempotencyKey, generation);
      return generation;
    });
  }

  async previewDetailLabels(command: PreviewDetailLabelsCommand): Promise<DetailLabelsPreviewDto> {
    const template = await this.readTemplate(this.database, command.input.templateId, true);
    assertTemplateVersion(template.version, command.input.templateVersion);
    assertCutMapOrderScope(template);
    const detailIds = command.input.detailIds;
    const useBasisFields = command.input.useBasisFields ?? true;
    const details = await readDetailLabelDetails(
      this.database,
      detailIds,
      template.labelTemplateId,
      template.customFieldSchema,
    );
    const rows = buildLabelRows({ orderName: null, template, details, useBasisFields });
    const rowHash = hashLabelRows(rows);
    const svgPages = renderSvgPages(template, rows.slice(0, 1)).pages;
    return {
      generationScope: 'details',
      templateId: template.labelTemplateId,
      templateVersion: template.version,
      labelCount: rows.length,
      rows,
      svgPages,
      previewToken: encodePreviewToken({
        generationScope: 'details',
        templateId: template.labelTemplateId,
        templateVersion: template.version,
        detailIds,
        useBasisFields,
        rowHash,
      }),
    };
  }

  async generateDetailLabels(command: GenerateDetailLabelsCommand): Promise<OrderLabelGenerationDto> {
    return this.database.transaction(async (tx) => {
      const detailIds = command.input.detailIds;
      const useBasisFields = command.input.useBasisFields ?? true;
      const token = decodePreviewToken(command.input.previewToken);
      if (
        token.generationScope !== 'details'
        || token.templateId !== command.input.templateId
        || token.templateVersion !== command.input.templateVersion
        || JSON.stringify(token.detailIds ?? []) !== JSON.stringify(detailIds)
        || (token.useBasisFields ?? true) !== useBasisFields
      ) {
        throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
      }
      const requestHash = hashRequest({
        generationScope: 'details',
        templateId: command.input.templateId,
        templateVersion: command.input.templateVersion,
        detailIds,
        useBasisFields,
        rowHash: token.rowHash,
        exportFormats: command.input.exportFormats,
      });
      const existing = await claimIdempotency<OrderLabelGenerationDto>(
        tx,
        command.input.idempotencyKey,
        'detail_labels.generate',
        actorId(command.currentUser),
        'label_generation',
        'details',
        requestHash,
      );
      if (existing) return existing;

      const template = await this.readTemplate(tx, command.input.templateId, true, true);
      assertTemplateVersion(template.version, command.input.templateVersion);
      assertCutMapOrderScope(template);
      const details = await readDetailLabelDetails(tx, detailIds, template.labelTemplateId, template.customFieldSchema);
      const rows = buildLabelRows({ orderName: null, template, details, useBasisFields });
      const rowHash = hashLabelRows(rows);
      if (
        token.rowHash !== rowHash
      ) {
        throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
      }

      const inserted = await tx.query<GenerationRow>(
        `INSERT INTO order_label_generations
          (order_id, label_template_id, template_version, idempotency_key, request_hash, preview_token_hash,
           detail_filters, generation_scope, scope_json, template_snapshot, rows_snapshot, label_count,
           export_formats, export_artifacts, generated_by, request_id)
         VALUES (NULL,$1,$2,$3,$4,$5,$6::jsonb,'details',$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::text[],'{}'::jsonb,$12,$13)
         RETURNING order_label_generation_id, order_id, label_template_id, template_version, label_count, generated_at,
                   template_snapshot, rows_snapshot, export_formats`,
        [
          template.labelTemplateId,
          template.version,
          command.input.idempotencyKey,
          requestHash,
          sha256(command.input.previewToken),
          JSON.stringify({ detailIds, useBasisFields }),
          JSON.stringify({ detailIds, orderIds: [...new Set(details.map((detail) => detail.orderId))] }),
          JSON.stringify(template),
          JSON.stringify(rows),
          rows.length,
          command.input.exportFormats,
          actorId(command.currentUser),
          command.requestId,
        ],
      );
      const generation = mapGenerationRow(inserted.rows[0]);
      await auditService.record(tx, {
        event: 'detail_labels.generated',
        entityType: 'order_label_generation',
        entityId: generation.generationId,
        actorUserId: actorId(command.currentUser),
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend.labels',
        before: null,
        after: { ...generation, exportFormats: command.input.exportFormats, detailIds },
        diff: { labelCount: generation.labelCount },
        metadata: { idempotencyKey: command.input.idempotencyKey, generationScope: 'details' },
        relatedEntities: [
          { entityType: 'order_label_generation', entityId: generation.generationId },
          ...details.map((detail) => ({ entityType: 'order_detail', entityId: detail.detailId })),
        ],
      });
      await completeIdempotency(tx, command.input.idempotencyKey, generation);
      return generation;
    });
  }

  async exportOrderLabels(query: ExportOrderLabelsQuery): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const generation = query.generationId
      ? await readGeneration(this.database, query.orderId, query.generationId)
      : await readLatestGeneration(this.database, query.orderId);
    const body = await renderLabelsZip({
      generationId: generation.generationId,
      orderId: generation.orderId ?? query.orderId,
      template: generation.template,
      rows: generation.rows,
      formats: generation.exportFormats,
      generatedAt: generation.generatedAt,
      cutMapAssets: await loadCutMapAssets(this.database, generation.rows),
    });
    const orderName = readOrderNameFromFields(await readOrderFields(this.database, query.orderId));
    return {
      filename: buildOrderLabelsArchiveFilename(orderName, generation.generationId),
      contentType: 'application/zip',
      body,
    };
  }

  async exportDetailLabels(query: ExportDetailLabelsQuery): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const generation = await readDetailGeneration(this.database, query.generationId);
    const body = await renderLabelsZip({
      generationId: generation.generationId,
      orderId: generation.orderId ?? 0,
      template: generation.template,
      rows: generation.rows,
      formats: generation.exportFormats,
      generatedAt: generation.generatedAt,
      cutMapAssets: await loadCutMapAssets(this.database, generation.rows),
    });
    return {
      filename: `labels-generation-${generation.generationId}.zip`,
      contentType: 'application/zip',
      body,
    };
  }

  async getLatestOrderLabelsPreview(query: ExportOrderLabelsQuery): Promise<LatestOrderLabelsPreviewDto> {
    await assertOrderExists(this.database, query.orderId);
    const generation = await readLatestGeneration(this.database, query.orderId);
    const svgPages = renderSvgPages(
      generation.template,
      generation.rows,
      await loadCutMapAssets(this.database, generation.rows),
    ).pages;
    return {
      generationId: generation.generationId,
      orderId: generation.orderId ?? query.orderId,
      templateId: generation.template.labelTemplateId,
      templateVersion: generation.template.version,
      labelCount: generation.rows.length,
      generatedAt: generation.generatedAt,
      svgPages,
    };
  }

  async recordPermissionDenied(input: LabelsPermissionDeniedInput): Promise<void> {
    const entityType = input.targetEntityType ?? 'label_template';
    const event =
      entityType === 'order'
        ? 'order_labels.permission_denied'
        : entityType === 'label_qr_template'
          ? 'label_qr_template.permission_denied'
          : entityType === 'label_ocr_template'
            ? 'label_ocr_template.permission_denied'
            : 'label_template.permission_denied';
    await auditService.recordDenied(this.database, {
      event,
      entityType,
      entityId: input.targetId ?? 'catalog',
      actorUserId: actorId(input.currentUser),
      actorUsername: input.currentUser.username,
      actorRole: input.currentUser.role,
      requestId: input.requestId,
      source: 'backend.labels',
      reason: 'permission_denied',
      requiredPermissions: input.requiredPermissions,
    });
  }

  private async readTemplate(
    client: DatabaseClient,
    id: number,
    includeInactive: boolean,
    lock = false,
  ): Promise<LabelTemplateDto> {
    const result = await client.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS}
       FROM label_templates
       WHERE label_template_id = $1 AND deleted_at IS NULL AND ($2::boolean IS TRUE OR is_active = true)
       ${lock ? 'FOR UPDATE' : ''}`,
      [id, includeInactive],
    );
    if (result.rowCount === 0) {
      throw new LabelTemplateNotFoundError(id);
    }
    const template = mapTemplateRow(result.rows[0]);
    const elements = await loadElements(client, template.labelTemplateId);
    const hydrated = { ...template, elements };
    // Validate immediately after the locked/read snapshot and before a preview
    // token, idempotency claim, generation row, audit entry, or outbox event can
    // be produced. This also closes the old-preview-token mixed-deploy path.
    assertRenderableTemplateShape(hydrated);
    return hydrated;
  }

  private async readQrTemplate(
    client: DatabaseClient,
    id: number,
    lock = false,
  ): Promise<LabelQrTemplateDto> {
    const result = await client.query<QrTemplateRow>(
      `SELECT ${QR_TEMPLATE_COLUMNS}
       FROM label_qr_templates
       WHERE label_qr_template_id = $1
       ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (result.rowCount === 0) {
      throw new LabelQrTemplateNotFoundError(id);
    }
    return mapQrTemplateRow(result.rows[0]);
  }

  private async readOcrTemplate(
    client: DatabaseClient,
    id: number,
    lock = false,
  ): Promise<LabelOcrTemplateDto> {
    const result = await client.query<OcrTemplateRow>(
      `SELECT ${OCR_TEMPLATE_COLUMNS}
       FROM label_ocr_templates
       WHERE label_ocr_template_id = $1
       ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (result.rowCount === 0) {
      throw new LabelOcrTemplateNotFoundError(id);
    }
    return mapOcrTemplateRow(result.rows[0]);
  }

  private async loadElementsByTemplateIds(
    client: DatabaseClient,
    templateIds: number[],
  ): Promise<Map<number, LabelTemplateElementDto[]>> {
    const result = await client.query<ElementRow>(
      `SELECT label_template_id, label_template_element_id, element_key, kind, source_field, static_text,
              x_mm, y_mm, width_mm, height_mm, rotation_deg, z_index, style_json, condition_json
       FROM label_template_elements
       WHERE label_template_id = ANY($1::bigint[])
       ORDER BY label_template_id, z_index, label_template_element_id`,
      [templateIds],
    );
    const map = new Map<number, LabelTemplateElementDto[]>();
    for (const row of result.rows) {
      const templateId = toNumber(row.label_template_id);
      const list = map.get(templateId) ?? [];
      list.push(mapElementRow(row));
      map.set(templateId, list);
    }
    return map;
  }

  async listActiveQrTemplateStrings(): Promise<string[]> {
    const result = await this.database.query<QrTemplateStringRow>(
      `SELECT DISTINCT content_template AS tpl
         FROM label_qr_templates
        WHERE is_active
        UNION
       SELECT DISTINCT lte.style_json->>'qrTemplate' AS tpl
         FROM label_template_elements lte
         JOIN label_templates lt ON lt.label_template_id = lte.label_template_id
        WHERE lte.kind = 'qr'
          AND lt.deleted_at IS NULL
          AND lt.is_active = true
          AND COALESCE(lte.style_json->>'qrTemplate', '') <> ''`,
    );
    return result.rows.map((row) => row.tpl).filter((tpl): tpl is string => Boolean(tpl));
  }

  async findScanCandidates(input: ScanSearchInput): Promise<ScanCandidateRow[]> {
    // narrow-then-verify. Read-surface = order_details_view + явный guard
    // orders.delete_flag=false (паттерн ~:1261). Снапшот печати — containment
    // bazis_fields @>. ВАЖНО (перф): exact-поля и снапшот-источник — ДВА
    // отдельных запроса, слитых в TS. Единый OR с LATERAL заставлял планировщик
    // сек-сканить все order_details (~1.3s на 58k строк); раздельно оба пути
    // индексные: exact — по orders/details, снапшот — от маленькой
    // order_label_detail_data (только напечатанные бирки).
    const hasBazis = input.bazisFields != null && Object.keys(input.bazisFields).length > 0;
    const bazisJson = hasBazis ? JSON.stringify(input.bazisFields) : null;

    const selectList = (withSnapshotMatch: boolean, detailNumberExpr: string | null) => `
           od.detail_id, od.order_id, o.order_name, od.detail_number,
           od.width, od.height, od.quantity, od.material_name,
           ps.production_status_name,
           ${withSnapshotMatch ? `(ld_match.detail_id IS NOT NULL)` : `TRUE`} AS snapshot_match
           ${detailNumberExpr ? `, (od.detail_number = ${detailNumberExpr}) AS detail_number_match` : ''}`;

    const queries: Array<Promise<{ rows: ScanCandidateQueryRow[] }>> = [];

    // Запрос A: точные поля (индексный доступ); снапшот здесь — только ТЕГ
    // (LATERAL по уже отобранным строкам — дёшево).
    {
      const params: unknown[] = [];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const conditions: string[] = [];
      if (input.detailId != null) conditions.push(`od.detail_id = ${p(input.detailId)}`);
      if (input.orderId != null) conditions.push(`od.order_id = ${p(input.orderId)}`);
      if (input.orderName) conditions.push(`lower(o.order_name) = lower(${p(input.orderName)})`);
      if (conditions.length > 0) {
        const detailNumberParam = input.detailNumber != null ? p(input.detailNumber) : null;
        const bazisParam = bazisJson ? p(bazisJson) : null;
        queries.push(
          this.database.query<ScanCandidateQueryRow>(
            `SELECT ${selectList(bazisParam != null, detailNumberParam)}
               FROM order_details_view od
               JOIN orders o ON o.order_id = od.order_id AND o.delete_flag = false
               LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
               ${bazisParam ? `LEFT JOIN LATERAL (
                 SELECT ld.detail_id FROM order_label_detail_data ld
                  WHERE ld.detail_id = od.detail_id
                    AND ld.bazis_fields @> ${bazisParam}::jsonb
                  LIMIT 1
               ) ld_match ON TRUE` : ''}
              WHERE (${conditions.join(' OR ')})
              LIMIT 200`,
            params,
          ),
        );
      }
    }

    // Запрос B: снапшот как ИСТОЧНИК (заказ переименовали после печати) —
    // драйвим от order_label_detail_data, а не от 58k деталей.
    if (bazisJson) {
      const params: unknown[] = [bazisJson];
      const detailNumberParam = input.detailNumber != null ? (params.push(input.detailNumber), `$${params.length}`) : null;
      queries.push(
        this.database.query<ScanCandidateQueryRow>(
          `SELECT DISTINCT ON (od.detail_id) ${selectList(false, detailNumberParam)}
             FROM order_label_detail_data ld
             JOIN order_details_view od ON od.detail_id = ld.detail_id
             JOIN orders o ON o.order_id = od.order_id AND o.delete_flag = false
             LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
            WHERE ld.bazis_fields @> $1::jsonb
            ORDER BY od.detail_id
            LIMIT 200`,
          params,
        ),
      );
    }

    if (queries.length === 0) return []; // защита от полного скана

    const results = await Promise.all(queries);
    const byDetail = new Map<number, ScanCandidateRow>();
    for (const result of results) {
      for (const row of result.rows) {
        const detailId = toNumber(row.detail_id);
        const matched: string[] = [];
        if (input.detailId != null && detailId === input.detailId) matched.push('detail_id');
        if (input.orderId != null && toNumber(row.order_id) === input.orderId) matched.push('order_id');
        if (input.orderName && (row.order_name ?? '').toLowerCase() === input.orderName.toLowerCase()) matched.push('order_name');
        if (input.detailNumber != null && row.detail_number_match === true) matched.push('detail_number');
        if (row.snapshot_match === true) matched.push('snapshot');
        const existing = byDetail.get(detailId);
        if (existing) {
          // слияние тегов из обоих источников
          existing.matchedFields = [...new Set([...existing.matchedFields, ...matched])];
          continue;
        }
        byDetail.set(detailId, {
          detailId,
          orderId: toNumber(row.order_id),
          orderName: row.order_name ?? '',
          detailNumber: row.detail_number == null ? null : Number(row.detail_number),
          width: nullableNumber(row.width),
          height: nullableNumber(row.height),
          quantity: nullableNumber(row.quantity),
          materialName: row.material_name,
          productionStatusName: row.production_status_name,
          matchedFields: matched,
        });
      }
    }
    return [...byDetail.values()].slice(0, 200);
  }
}

export async function resolveLabelCutMaps(
  client: DatabaseClient,
  template: LabelTemplateDto,
  rows: LabelRow[],
  selections: LabelCutMapSelectionInput[] | undefined,
  orderId?: number,
): Promise<{ rows: LabelRow[]; assets: LabelCutMapAssets }> {
  const usesCutMap = template.elements.some((element) => element.kind === 'cut_map');
  if (!usesCutMap) {
    if ((selections?.length ?? 0) > 0) {
      throw new ApiError(422, 'LABEL_CUT_MAP_NOT_IN_TEMPLATE', 'Шаблон не содержит миниатюру раскроя');
    }
    return { rows, assets: new Map() };
  }
  if (rows.length === 0) return { rows, assets: new Map() };

  const selectionByCopy = new Map<string, LabelCutMapSelectionInput>();
  const placementIds = new Set<number>();
  const rowKeys = new Set(rows.map((row) => `${row.detailId}:${row.copyIndex}`));
  for (const selection of selections ?? []) {
    const key = `${selection.detailId}:${selection.copyIndex}`;
    if (!rowKeys.has(key)) {
      throw new ApiError(422, 'LABEL_CUT_MAP_SELECTION_MISMATCH', 'Раскрой не соответствует бирке', { key });
    }
    if (selectionByCopy.has(key) || placementIds.has(selection.cutResultPlacementId)) {
      throw new ApiError(422, 'LABEL_CUT_MAP_SELECTION_DUPLICATE', 'Один экземпляр раскроя нельзя назначить двум биркам', { key });
    }
    selectionByCopy.set(key, selection);
    placementIds.add(selection.cutResultPlacementId);
  }

  const unselectedRows = rows.filter((row) => !selectionByCopy.has(`${row.detailId}:${row.copyIndex}`));
  if (unselectedRows.length > 0) {
    const omittedPlacements = await client.query<{
      order_id: string | number;
      order_detail_id: string | number;
      instance: string | number;
      dimensions_match: boolean;
    }>(
      `SELECT p.order_id, p.order_detail_id, p.instance,
              EXISTS (
                SELECT 1
                FROM jsonb_array_elements(r.snapshot_job -> 'items') AS snapshot_item(item_json)
                WHERE (snapshot_item.item_json ->> 'orderDetailId')::BIGINT = od.detail_id
                  AND od.width IS NOT NULL AND od.height IS NOT NULL
                  AND abs((snapshot_item.item_json #>> '{detail,width}')::NUMERIC - od.width) <= 0.01
                  AND abs((snapshot_item.item_json #>> '{detail,height}')::NUMERIC - od.height) <= 0.01
              ) AND p.instance <= od.quantity AS dimensions_match
       FROM cut_result_placement p
       JOIN cut_result_sheet_map s
         ON s.cut_result_sheet_map_id = p.cut_result_sheet_map_id
        AND s.is_effective = true
       JOIN cut_result_label_map_projection projection
         ON projection.cut_result_id = p.cut_result_id
       JOIN cut_result r
         ON r.cut_result_id = p.cut_result_id
        AND r.snapshot_digest = projection.snapshot_digest
       JOIN order_details od
         ON od.detail_id = p.order_detail_id
        AND od.order_id = p.order_id
        AND od.delete_flag = false
       JOIN unnest($1::bigint[], $2::bigint[], $3::integer[])
         AS requested(order_id, detail_id, instance)
         ON requested.order_id = p.order_id
        AND requested.detail_id = p.order_detail_id
        AND requested.instance = p.instance`,
      [
        unselectedRows.map((row) => row.orderId),
        unselectedRows.map((row) => row.detailId),
        unselectedRows.map((row) => row.copyIndex),
      ],
    );
    const omittedPlacementState = new Map<string, boolean>();
    for (const placement of omittedPlacements.rows) {
      const key = `${toNumber(placement.order_id)}:${toNumber(placement.order_detail_id)}:${toNumber(placement.instance)}`;
      omittedPlacementState.set(key, omittedPlacementState.get(key) === true || placement.dimensions_match);
    }
    for (const row of unselectedRows) {
      const state = omittedPlacementState.get(`${row.orderId}:${row.detailId}:${row.copyIndex}`);
      if (state === true) {
        throw new ApiError(422, 'LABEL_CUT_MAP_SELECTION_REQUIRED', 'Выберите раскрой для бирки', {
          detailId: row.detailId,
          copyIndex: row.copyIndex,
        });
      }
      if (state === false) {
        throw new ApiError(409, 'LABEL_CUT_MAP_DETAIL_CHANGED', 'Размер или количество детали изменились после раскроя', {
          detailId: row.detailId,
        });
      }
    }
  }
  if (placementIds.size === 0) return { rows, assets: new Map() };

  const result = await client.query<ResolvedCutMapRow>(
    `SELECT p.cut_result_placement_id, p.cut_result_sheet_map_id,
            p.cut_result_id, p.cut_job_id, p.order_id, p.order_detail_id,
            p.instance, p.variant, p.sheet_index, p.x_mm, p.y_mm,
            p.width_mm, p.height_mm, s.sheet_ordinal,
            s.sheet_width_mm, s.sheet_height_mm, s.base_svg,
            r.result_no,
            COALESCE(r.snapshot_job ->> 'name', 'Раскрой ' || p.cut_job_id::text) AS cut_job_name,
            COALESCE(
              EXISTS (
                SELECT 1
                FROM jsonb_array_elements(r.snapshot_job -> 'items') AS snapshot_item(item_json)
                WHERE (snapshot_item.item_json ->> 'orderDetailId')::BIGINT = od.detail_id
                  AND od.width IS NOT NULL AND od.height IS NOT NULL
                  AND abs((snapshot_item.item_json #>> '{detail,width}')::NUMERIC - od.width) <= 0.01
                  AND abs((snapshot_item.item_json #>> '{detail,height}')::NUMERIC - od.height) <= 0.01
              )
              AND p.instance <= od.quantity,
              false
            ) AS dimensions_match
     FROM cut_result_placement p
     JOIN cut_result_sheet_map s
       ON s.cut_result_sheet_map_id = p.cut_result_sheet_map_id
      AND s.is_effective = true
     JOIN cut_result_label_map_projection projection
       ON projection.cut_result_id = p.cut_result_id
     JOIN cut_result r
       ON r.cut_result_id = p.cut_result_id
      AND r.snapshot_digest = projection.snapshot_digest
     JOIN order_details od
       ON od.detail_id = p.order_detail_id
      AND od.delete_flag = false
     WHERE p.cut_result_placement_id = ANY($1::bigint[])
       AND ($2::bigint IS NULL OR p.order_id = $2)`,
    [[...placementIds], orderId ?? null],
  );
  const placementById = new Map(result.rows.map((row) => [toNumber(row.cut_result_placement_id), row]));
  if (placementById.size !== placementIds.size) {
    throw new ApiError(409, 'LABEL_CUT_MAP_SELECTION_STALE', 'Выбранный раскрой больше недоступен');
  }

  const assets = new Map<number, string>();
  const resolvedRows = rows.map((row): LabelRow => {
    const selection = selectionByCopy.get(`${row.detailId}:${row.copyIndex}`);
    if (!selection) return row;
    const placement = placementById.get(selection.cutResultPlacementId);
    if (
      !placement
      || toNumber(placement.order_detail_id) !== row.detailId
      || toNumber(placement.order_id) !== row.orderId
      || toNumber(placement.instance) !== row.copyIndex
    ) {
      throw new ApiError(409, 'LABEL_CUT_MAP_SELECTION_MISMATCH', 'Раскрой не соответствует экземпляру детали', {
        detailId: row.detailId,
        copyIndex: row.copyIndex,
      });
    }
    if (!placement.dimensions_match) {
      throw new ApiError(409, 'LABEL_CUT_MAP_DETAIL_CHANGED', 'Размер или количество детали изменились после раскроя', {
        detailId: row.detailId,
      });
    }
    const cutResultSheetMapId = toNumber(placement.cut_result_sheet_map_id);
    const cutMap: LabelRowCutMapSnapshot = {
      cutResultPlacementId: toNumber(placement.cut_result_placement_id),
      cutResultSheetMapId,
      cutResultId: toNumber(placement.cut_result_id),
      cutJobId: toNumber(placement.cut_job_id),
      cutNumber: `${toNumber(placement.cut_job_id)}-${toNumber(placement.result_no)}`,
      cutJobName: placement.cut_job_name,
      variant: placement.variant,
      sheetIndex: toNumber(placement.sheet_index),
      sheetNumber: toNumber(placement.sheet_ordinal),
      sheetWidthMm: toNumber(placement.sheet_width_mm),
      sheetHeightMm: toNumber(placement.sheet_height_mm),
      xMm: toNumber(placement.x_mm),
      yMm: toNumber(placement.y_mm),
      widthMm: toNumber(placement.width_mm),
      heightMm: toNumber(placement.height_mm),
    };
    assets.set(cutResultSheetMapId, placement.base_svg);
    return {
      ...row,
      cutMap,
      values: {
        ...row.values,
        'cut.number': cutMap.cutNumber,
        'cut.job_name': cutMap.cutJobName,
        'cut.sheet_number': cutMap.sheetNumber,
        'cut.variant': cutMap.variant,
      },
    };
  });
  return { rows: resolvedRows, assets };
}

function assertCutMapOrderScope(template: LabelTemplateDto): void {
  if (template.elements.some((element) => element.kind === 'cut_map')) {
    throw new ApiError(
      422,
      'LABEL_CUT_MAP_ORDER_SCOPE_ONLY',
      'Шаблон с миниатюрой раскроя формируется из карточки заказа',
    );
  }
}

async function insertGenerationCutPlacements(
  client: DatabaseClient,
  generationId: number,
  rows: LabelRow[],
): Promise<void> {
  const mapped = rows.filter((row): row is LabelRow & { cutMap: LabelRowCutMapSnapshot } => row.cutMap !== undefined);
  if (mapped.length === 0) return;
  await client.query(
    `INSERT INTO label_generation_cut_placement
       (order_label_generation_id, row_index, detail_id, copy_index, cut_result_placement_id)
     SELECT $1, values.row_index, values.detail_id, values.copy_index, values.placement_id
     FROM unnest($2::integer[], $3::bigint[], $4::integer[], $5::bigint[])
       AS values(row_index, detail_id, copy_index, placement_id)`,
    [
      generationId,
      mapped.map((row) => row.rowIndex),
      mapped.map((row) => row.detailId),
      mapped.map((row) => row.copyIndex),
      mapped.map((row) => row.cutMap.cutResultPlacementId),
    ],
  );
}

async function loadCutMapAssets(client: DatabaseClient, rows: LabelRow[]): Promise<LabelCutMapAssets> {
  const ids = [...new Set(rows.flatMap((row) => row.cutMap ? [row.cutMap.cutResultSheetMapId] : []))];
  if (ids.length === 0) return new Map();
  const result = await client.query<{ cut_result_sheet_map_id: string | number; base_svg: string }>(
    `SELECT cut_result_sheet_map_id, base_svg
     FROM cut_result_sheet_map
     WHERE cut_result_sheet_map_id = ANY($1::bigint[])`,
    [ids],
  );
  return new Map(result.rows.map((row) => [toNumber(row.cut_result_sheet_map_id), row.base_svg]));
}

interface PreviewTokenPayload {
  generationScope?: 'order' | 'details';
  orderId?: number;
  templateId: number;
  templateVersion: number;
  detailIds: number[];
  useBasisFields?: boolean;
  rowHash: string;
}

function assertTemplateVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new LabelTemplateStaleVersionError(expected, current);
  }
}

async function readOrderFields(client: DatabaseClient, orderId: number): Promise<Record<string, unknown>> {
  const result = await client.query<OrderFieldsRow>(
    `SELECT row_to_json(o)::jsonb AS order_fields
     FROM orders_view o
     WHERE o.order_id=$1`,
    [orderId],
  );
  return result.rows[0]?.order_fields ?? {};
}

function readOrderNameFromFields(orderFields: Record<string, unknown>): string | null {
  const value = orderFields.order_name;
  return value == null ? null : String(value);
}

export function buildOrderLabelsArchiveFilename(orderName: string | null, generationId: number): string {
  const normalizedOrderName = (orderName?.trim() || 'без-названия')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '');
  const safeOrderName = Array.from(normalizedOrderName).slice(0, 120).join('') || 'без-названия';
  return `заказ-${safeOrderName}-бирки-${generationId}.zip`;
}

function filterDetails(details: OrderLabelDataDetailDto[], detailIds: number[]): OrderLabelDataDetailDto[] {
  if (detailIds.length === 0) {
    return details;
  }
  const allow = new Set(detailIds);
  return details.filter((detail) => allow.has(detail.detailId));
}

function encodePreviewToken(payload: PreviewTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePreviewToken(token: string): PreviewTokenPayload {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as PreviewTokenPayload;
    if (!parsed || typeof parsed.rowHash !== 'string') {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashRequest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function canonicalCutMapSelections(selections: LabelCutMapSelectionInput[]): LabelCutMapSelectionInput[] {
  return selections.slice().sort((a, b) => (
    a.detailId - b.detailId
    || a.copyIndex - b.copyIndex
    || a.cutResultPlacementId - b.cutResultPlacementId
  ));
}

async function claimIdempotency<T>(
  client: DatabaseClient,
  idempotencyKey: string,
  commandName: string,
  actorUserId: number | null,
  entityType: string,
  entityId: string,
  requestHash: string,
): Promise<T | null> {
  const inserted = await client.query(
    `INSERT INTO command_idempotency_keys
       (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
     VALUES ($1,$2,$3,$4,$5,$6,'processing')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [idempotencyKey, commandName, actorUserId, entityType, entityId, requestHash],
  );
  if (inserted.rowCount === 1) {
    return null;
  }
  const existing = await client.query<{ request_hash: string; response_json: T | null; status: string }>(
    `SELECT request_hash, response_json, status FROM command_idempotency_keys WHERE idempotency_key=$1 FOR UPDATE`,
    [idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== requestHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request');
  }
  if (row.status === 'completed' && row.response_json) {
    return row.response_json;
  }
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
}

async function completeIdempotency(
  client: DatabaseClient,
  idempotencyKey: string,
  response: unknown,
): Promise<void> {
  await client.query(
    `UPDATE command_idempotency_keys
     SET status='completed', response_json=$2::jsonb, completed_at=now()
     WHERE idempotency_key=$1`,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function readGeneration(
  client: DatabaseClient,
  orderId: number,
  generationId: number,
): Promise<{
  generationId: number;
  orderId: number | null;
  template: LabelTemplateDto;
  rows: LabelRow[];
  exportFormats: LabelExportFormat[];
  generatedAt: string;
}> {
  const result = await client.query<GenerationRow>(
    `SELECT order_label_generation_id, order_id, label_template_id, template_version, label_count, generated_at,
            template_snapshot, rows_snapshot, export_formats
     FROM order_label_generations
     WHERE order_id=$1 AND order_label_generation_id=$2`,
    [orderId, generationId],
  );
  if (result.rowCount === 0) {
    throw new ApiError(404, 'ORDER_LABEL_GENERATION_NOT_FOUND', 'Order label generation not found', { orderId, generationId });
  }
  return mapGenerationSnapshotRow(result.rows[0]);
}

async function readLatestGeneration(client: DatabaseClient, orderId: number): Promise<ReturnType<typeof mapGenerationSnapshotRow>> {
  const result = await client.query<GenerationRow>(
    `SELECT order_label_generation_id, order_id, label_template_id, template_version, label_count, generated_at,
            template_snapshot, rows_snapshot, export_formats
     FROM order_label_generations
     WHERE order_id=$1
     ORDER BY generated_at DESC, order_label_generation_id DESC
     LIMIT 1`,
    [orderId],
  );
  if (result.rowCount === 0) {
    throw new ApiError(404, 'ORDER_LABEL_GENERATION_NOT_FOUND', 'Order label generation not found', { orderId });
  }
  return mapGenerationSnapshotRow(result.rows[0]);
}

function mapGenerationRow(row: GenerationRow): OrderLabelGenerationDto {
  return {
    generationId: toNumber(row.order_label_generation_id),
    orderId: row.order_id == null ? null : toNumber(row.order_id),
    templateId: toNumber(row.label_template_id),
    templateVersion: toNumber(row.template_version),
    labelCount: toNumber(row.label_count),
    generatedAt: new Date(row.generated_at).toISOString(),
  };
}

function mapGenerationSnapshotRow(row: GenerationRow): {
  generationId: number;
  orderId: number | null;
  template: LabelTemplateDto;
  rows: LabelRow[];
  exportFormats: LabelExportFormat[];
  generatedAt: string;
} {
  return {
    generationId: toNumber(row.order_label_generation_id),
    orderId: row.order_id == null ? null : toNumber(row.order_id),
    template: row.template_snapshot,
    rows: row.rows_snapshot,
    exportFormats: row.export_formats,
    generatedAt: new Date(row.generated_at).toISOString(),
  };
}

async function readDetailGeneration(
  client: DatabaseClient,
  generationId: number,
): Promise<{
  generationId: number;
  orderId: number | null;
  template: LabelTemplateDto;
  rows: LabelRow[];
  exportFormats: LabelExportFormat[];
  generatedAt: string;
}> {
  const result = await client.query<GenerationRow>(
    `SELECT order_label_generation_id, order_id, label_template_id, template_version, label_count, generated_at,
            template_snapshot, rows_snapshot, export_formats
     FROM order_label_generations
     WHERE order_label_generation_id=$1 AND generation_scope='details'`,
    [generationId],
  );
  if (result.rowCount === 0) {
    throw new ApiError(404, 'ORDER_LABEL_GENERATION_NOT_FOUND', 'Label generation not found', { generationId });
  }
  return mapGenerationSnapshotRow(result.rows[0]);
}

async function assertOrderExists(client: DatabaseClient, orderId: number): Promise<void> {
  const result = await client.query('SELECT order_id FROM orders WHERE order_id=$1 AND delete_flag=false', [orderId]);
  if (result.rowCount === 0) {
    throw new OrderLabelDataNotFoundError(orderId);
  }
}

async function assertDetailsBelongToOrder(client: DatabaseClient, orderId: number, detailIds: number[]): Promise<void> {
  if (detailIds.length === 0) {
    return;
  }
  const result = await client.query<{ detail_id: string | number }>(
    `SELECT detail_id
     FROM order_details
     WHERE order_id=$1 AND delete_flag=false AND detail_id = ANY($2::bigint[])`,
    [orderId, detailIds],
  );
  const found = new Set(result.rows.map((row) => toNumber(row.detail_id)));
  const missing = detailIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new OrderLabelDetailNotFoundError(orderId, missing);
  }
}

async function readOrderLabelDetails(
  client: DatabaseClient,
  orderId: number,
  templateId: number,
  currentSchema: Record<string, unknown>,
): Promise<OrderLabelDataDetailDto[]> {
  const result = await client.query<OrderLabelDetailRow>(
    `SELECT od.detail_id, od.order_id, od.detail_number, od.detail_name, od.height, od.width, od.quantity,
            od.material_name, od.note, od.basis_project, od.basis_data,
            row_to_json(od)::jsonb AS detail_fields,
            ld.bazis_fields, ld.custom_fields, ld.custom_field_schema_snapshot, ld.version
     FROM order_details_view od
     LEFT JOIN order_label_detail_data ld
       ON ld.order_id=od.order_id AND ld.detail_id=od.detail_id AND ld.label_template_id=$2
     WHERE od.order_id=$1
     ORDER BY od.detail_number, od.detail_id`,
    [orderId, templateId],
  );
  if (result.rowCount === 0) {
    throw new OrderLabelDataNotFoundError(orderId);
  }
  return result.rows.map((row) => mapOrderLabelDetail(row, currentSchema));
}

async function readDetailLabelDetails(
  client: DatabaseClient,
  detailIds: number[],
  templateId: number,
  currentSchema: Record<string, unknown>,
): Promise<OrderLabelDataDetailDto[]> {
  const uniqueDetailIds = [...new Set(detailIds)];
  const result = await client.query<OrderLabelDetailRow>(
    `SELECT od.detail_id, od.order_id, od.detail_number, od.detail_name, od.height, od.width, od.quantity,
            od.material_name, od.note, od.basis_project, od.basis_data,
            row_to_json(od)::jsonb AS detail_fields,
            ld.bazis_fields, ld.custom_fields, ld.custom_field_schema_snapshot, ld.version
     FROM order_details_view od
     LEFT JOIN order_label_detail_data ld
       ON ld.order_id=od.order_id AND ld.detail_id=od.detail_id AND ld.label_template_id=$2
     WHERE od.detail_id = ANY($1::bigint[])
     ORDER BY array_position($1::bigint[], od.detail_id), od.detail_id`,
    [uniqueDetailIds, templateId],
  );
  const byId = new Map<number, OrderLabelDataDetailDto>();
  for (const row of result.rows) {
    byId.set(toNumber(row.detail_id), mapOrderLabelDetail(row, currentSchema));
  }
  const missing = uniqueDetailIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ApiError(422, 'LABEL_DETAIL_INVALID', 'One or more label details were not found', { detailIds: missing });
  }
  const orderFieldsByOrderId = await readOrderFieldsByIds(client, [...new Set(result.rows.map((row) => toNumber(row.order_id)))]);
  const counts = new Map<number, number>();
  for (const detailId of detailIds) {
    counts.set(detailId, (counts.get(detailId) ?? 0) + 1);
  }
  return uniqueDetailIds.map((detailId) => {
    const detail = byId.get(detailId)!;
    return {
      ...detail,
      quantity: counts.get(detailId) ?? 0,
      orderFields: orderFieldsByOrderId.get(detail.orderId) ?? {},
    };
  });
}

async function readOrderFieldsByIds(client: DatabaseClient, orderIds: number[]): Promise<Map<number, Record<string, unknown>>> {
  if (orderIds.length === 0) return new Map();
  const result = await client.query<{ order_id: string | number; order_fields: Record<string, unknown> | null }>(
    `SELECT o.order_id, row_to_json(o)::jsonb AS order_fields
     FROM orders_view o
     WHERE o.order_id = ANY($1::bigint[])`,
    [orderIds],
  );
  return new Map(result.rows.map((row) => [toNumber(row.order_id), row.order_fields ?? {}]));
}

function mapOrderLabelDetail(
  row: OrderLabelDetailRow,
  currentSchema: Record<string, unknown>,
): OrderLabelDataDetailDto {
  const snapshot = row.custom_field_schema_snapshot ?? {};
  return {
    detailId: toNumber(row.detail_id),
    orderId: toNumber(row.order_id),
    detailNumber: row.detail_number,
    detailName: row.detail_name,
    height: nullableNumber(row.height),
    width: nullableNumber(row.width),
    quantity: nullableNumber(row.quantity) ?? 0,
    materialName: row.material_name,
    note: row.note,
    basisProject: row.basis_project,
    basisData: row.basis_data,
    detailFields: row.detail_fields ?? {},
    orderFields: {},
    bazisFields: row.bazis_fields ?? {},
    customFields: row.custom_fields ?? {},
    customFieldSchemaSnapshot: snapshot,
    version: row.version == null ? null : toNumber(row.version),
    staleCustomFieldIds: staleCustomFieldIds(snapshot, currentSchema),
  };
}

function staleCustomFieldIds(
  snapshot: Record<string, unknown>,
  currentSchema: Record<string, unknown>,
): string[] {
  return Object.keys(snapshot).filter((fieldId) => !(fieldId in currentSchema));
}

function validateCurrentCustomFields(
  detailId: number,
  customFields: Record<string, unknown>,
  currentSchema: Record<string, unknown>,
): void {
  const invalid = Object.keys(customFields).filter((fieldId) => !(fieldId in currentSchema));
  if (invalid.length > 0) {
    throw new LabelCustomFieldSchemaStaleError(detailId, invalid);
  }
}

async function replaceElements(
  client: DatabaseClient,
  templateId: number,
  elements: LabelTemplateElementInput[],
): Promise<LabelTemplateElementDto[]> {
  await client.query('DELETE FROM label_template_elements WHERE label_template_id = $1', [templateId]);
  const inserted: LabelTemplateElementDto[] = [];
  for (const element of elements) {
    const result = await client.query<ElementRow>(
      `INSERT INTO label_template_elements
        (label_template_id, element_key, kind, source_field, static_text, x_mm, y_mm, width_mm, height_mm,
         rotation_deg, z_index, style_json, condition_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
       RETURNING label_template_element_id, element_key, kind, source_field, static_text,
         x_mm, y_mm, width_mm, height_mm, rotation_deg, z_index, style_json, condition_json`,
      [
        templateId,
        element.elementKey,
        element.kind,
        element.sourceField ?? null,
        element.staticText ?? null,
        element.xMm,
        element.yMm,
        element.widthMm,
        element.heightMm,
        element.rotationDeg ?? 0,
        element.zIndex ?? 0,
        JSON.stringify(element.style ?? {}),
        JSON.stringify(element.condition ?? {}),
      ],
    );
    inserted.push(mapElementRow(result.rows[0]));
  }
  return inserted;
}

async function loadElements(client: DatabaseClient, templateId: number): Promise<LabelTemplateElementDto[]> {
  const result = await client.query<ElementRow>(
    `SELECT label_template_element_id, element_key, kind, source_field, static_text,
            x_mm, y_mm, width_mm, height_mm, rotation_deg, z_index, style_json, condition_json
     FROM label_template_elements
     WHERE label_template_id = $1
     ORDER BY z_index, label_template_element_id`,
    [templateId],
  );
  return result.rows.map(mapElementRow);
}

function mapTemplateRow(row: TemplateRow): Omit<LabelTemplateDto, 'elements'> {
  return {
    labelTemplateId: toNumber(row.label_template_id),
    name: row.name,
    description: row.description,
    version: toNumber(row.version),
    isActive: row.is_active,
    canvasWidthMm: toNumber(row.canvas_width_mm),
    canvasHeightMm: toNumber(row.canvas_height_mm),
    dpi: toNumber(row.dpi),
    defaultExportFormats: row.default_export_formats,
    customFieldSchema: row.custom_field_schema ?? {},
    fieldCatalogSnapshot: row.field_catalog_snapshot ?? {},
    rendererCapabilities: [...LABEL_RENDERER_CAPABILITIES],
  };
}

function mapElementRow(row: ElementRow): LabelTemplateElementDto {
  return {
    labelTemplateElementId: toNumber(row.label_template_element_id),
    elementKey: row.element_key,
    kind: row.kind,
    sourceField: row.source_field,
    staticText: row.static_text,
    xMm: toNumber(row.x_mm),
    yMm: toNumber(row.y_mm),
    widthMm: toNumber(row.width_mm),
    heightMm: toNumber(row.height_mm),
    rotationDeg: toNumber(row.rotation_deg),
    zIndex: toNumber(row.z_index),
    style: row.style_json ?? {},
    condition: row.condition_json ?? {},
  };
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNumber(value: string | number | null): number | null {
  return value == null ? null : toNumber(value);
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function auditShape(value: LabelTemplateDto): Record<string, unknown> {
  return {
    labelTemplateId: value.labelTemplateId,
    name: value.name,
    version: value.version,
    isActive: value.isActive,
    canvasWidthMm: value.canvasWidthMm,
    canvasHeightMm: value.canvasHeightMm,
    dpi: value.dpi,
    defaultExportFormats: value.defaultExportFormats,
    customFieldSchema: value.customFieldSchema,
    elements: value.elements,
  };
}
