import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import { DatabaseService } from '../../../database/database.service';
import { formatCutNumber } from '../../cut/application/cut-numbering';
import { actorId } from '../application/labels.service';
import {
  buildLabelRows,
  hashLabelRows,
  type CutResultLabelRowCutMapSnapshot,
  type LabelRow,
  type LabelRowCutMapSnapshot,
  type TelegramImageLabelRowCutMapSnapshot,
  type TelegramSvgLabelRowCutMapSnapshot,
} from '../application/label-row-builder';
import {
  renderLabelsZip,
  renderSvgPages,
  type LabelCutMapAsset,
  type LabelCutMapAssets,
} from '../application/label-renderer';
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
  LabelCutMapSource,
  DetailLabelsPreviewDto,
  LatestOrderLabelsPreviewDto,
  ListLabelOcrTemplatesQuery,
  ListLabelQrTemplatesQuery,
  ListLabelTemplatesQuery,
  ListOrderLabelCutMapOptionsQuery,
  OrderLabelCutMapOptionsDto,
  LabelCutMapFallbackImageInput,
  LabelCutMapSelectionInput,
  LabelCutSheetDetailInstanceInput,
  LabelCutSheetScopeInput,
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
import {
  closePreparedTelegramImages,
  normalizeTelegramMediaContentType,
  prepareTelegramImage,
  TELEGRAM_IMAGE_LIMITS,
  validateTelegramImage,
  verifyPreparedTelegramImage,
  type PreparedTelegramImage,
} from '../../cnc-telegram/application/telegram-media-reader';
import { assertRenderableTemplateShape, LABEL_RENDERER_CAPABILITIES } from '../application/label-template-advanced';
import {
  DETAIL_CUT_RESULT_VERSION_REGULAR_FIELD,
  DETAIL_CUT_RESULT_VERSION_VACUUM_FIELD,
} from '../application/bazis-field-catalog';
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

interface CutSheetScopeSelectionRow extends QueryResultRow {
  order_id: string | number;
  order_detail_id: string | number;
  instance: string | number;
  cut_result_placement_id: string | number;
}

interface TelegramSheetImageRow extends QueryResultRow {
  packet_id: string;
  source_version: string | number;
  source_message_id: string | number | null;
  cutting_sequence_no: string | number | null;
  sheet_image_storage_key: string | null;
  sheet_image_content_type: string | null;
  sheet_image_size_bytes: string | number | null;
  sheet_width_mm: string | number | null;
  sheet_height_mm: string | number | null;
}

interface TelegramSheetImageEvidenceRow extends QueryResultRow {
  order_id: string | number;
  detail_id: string | number;
  instance: string | number;
  evidence_quantity: string | number;
  evidence_eligible: boolean;
  dimensions_match: boolean;
}

const DETAIL_CUT_RESULT_VERSION_FIELDS_SQL = `
LEFT JOIN LATERAL (
  WITH candidates AS (
    SELECT cj.cut_job_id,
           COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text) AS cut_job_display_number,
           cr.result_no,
           COALESCE(
             cj.last_calc_params->>'layout_mode',
             cpp.params->>'layout_mode',
             cj.params->>'layout_mode'
           ) = 'vacuum_table' AS is_vacuum
    FROM cut_job_item cji
    JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
    JOIN cut_result cr
      ON cr.cut_result_id = cj.current_cut_result_id
     AND cr.cut_job_id = cj.cut_job_id
    LEFT JOIN cut_result_archive_state archived
      ON archived.cut_job_id = cr.cut_job_id
     AND archived.result_no = cr.result_no
    LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id
    WHERE cji.order_detail_id = od.detail_id
      AND cji.is_active = true
      AND cj.status = 'ready'
      AND cj.last_calc_basis IS NOT NULL
      AND archived.cut_job_id IS NULL
  ),
  ranked AS (
    SELECT *,
           row_number() OVER (
             PARTITION BY (is_vacuum IS TRUE)
             ORDER BY cut_job_id DESC
           ) AS rn
    FROM candidates
  )
  SELECT
    max(cut_job_display_number || '-' || result_no::text) FILTER (WHERE is_vacuum IS NOT TRUE AND rn = 1) AS regular_cut_number,
    max(
      CASE
        WHEN cut_job_display_number LIKE 'В-%' THEN cut_job_display_number
        ELSE 'В-' || cut_job_display_number
      END || '-' || result_no::text
    ) FILTER (WHERE is_vacuum IS TRUE AND rn = 1) AS vacuum_cut_number
  FROM ranked
) cut_version_fields ON true
`;

const CUT_RESULT_SHEET_IS_VACUUM_SQL = `COALESCE(
  (
    SELECT (frozen_group.group_json #>> '{summary,engine_used}') = 'vacuum_table'
    FROM jsonb_array_elements(r.snapshot_job -> 'groups') AS frozen_group(group_json)
    WHERE (frozen_group.group_json ->> 'cutGroupId')::BIGINT = s.cut_group_id
    LIMIT 1
  ),
  COALESCE(
    j.last_calc_params->>'layout_mode',
    cpp.params->>'layout_mode',
    j.params->>'layout_mode'
  ) = 'vacuum_table'
)`;

const DETAIL_FIELDS_JSON_SQL = `(
  row_to_json(od)::jsonb
  || jsonb_build_object(
    '${DETAIL_CUT_RESULT_VERSION_REGULAR_FIELD}', cut_version_fields.regular_cut_number,
    '${DETAIL_CUT_RESULT_VERSION_VACUUM_FIELD}', cut_version_fields.vacuum_cut_number
  )
) AS detail_fields`;

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
  regular_cut_number: string | null;
  vacuum_cut_number: string | null;
  cut_result_placement_id: string | number | null;
  instance: string | number | null;
  cut_result_id: string | number | null;
  cut_job_id: string | number | null;
  source_display_number: string | number | null;
  cut_job_name: string | null;
  result_no: string | number | null;
  result_kind: 'auto' | 'manual' | 'legacy' | null;
  variant: 'auto' | 'manual' | null;
  sheet_index: string | number | null;
  sheet_ordinal: string | number | null;
  created_at: Date | string | null;
  is_current: boolean | null;
  is_archived: boolean | null;
  is_vacuum: boolean | null;
  dimensions_match: boolean | null;
}

interface ResolvedCutMapRow extends QueryResultRow {
  cut_result_placement_id: string | number;
  cut_result_sheet_map_id: string | number;
  cut_result_id: string | number;
  cut_job_id: string | number;
  source_display_number: string | number | null;
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
  is_vacuum: boolean;
  regular_cut_number: string | null;
  vacuum_cut_number: string | null;
}

interface TelegramSvgCandidateRow extends QueryResultRow {
  telegram_label_sheet_map_id: string | number;
  telegram_label_placement_id: string | number;
  packet_id: string;
  source_version: string | number;
  source_message_id: string | number | null;
  cutting_sequence_no: string | number | null;
  layout_digest: string;
  order_id: string | number;
  order_detail_id: string | number;
  instance: string | number;
  sheet_width_mm: string | number;
  sheet_height_mm: string | number;
  base_svg: string;
  x_mm: string | number;
  y_mm: string | number;
  width_mm: string | number;
  height_mm: string | number;
}

interface TelegramImageCandidateRow extends QueryResultRow {
  packet_id: string;
  source_version: string | number;
  source_message_id: string | number | null;
  cutting_sequence_no: string | number | null;
  order_id: string | number;
  order_detail_id: string | number;
  instance: string | number;
  sheet_image_storage_key: string;
  sheet_image_content_type: string | null;
  sheet_image_size_bytes: string | number | null;
  sheet_width_mm: string | number | null;
  sheet_height_mm: string | number | null;
  evidence_quantity: string | number;
  evidence_eligible: boolean;
}

type TelegramImageUnavailableReason = 'request_limit_exceeded' | 'invalid_media' | 'ambiguous_evidence';
type TelegramImageAvailability = { packetId: string; sourceMessageId: number | null };

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

export interface PgLabelsRepositoryOptions {
  telegramMediaDir?: string;
  telegramFallbackEnabled?: boolean;
}

export class PgLabelsRepository implements LabelsPort {
  private readonly telegramMediaDir: string;
  private readonly telegramFallbackEnabled: boolean;

  constructor(private readonly database: DatabaseService, options: PgLabelsRepositoryOptions = {}) {
    this.telegramMediaDir = options.telegramMediaDir ?? process.env.CNC_TELEGRAM_MEDIA_DIR ?? '/data/cnc-telegram-media';
    this.telegramFallbackEnabled = options.telegramFallbackEnabled ?? false;
  }

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
          (name, description, is_active, canvas_width_mm, canvas_height_mm, dpi, default_export_formats,
           custom_field_schema, field_catalog_snapshot, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::jsonb,$9::jsonb,$10,$10)
         RETURNING ${TEMPLATE_COLUMNS}`,
        [
          input.name,
          input.description ?? null,
          input.isActive ?? true,
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
           name=$2, description=$3, is_active=$4, canvas_width_mm=$5, canvas_height_mm=$6, dpi=$7,
           default_export_formats=$8::text[], custom_field_schema=$9::jsonb,
           field_catalog_snapshot=$10::jsonb, version=version+1, updated_by=$11, updated_at=now()
         WHERE label_template_id=$1 AND deleted_at IS NULL
         RETURNING ${TEMPLATE_COLUMNS}`,
        [
          command.id,
          input.name,
          input.description ?? null,
          input.isActive ?? before.isActive,
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
              cut_version_fields.regular_cut_number, cut_version_fields.vacuum_cut_number,
              maps.cut_result_placement_id, maps.instance, maps.cut_result_id,
              maps.cut_job_id, maps.variant, maps.sheet_index, maps.sheet_ordinal,
              r.result_no, r.result_kind, r.created_at,
              COALESCE(r.snapshot_job ->> 'name', 'Раскрой ' || maps.cut_job_id::text) AS cut_job_name,
              j.source_display_number,
              (current_result.result_no = r.result_no) AS is_current,
              (j.status = 'archived' OR archive.archived_at IS NOT NULL) AS is_archived,
              COALESCE(
                j.last_calc_params->>'layout_mode',
                cpp.params->>'layout_mode',
                j.params->>'layout_mode'
              ) = 'vacuum_table' AS is_vacuum,
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
       ${DETAIL_CUT_RESULT_VERSION_FIELDS_SQL}
       LEFT JOIN (
         SELECT p.cut_result_placement_id, p.order_id, p.order_detail_id, p.instance,
                p.cut_result_id, p.cut_job_id, p.variant, p.sheet_index,
                s.sheet_ordinal, projection.snapshot_digest
         FROM cut_result_placement p
         JOIN cut_result_sheet_map s
           ON s.cut_result_sheet_map_id = p.cut_result_sheet_map_id
          AND s.is_effective = true
         JOIN cut_result_label_map_projection projection
           ON projection.cut_result_id = p.cut_result_id
       ) maps
         ON maps.order_detail_id = od.detail_id
        AND maps.order_id = od.order_id
       LEFT JOIN cut_result r
         ON r.cut_result_id = maps.cut_result_id
        AND r.snapshot_digest = maps.snapshot_digest
       LEFT JOIN cut_job j ON j.cut_job_id = maps.cut_job_id
       LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = j.param_profile_id
       LEFT JOIN cut_result current_result
         ON current_result.cut_result_id = j.current_cut_result_id
       LEFT JOIN cut_result_archive_state archive
         ON archive.cut_job_id = r.cut_job_id
        AND archive.result_no = r.result_no
       WHERE od.order_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM cut_result newer
           WHERE newer.cut_job_id = r.cut_job_id
             AND newer.result_no = r.result_no
             AND newer.revision_no > r.revision_no
         )
       ORDER BY od.detail_id,
                (j.status <> 'archived' AND archive.archived_at IS NULL) DESC NULLS LAST,
                (current_result.result_no = r.result_no) DESC NULLS LAST,
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
        cutJobCutNumber: row.regular_cut_number,
        bathCutJobCutNumber: row.vacuum_cut_number,
        options: [],
        telegramSvgFallbackInstances: [],
        telegramImageFallbackInstances: [],
        telegramImageUnavailableInstances: [],
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
          cutNumber: formatCutNumber(toNumber(row.cut_job_id), toNumber(row.result_no), row.is_vacuum === true, row.source_display_number),
          cutJobName: row.cut_job_name ?? `Раскрой ${toNumber(row.cut_job_id)}`,
          resultNo: toNumber(row.result_no),
          resultKind: row.result_kind,
          variant: row.variant,
          sheetIndex: toNumber(row.sheet_index),
          sheetNumber: toNumber(row.sheet_ordinal),
          createdAt: toIsoString(row.created_at),
          isCurrent: row.is_current === true,
          isArchived: row.is_archived === true,
          isVacuum: row.is_vacuum === true,
          dimensionsMatch: row.dimensions_match === true,
        });
      }
      details.set(detailId, detail);
    }
    if (this.telegramFallbackEnabled && query.telegramCutMapFallbackVersion === 'v1') {
      await addTelegramFallbackOptions(this.database, query.orderId, details, this.telegramMediaDir);
    }
    return { orderId: query.orderId, details: [...details.values()] };
  }

  async previewOrderLabels(command: PreviewOrderLabelsCommand): Promise<OrderLabelsPreviewDto> {
    const template = await this.readTemplate(this.database, command.input.templateId, true);
    assertTemplateVersion(template.version, command.input.templateVersion);
    await assertOrderExists(this.database, command.orderId);
    const detailIds = command.input.detailFilters?.detailIds ?? [];
    const useBasisFields = command.input.useBasisFields ?? true;
    const cutMapSource = command.input.cutMapSource;
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
      cutMapSource,
      {
        enabled: this.telegramFallbackEnabled,
        capability: command.input.telegramCutMapFallbackVersion,
        mediaDir: this.telegramMediaDir,
      },
    );
    try {
      const rows = resolved.rows;
      const rowHash = hashLabelRows(rows);
      const svgPages = renderSvgPages(template, rows, resolved.assets).pages;
      assertTelegramSvgPagesLimit(rows, svgPages);
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
          cutMapSource,
          telegramCutMapFallbackVersion: command.input.telegramCutMapFallbackVersion,
          rowHash,
        }),
      };
    } finally {
      await closePreparedTelegramImages(resolved.preparedImages.values());
    }
  }

  async generateOrderLabels(command: GenerateOrderLabelsCommand): Promise<OrderLabelGenerationDto> {
    const detailIds = command.input.detailFilters?.detailIds ?? [];
    const useBasisFields = command.input.useBasisFields ?? true;
    const cutMapSource = command.input.cutMapSource;
    const token = decodePreviewToken(command.input.previewToken);
    if (
      token.orderId !== command.orderId
      || token.templateId !== command.input.templateId
      || token.templateVersion !== command.input.templateVersion
      || JSON.stringify(token.detailIds ?? []) !== JSON.stringify(detailIds)
      || (token.useBasisFields ?? true) !== useBasisFields
      || (token.cutMapSource ?? null) !== (cutMapSource ?? null)
      || (token.telegramCutMapFallbackVersion ?? null) !== (command.input.telegramCutMapFallbackVersion ?? null)
    ) {
      throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
    }
    const requestHash = hashRequest({
      orderId: command.orderId,
      templateId: command.input.templateId,
      templateVersion: command.input.templateVersion,
      detailIds,
      useBasisFields,
      cutMapSource,
      telegramCutMapFallbackVersion: command.input.telegramCutMapFallbackVersion,
      rowHash: token.rowHash,
      exportFormats: command.input.exportFormats,
      ...(command.input.cutMapSelections !== undefined
        ? { cutMapSelections: canonicalCutMapSelections(command.input.cutMapSelections) }
        : {}),
    });
    const shouldPrepareTelegramImages = this.telegramFallbackEnabled
      && command.input.telegramCutMapFallbackVersion === 'v1'
      && command.input.cutMapSource === 'regular';
    if (shouldPrepareTelegramImages) {
      const replay = await readIdempotencyReplay<OrderLabelGenerationDto>(
        this.database,
        command.input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
    }

    const generationPreparedImages = new Map<string, PreparedTelegramImage>();
    if (shouldPrepareTelegramImages) {
      const template = await this.readTemplate(this.database, command.input.templateId, true);
      assertTemplateVersion(template.version, command.input.templateVersion);
      await assertOrderExists(this.database, command.orderId);
      const detailIds = command.input.detailFilters?.detailIds ?? [];
      await assertDetailsBelongToOrder(this.database, command.orderId, detailIds);
      const orderFields = await readOrderFields(this.database, command.orderId);
      const details = filterDetails(
        await readOrderLabelDetails(this.database, command.orderId, template.labelTemplateId, template.customFieldSchema),
        detailIds,
      );
      const preparedResolution = await resolveLabelCutMaps(
        this.database,
        template,
        buildLabelRows({
          orderName: readOrderNameFromFields(orderFields),
          orderFields,
          template,
          details,
          useBasisFields: command.input.useBasisFields ?? true,
        }),
        command.input.cutMapSelections,
        command.orderId,
        command.input.cutMapSource,
        {
          enabled: true,
          capability: 'v1',
          mediaDir: this.telegramMediaDir,
        },
      );
      for (const [key, image] of preparedResolution.preparedImages) generationPreparedImages.set(key, image);
    }
    try {
      return await this.database.transaction(async (tx) => {
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
        cutMapSource,
        {
          enabled: this.telegramFallbackEnabled,
          capability: command.input.telegramCutMapFallbackVersion,
          mediaDir: this.telegramMediaDir,
          preparedImages: generationPreparedImages,
        },
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
          JSON.stringify({
            detailIds,
            useBasisFields,
            cutMapSource,
            telegramCutMapFallbackVersion: command.input.telegramCutMapFallbackVersion,
          }),
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
      await insertGenerationTelegramSources(tx, generation.generationId, rows, resolved.preparedImages);
      const cutResultIds = [...new Set(rows.flatMap((row) => isCutResultCutMap(row.cutMap) ? [row.cutMap.cutResultId] : []))];
      const cutJobIds = [...new Set(rows.flatMap((row) => isCutResultCutMap(row.cutMap) ? [row.cutMap.cutJobId] : []))];
      const telegramRows = rows.filter((row): row is LabelRow & {
        cutMap: TelegramSvgLabelRowCutMapSnapshot | TelegramImageLabelRowCutMapSnapshot;
      } => isTelegramCutMap(row.cutMap));
      const telegramPacketIds = [...new Set(telegramRows.map((row) => row.cutMap.packetId))];
      const telegramSourceMessageIds = [...new Set(telegramRows.flatMap((row) => row.cutMap.sourceMessageId === null ? [] : [row.cutMap.sourceMessageId]))];
      const telegramAssetKeys = [...new Set(telegramRows.map((row) => row.cutMap.assetKey))];
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
        after: { ...generation, exportFormats: command.input.exportFormats, cutResultIds, telegramPacketIds },
        diff: { labelCount: generation.labelCount },
        metadata: { idempotencyKey: command.input.idempotencyKey, telegramSourceMessageIds, telegramAssetKeys },
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
          JSON.stringify({
            ...generation,
            templateId: template.labelTemplateId,
            cutResultIds,
            cutJobIds,
            telegramPacketIds,
            telegramSourceMessageIds,
            telegramAssetKeys,
          }),
          `${command.input.idempotencyKey}:order_labels.generated`,
        ],
      );
      await completeIdempotency(tx, command.input.idempotencyKey, generation);
      return generation;
      });
    } finally {
      await closePreparedTelegramImages(new Set(generationPreparedImages.values()));
    }
  }

  async previewDetailLabels(command: PreviewDetailLabelsCommand): Promise<DetailLabelsPreviewDto> {
    const template = await this.readTemplate(this.database, command.input.templateId, true);
    assertTemplateVersion(template.version, command.input.templateVersion);
    const useBasisFields = command.input.useBasisFields ?? true;
    const baseRows = await buildDetailLabelRowsForInput(this.database, template, command.input, useBasisFields);
    const resolved = await resolveDetailLabelCutMaps(
      this.database,
      template,
      baseRows,
      command.input,
      this.telegramMediaDir,
    );
    try {
      const rows = resolved.rows;
      const rowHash = hashLabelRows(rows);
      const svgPages = renderSvgPages(template, rows, resolved.assets).pages;
      assertTelegramSvgPagesLimit(rows, svgPages);
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
          detailIds: command.input.detailIds,
          useBasisFields,
          ...detailLabelScopeSnapshot(command.input),
          rowHash,
        }),
      };
    } finally {
      await closePreparedTelegramImages(resolved.preparedImages.values());
    }
  }

  async generateDetailLabels(command: GenerateDetailLabelsCommand): Promise<OrderLabelGenerationDto> {
    const detailIds = command.input.detailIds;
    const useBasisFields = command.input.useBasisFields ?? true;
    const token = decodePreviewToken(command.input.previewToken);
    const scopeSnapshot = detailLabelScopeSnapshot(command.input);
    if (
      token.generationScope !== 'details'
      || token.templateId !== command.input.templateId
      || token.templateVersion !== command.input.templateVersion
      || JSON.stringify(token.detailIds ?? []) !== JSON.stringify(detailIds)
      || (token.useBasisFields ?? true) !== useBasisFields
      || JSON.stringify(detailLabelScopeFromToken(token)) !== JSON.stringify(scopeSnapshot)
    ) {
      throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
    }
    const requestHash = hashRequest({
      generationScope: 'details',
      templateId: command.input.templateId,
      templateVersion: command.input.templateVersion,
      detailIds,
      useBasisFields,
      ...scopeSnapshot,
      rowHash: token.rowHash,
      exportFormats: command.input.exportFormats,
    });
    let needsPreparedFallbackImage = false;
    if (command.input.cutMapFallbackImage) {
      const template = await this.readTemplate(this.database, command.input.templateId, true);
      assertTemplateVersion(template.version, command.input.templateVersion);
      needsPreparedFallbackImage = template.elements.some((element) => element.kind === 'cut_map');
      if (needsPreparedFallbackImage) {
        const replay = await readIdempotencyReplay<OrderLabelGenerationDto>(
          this.database,
          command.input.idempotencyKey,
          requestHash,
        );
        if (replay) return replay;
      }
    }
    const generationPreparedImages = new Map<string, PreparedTelegramImage>();
    if (needsPreparedFallbackImage && command.input.cutMapFallbackImage) {
      const prepared = await prepareExplicitTelegramSheetImage(
        this.database,
        command.input.cutMapFallbackImage,
        this.telegramMediaDir,
      );
      generationPreparedImages.set(prepared.assetKey, prepared.image);
    }
    try {
      return await this.database.transaction(async (tx) => {
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
      const baseRows = await buildDetailLabelRowsForInput(tx, template, command.input, useBasisFields);
      const resolved = await resolveDetailLabelCutMaps(
        tx,
        template,
        baseRows,
        command.input,
        this.telegramMediaDir,
        generationPreparedImages,
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
          JSON.stringify({ detailIds, useBasisFields, ...scopeSnapshot }),
          JSON.stringify({ detailIds, orderIds: [...new Set(rows.map((row) => row.orderId))], ...scopeSnapshot }),
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
      await insertGenerationTelegramSources(tx, generation.generationId, rows, resolved.preparedImages);
      const cutResultIds = [...new Set(rows.flatMap((row) => isCutResultCutMap(row.cutMap) ? [row.cutMap.cutResultId] : []))];
      const cutJobIds = [...new Set(rows.flatMap((row) => isCutResultCutMap(row.cutMap) ? [row.cutMap.cutJobId] : []))];
      const telegramRows = rows.filter((row): row is LabelRow & {
        cutMap: TelegramSvgLabelRowCutMapSnapshot | TelegramImageLabelRowCutMapSnapshot;
      } => isTelegramCutMap(row.cutMap));
      const telegramPacketIds = [...new Set(telegramRows.map((row) => row.cutMap.packetId))];
      const telegramSourceMessageIds = [...new Set(telegramRows.flatMap((row) => row.cutMap.sourceMessageId === null ? [] : [row.cutMap.sourceMessageId]))];
      const telegramAssetKeys = [...new Set(telegramRows.map((row) => row.cutMap.assetKey))];
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
        metadata: { idempotencyKey: command.input.idempotencyKey, generationScope: 'details', telegramPacketIds, telegramSourceMessageIds, telegramAssetKeys },
        relatedEntities: [
          { entityType: 'order_label_generation', entityId: generation.generationId },
          ...[...new Set(rows.map((row) => row.detailId))].map((detailId) => ({ entityType: 'order_detail', entityId: detailId })),
          ...cutResultIds.map((cutResultId) => ({ entityType: 'cut_result', entityId: cutResultId })),
          ...cutJobIds.map((cutJobId) => ({ entityType: 'cut_job', entityId: cutJobId })),
        ],
      });
      await completeIdempotency(tx, command.input.idempotencyKey, generation);
      return generation;
      });
    } finally {
      await closePreparedTelegramImages(new Set(generationPreparedImages.values()));
    }
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
      cutMapAssets: await loadCutMapAssets(this.database, generation.rows, generation.generationId),
    });
    const orderName = readOrderNameFromFields(await readOrderFields(this.database, query.orderId));
    return {
      filename: buildOrderLabelsArchiveFilename(orderName, generation.generationId),
      contentType: 'application/zip',
      body,
    };
  }

  async getOrderLabelGenerationAccessDescriptor(query: ExportOrderLabelsQuery) {
    const result = await this.database.query<{
      order_label_generation_id: string | number;
      uses_cut_map: boolean;
    }>(
      `SELECT order_label_generation_id,
              jsonb_path_exists(rows_snapshot, '$[*].cutMap') AS uses_cut_map
       FROM order_label_generations
       WHERE order_id=$1 AND ($2::bigint IS NULL OR order_label_generation_id=$2)
       ORDER BY order_label_generation_id DESC
       LIMIT 1`,
      [query.orderId, query.generationId ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'ORDER_LABEL_GENERATION_NOT_FOUND', 'Label generation not found');
    return { generationId: Number(row.order_label_generation_id), usesCutMap: row.uses_cut_map === true };
  }

  async getDetailLabelGenerationAccessDescriptor(query: ExportDetailLabelsQuery) {
    const result = await this.database.query<{
      order_label_generation_id: string | number;
      uses_cut_map: boolean;
    }>(
      `SELECT order_label_generation_id,
              jsonb_path_exists(rows_snapshot, '$[*].cutMap') AS uses_cut_map
       FROM order_label_generations
       WHERE order_label_generation_id=$1 AND generation_scope='details'`,
      [query.generationId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'DETAIL_LABEL_GENERATION_NOT_FOUND', 'Label generation not found');
    return { generationId: Number(row.order_label_generation_id), usesCutMap: row.uses_cut_map === true };
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
      cutMapAssets: await loadCutMapAssets(this.database, generation.rows, generation.generationId),
    });
    return {
      filename: `labels-generation-${generation.generationId}.zip`,
      contentType: 'application/zip',
      body,
    };
  }

  async getLatestOrderLabelsPreview(query: ExportOrderLabelsQuery): Promise<LatestOrderLabelsPreviewDto> {
    await assertOrderExists(this.database, query.orderId);
    const generation = query.generationId
      ? await readGeneration(this.database, query.orderId, query.generationId)
      : await readLatestGeneration(this.database, query.orderId);
    const svgPages = renderSvgPages(
      generation.template,
      generation.rows,
      await loadCutMapAssets(this.database, generation.rows, generation.generationId),
    ).pages;
    return {
      generationId: generation.generationId,
      orderId: generation.orderId ?? query.orderId,
      templateId: generation.template.labelTemplateId,
      templateVersion: generation.template.version,
      labelCount: generation.rows.length,
      generatedAt: generation.generatedAt,
      rows: generation.rows,
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

async function buildDetailLabelRowsForInput(
  client: DatabaseClient,
  template: LabelTemplateDto,
  input: PreviewDetailLabelsCommand['input'],
  useBasisFields: boolean,
): Promise<LabelRow[]> {
  const detailInstances = detailInstancesForInput(input);
  const detailIds = detailInstances ? detailInstances.map((instance) => instance.detailId) : input.detailIds;
  if (detailInstances) assertDetailIdsCoverInstances(input.detailIds, detailInstances);
  const details = await readDetailLabelDetails(
    client,
    detailIds,
    template.labelTemplateId,
    template.customFieldSchema,
    detailInstances ? { quantityMode: 'actual' } : undefined,
  );
  const rows = buildLabelRows({ orderName: null, template, details, useBasisFields });
  return detailInstances ? selectLabelRowsByInstances(rows, detailInstances) : rows;
}

async function resolveDetailLabelCutMaps(
  client: DatabaseClient,
  template: LabelTemplateDto,
  rows: LabelRow[],
  input: PreviewDetailLabelsCommand['input'],
  mediaDir: string,
  preparedImages?: Map<string, PreparedTelegramImage>,
): Promise<{
  rows: LabelRow[];
  assets: LabelCutMapAssets;
  preparedImages: Map<string, PreparedTelegramImage>;
}> {
  const usesCutMap = template.elements.some((element) => element.kind === 'cut_map');
  if (!usesCutMap) return { rows, assets: new Map(), preparedImages: new Map() };
  if (!input.cutSheetScope && !input.cutMapFallbackImage) {
    throw new ApiError(
      422,
      'LABEL_CUT_MAP_SHEET_SCOPE_REQUIRED',
      'Передайте лист раскроя или скрин листа для шаблона с миниатюрой раскроя',
    );
  }

  const selections = input.cutSheetScope
    ? await resolveCutSheetScopeSelections(client, input.cutSheetScope, rows)
    : [];
  if (!input.cutMapFallbackImage) {
    if (selections.length !== rows.length) {
      throw new ApiError(409, 'LABEL_CUT_SHEET_PLACEMENT_MISSING', 'Лист раскроя больше недоступен для бирок');
    }
    return pickCutMapResolution(
      await resolveLabelCutMaps(client, template, rows, selections, undefined, undefined, undefined),
    );
  }

  const selectedKeys = new Set(selections.map((selection) => `${selection.detailId}:${selection.copyIndex}`));
  if (selectedKeys.size === rows.length) {
    return pickCutMapResolution(
      await resolveLabelCutMaps(client, template, rows, selections, undefined, undefined, undefined),
    );
  }

  const exactRows = rows.filter((row) => selectedKeys.has(`${row.detailId}:${row.copyIndex}`));
  const fallbackRows = rows.filter((row) => !selectedKeys.has(`${row.detailId}:${row.copyIndex}`));
  const exact = exactRows.length > 0
    ? pickCutMapResolution(await resolveLabelCutMaps(client, template, exactRows, selections, undefined, undefined, undefined))
    : { rows: [] as LabelRow[], assets: new Map() as LabelCutMapAssets, preparedImages: new Map<string, PreparedTelegramImage>() };
  const fallback = await resolveExplicitTelegramSheetImageRows(
    client,
    fallbackRows,
    input.cutMapFallbackImage,
    mediaDir,
    preparedImages,
    input.cutSheetScope,
  );
  const exactByKey = new Map(exact.rows.map((row) => [`${row.detailId}:${row.copyIndex}`, row]));
  const fallbackByKey = new Map(fallback.rows.map((row) => [`${row.detailId}:${row.copyIndex}`, row]));
  return {
    rows: rows.map((row) => exactByKey.get(`${row.detailId}:${row.copyIndex}`) ?? fallbackByKey.get(`${row.detailId}:${row.copyIndex}`) ?? row),
    assets: new Map([...exact.assets, ...fallback.assets]),
    preparedImages: new Map([...exact.preparedImages, ...fallback.preparedImages]),
  };
}

function pickCutMapResolution(resolved: Awaited<ReturnType<typeof resolveLabelCutMaps>>): {
  rows: LabelRow[];
  assets: LabelCutMapAssets;
  preparedImages: Map<string, PreparedTelegramImage>;
} {
  return { rows: resolved.rows, assets: resolved.assets, preparedImages: resolved.preparedImages };
}

function detailInstancesForInput(input: PreviewDetailLabelsCommand['input']): LabelCutSheetDetailInstanceInput[] | undefined {
  return input.cutSheetScope?.detailInstances ?? input.detailInstances;
}

function assertDetailIdsCoverInstances(detailIds: number[], detailInstances: LabelCutSheetDetailInstanceInput[]): void {
  const requested = new Set(detailIds);
  const missing = [...new Set(detailInstances.map((instance) => instance.detailId).filter((detailId) => !requested.has(detailId)))];
  if (missing.length > 0) {
    throw new ApiError(422, 'LABEL_DETAIL_INVALID', 'One or more label details were not found', { detailIds: missing });
  }
}

function selectLabelRowsByInstances(
  rows: LabelRow[],
  detailInstances: LabelCutSheetDetailInstanceInput[],
): LabelRow[] {
  const rowsByKey = new Map(rows.map((row) => [`${row.detailId}:${row.copyIndex}`, row]));
  const seen = new Set<string>();
  for (const instance of detailInstances) {
    const key = `${instance.detailId}:${instance.instance}`;
    if (seen.has(key)) {
      throw new ApiError(422, 'LABEL_DETAIL_INSTANCE_DUPLICATE', 'Один экземпляр детали нельзя добавить дважды', { key });
    }
    seen.add(key);
  }
  const matchedRows = detailInstances.flatMap((instance): LabelRow[] => {
    const key = `${instance.detailId}:${instance.instance}`;
    const row = rowsByKey.get(key);
    return row ? [row] : [];
  });
  const countByDetailId = new Map<number, number>();
  for (const row of matchedRows) {
    countByDetailId.set(row.detailId, (countByDetailId.get(row.detailId) ?? 0) + 1);
  }
  const selected = matchedRows.map((row, index): LabelRow => {
    const rowIndex = index + 1;
    const copyCount = countByDetailId.get(row.detailId) ?? row.copyCount;
    return {
      ...row,
      rowIndex,
      copyCount,
      values: {
        ...row.values,
        'bazis.quantity': copyCount,
        'label.counter': rowIndex,
        'label.counter_total': matchedRows.length,
        'label.counter_text': `Бир. № ${rowIndex} / ${matchedRows.length}`,
      },
    };
  });
  return selected;
}

async function resolveCutSheetScopeSelections(
  client: DatabaseClient,
  scope: LabelCutSheetScopeInput,
  rows: LabelRow[],
): Promise<LabelCutMapSelectionInput[]> {
  if (rows.length === 0) return [];
  const result = await client.query<CutSheetScopeSelectionRow>(
    `SELECT DISTINCT ON (p.order_id, p.order_detail_id, p.instance)
            p.order_id, p.order_detail_id, p.instance, p.cut_result_placement_id
     FROM cut_result_placement p
     JOIN cut_result_sheet_map s
       ON s.cut_result_sheet_map_id = p.cut_result_sheet_map_id
      AND s.is_effective = true
     JOIN cut_result_label_map_projection projection
       ON projection.cut_result_id = p.cut_result_id
     JOIN cut_result r
       ON r.cut_result_id = p.cut_result_id
      AND r.snapshot_digest = projection.snapshot_digest
     JOIN cut_job j
       ON j.cut_job_id = p.cut_job_id
      AND j.status <> 'archived'
     LEFT JOIN cut_result_archive_state archive
       ON archive.cut_job_id = r.cut_job_id
      AND archive.result_no = r.result_no
     JOIN unnest($4::bigint[], $5::bigint[], $6::integer[])
       AS requested(order_id, detail_id, instance)
       ON requested.order_id = p.order_id
      AND requested.detail_id = p.order_detail_id
      AND requested.instance = p.instance
     WHERE p.cut_job_id=$1
       AND p.cut_group_id=$2
       AND p.sheet_index=$3
       AND s.cut_group_id=$2
       AND s.sheet_index=$3
       AND archive.archived_at IS NULL
     ORDER BY p.order_id, p.order_detail_id, p.instance, p.cut_result_id DESC, p.cut_result_placement_id DESC`,
    [
      scope.cutJobId,
      scope.cutGroupId,
      scope.sheetIndex,
      rows.map((row) => row.orderId),
      rows.map((row) => row.detailId),
      rows.map((row) => row.copyIndex),
    ],
  );
  return result.rows.map((row) => ({
    detailId: toNumber(row.order_detail_id),
    copyIndex: toNumber(row.instance),
    cutResultPlacementId: toNumber(row.cut_result_placement_id),
  }));
}

async function resolveExplicitTelegramSheetImageRows(
  client: DatabaseClient,
  rows: LabelRow[],
  input: LabelCutMapFallbackImageInput,
  mediaDir: string,
  preparedImages?: Map<string, PreparedTelegramImage>,
  scope?: LabelCutSheetScopeInput,
): Promise<{
  rows: LabelRow[];
  assets: LabelCutMapAssets;
  preparedImages: Map<string, PreparedTelegramImage>;
}> {
  if (rows.length === 0) return { rows, assets: new Map(), preparedImages: new Map() };
  await assertExplicitTelegramImageRowsBelongToPacket(client, input, rows);
  const prepared = await prepareExplicitTelegramSheetImage(client, input, mediaDir, preparedImages);
  const cutNumber = telegramPacketCutNumber(prepared.packet);
  const cutJobName = telegramPacketCutJobName(prepared.packet, 'Скрин Telegram');
  const sheetSize = telegramPacketSheetSize(prepared.packet);
  const sheetIndex = scope?.sheetIndex ?? 0;
  const sheetNumber = sheetIndex + 1;
  const resolvedRows = rows.map((row) => withCutMap(row, {
    source: 'telegram_image',
    assetKey: prepared.assetKey,
    packetId: prepared.packet.packet_id,
    sourceVersion: toNumber(prepared.packet.source_version),
    sourceMessageId: nullableNumber(prepared.packet.source_message_id),
    sourceDigest: `sha256:${prepared.image.rawSha256}`,
    rawSha256: prepared.image.rawSha256,
    normalizedSha256: prepared.image.normalizedSha256,
    cutNumber,
    cutJobName,
    variant: 'telegram',
    sheetIndex,
    sheetNumber,
    ...sheetSize,
  }));
  return {
    rows: resolvedRows,
    assets: new Map([[prepared.assetKey, { kind: 'image', dataUri: prepared.image.dataUri }]]),
    preparedImages: new Map([[prepared.assetKey, prepared.image]]),
  };
}

async function assertExplicitTelegramImageRowsBelongToPacket(
  client: DatabaseClient,
  input: LabelCutMapFallbackImageInput,
  rows: LabelRow[],
): Promise<void> {
  const result = await client.query<TelegramSheetImageEvidenceRow>(
    `WITH requested AS (
       SELECT * FROM unnest($3::bigint[], $4::bigint[], $5::integer[])
         AS value(order_id, detail_id, instance)
     ), evidence_by_detail AS (
       SELECT evidence.match_order_id AS order_id,
              evidence.match_detail_id AS detail_id,
              min(evidence.quantity)::integer AS evidence_quantity,
              min(evidence.width_mm) AS width_mm,
              min(evidence.height_mm) AS height_mm,
              min(evidence.source) AS source,
              count(*)=1 AND bool_and(evidence.match_status='matched') AS evidence_eligible
       FROM cnc_telegram_packet_item_evidence evidence
       JOIN cnc_telegram_packet_evidence_set evidence_set
         ON evidence_set.packet_id=evidence.packet_id
        AND evidence_set.source_version=evidence.source_version
        AND evidence_set.payload_hash=evidence.payload_hash
       JOIN cnc_telegram_packets packet
         ON packet.packet_id=evidence.packet_id
        AND packet.source_version=evidence.source_version
        AND packet.payload_hash=evidence.payload_hash
       WHERE evidence.packet_id=$1::uuid
         AND evidence.source_version=$2
         AND evidence.match_order_id IS NOT NULL
         AND evidence.match_detail_id IS NOT NULL
         AND packet.sheet_image_storage_key IS NOT NULL
         AND (
           packet.svg_cut_import_status IS DISTINCT FROM 'imported'
           OR packet.svg_cut_job_id IS NULL
           OR packet.svg_cut_result_id IS NULL
         )
       GROUP BY evidence.match_order_id, evidence.match_detail_id
     )
     SELECT requested.order_id, requested.detail_id, requested.instance,
            evidence.evidence_quantity,
            evidence.evidence_eligible,
            (
              evidence.width_mm IS NOT NULL AND evidence.height_mm IS NOT NULL
              AND (
                (abs(evidence.width_mm-detail.width) <= CASE WHEN evidence.source='ocr' THEN 3 ELSE 0.01 END
                 AND abs(evidence.height_mm-detail.height) <= CASE WHEN evidence.source='ocr' THEN 3 ELSE 0.01 END)
                OR
                (abs(evidence.width_mm-detail.height) <= CASE WHEN evidence.source='ocr' THEN 3 ELSE 0.01 END
                 AND abs(evidence.height_mm-detail.width) <= CASE WHEN evidence.source='ocr' THEN 3 ELSE 0.01 END)
              )
            ) AS dimensions_match
     FROM requested
     JOIN evidence_by_detail evidence
       ON evidence.order_id=requested.order_id
      AND evidence.detail_id=requested.detail_id
     JOIN order_details detail
       ON detail.detail_id=requested.detail_id
      AND detail.order_id=requested.order_id
      AND detail.delete_flag=false
     JOIN orders order_row
       ON order_row.order_id=detail.order_id
      AND order_row.delete_flag=false
     WHERE requested.instance <= evidence.evidence_quantity`,
    [
      input.packetId,
      input.sourceVersion,
      rows.map((row) => row.orderId),
      rows.map((row) => row.detailId),
      rows.map((row) => row.copyIndex),
    ],
  );
  const evidenceByKey = new Map(result.rows.map((row) => [`${toNumber(row.order_id)}:${toNumber(row.detail_id)}:${toNumber(row.instance)}`, row]));
  for (const row of rows) {
    const evidence = evidenceByKey.get(`${row.orderId}:${row.detailId}:${row.copyIndex}`);
    if (!evidence || evidence.evidence_eligible !== true || evidence.dimensions_match !== true) {
      throw new ApiError(422, 'LABEL_CUT_MAP_FALLBACK_MISMATCH', 'Скрин листа не соответствует деталям бирок', {
        packetId: input.packetId,
        detailId: row.detailId,
        copyIndex: row.copyIndex,
      });
    }
  }
}

async function prepareExplicitTelegramSheetImage(
  client: DatabaseClient,
  input: LabelCutMapFallbackImageInput,
  mediaDir: string,
  preparedImages?: Map<string, PreparedTelegramImage>,
): Promise<{ assetKey: string; image: PreparedTelegramImage; packet: TelegramSheetImageRow }> {
  const result = await client.query<TelegramSheetImageRow>(
    `SELECT packet_id, source_version, source_message_id, cutting_sequence_no,
            sheet_image_storage_key, sheet_image_content_type, sheet_image_size_bytes,
            cut_layout_json #>> '{sheet,widthMm}' AS sheet_width_mm,
            cut_layout_json #>> '{sheet,heightMm}' AS sheet_height_mm
     FROM cnc_telegram_packets
     WHERE packet_id=$1::uuid`,
    [input.packetId],
  );
  const packet = result.rows[0];
  if (
    !packet
    || toNumber(packet.source_version) !== input.sourceVersion
    || packet.sheet_image_storage_key !== input.storageKey
  ) {
    throw new ApiError(409, 'LABEL_TELEGRAM_MEDIA_STALE', 'Telegram image changed after preview');
  }
  if (!packet.sheet_image_storage_key) {
    throw new ApiError(422, 'LABEL_TELEGRAM_MEDIA_INVALID', 'Telegram cut-map image is unavailable');
  }
  const metadata = {
    storageKey: packet.sheet_image_storage_key,
    contentType: packet.sheet_image_content_type,
    sizeBytes: nullableNumber(packet.sheet_image_size_bytes),
  };
  const cached = [...(preparedImages?.values() ?? [])].find((image) => image.storageKey === metadata.storageKey);
  const image = cached ?? await prepareTelegramImage(mediaDir, metadata);
  if (!telegramImageCandidateMatchesMedia(packet, image)) {
    if (!cached) await image.handle.close();
    throw new ApiError(409, 'LABEL_TELEGRAM_MEDIA_STALE', 'Telegram image changed after preview');
  }
  const assetKey = `telegram_image:${packet.packet_id}:${packet.source_version}:${image.rawSha256}:${image.normalizedSha256}`;
  return { assetKey, image, packet };
}

export async function resolveLabelCutMaps(
  client: DatabaseClient,
  template: LabelTemplateDto,
  rows: LabelRow[],
  selections: LabelCutMapSelectionInput[] | undefined,
  orderId?: number,
  cutMapSource?: LabelCutMapSource,
  telegram?: {
    enabled: boolean;
    capability?: 'v1';
    mediaDir: string;
    preparedImages?: Map<string, PreparedTelegramImage>;
    imageMode?: 'prepare' | 'validate';
  },
): Promise<{
  rows: LabelRow[];
  assets: LabelCutMapAssets;
  preparedImages: Map<string, PreparedTelegramImage>;
  unavailable: Map<string, TelegramImageUnavailableReason>;
  imageCandidates: Map<string, TelegramImageAvailability>;
}> {
  const usesCutMap = template.elements.some((element) => element.kind === 'cut_map');
  if (!usesCutMap) {
    if ((selections?.length ?? 0) > 0) {
      throw new ApiError(422, 'LABEL_CUT_MAP_NOT_IN_TEMPLATE', 'Шаблон не содержит миниатюру раскроя');
    }
    return { rows, assets: new Map(), preparedImages: new Map(), unavailable: new Map(), imageCandidates: new Map() };
  }
  if (rows.length === 0) return { rows, assets: new Map(), preparedImages: new Map(), unavailable: new Map(), imageCandidates: new Map() };

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
       JOIN cut_job j
         ON j.cut_job_id = p.cut_job_id
        AND j.status <> 'archived'
       LEFT JOIN cut_param_profiles cpp
         ON cpp.cut_param_profile_id = j.param_profile_id
       LEFT JOIN cut_result_archive_state archive
         ON archive.cut_job_id = r.cut_job_id
        AND archive.result_no = r.result_no
       JOIN order_details od
         ON od.detail_id = p.order_detail_id
        AND od.order_id = p.order_id
        AND od.delete_flag = false
       ${DETAIL_CUT_RESULT_VERSION_FIELDS_SQL}
       JOIN unnest($1::bigint[], $2::bigint[], $3::integer[])
         AS requested(order_id, detail_id, instance)
         ON requested.order_id = p.order_id
        AND requested.detail_id = p.order_detail_id
        AND requested.instance = p.instance
       WHERE archive.archived_at IS NULL
         AND (
           $4::text IS NULL
           OR ($4::text = 'bath' AND COALESCE(
             j.last_calc_params->>'layout_mode',
             cpp.params->>'layout_mode',
             j.params->>'layout_mode'
           ) = 'vacuum_table'
           AND ((CASE
                  WHEN NULLIF(btrim(j.source_display_number), '') LIKE 'В-%'
                    THEN NULLIF(btrim(j.source_display_number), '')
                  ELSE 'В-' || COALESCE(NULLIF(btrim(j.source_display_number), ''), p.cut_job_id::text)
                END) || '-' || r.result_no::text) = cut_version_fields.vacuum_cut_number)
           OR ($4::text = 'regular' AND COALESCE(
             j.last_calc_params->>'layout_mode',
             cpp.params->>'layout_mode',
             j.params->>'layout_mode'
           ) IS DISTINCT FROM 'vacuum_table'
           AND (COALESCE(NULLIF(btrim(j.source_display_number), ''), p.cut_job_id::text) || '-' || r.result_no::text) = cut_version_fields.regular_cut_number)
         )`,
      [
        unselectedRows.map((row) => row.orderId),
        unselectedRows.map((row) => row.detailId),
        unselectedRows.map((row) => row.copyIndex),
        cutMapSource ?? null,
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
  if (placementIds.size === 0) {
    return resolveTelegramFallbackRows(client, rows, new Map(), orderId, cutMapSource, telegram);
  }

  const result = await client.query<ResolvedCutMapRow>(
    `SELECT p.cut_result_placement_id, p.cut_result_sheet_map_id,
            p.cut_result_id, p.cut_job_id, p.order_id, p.order_detail_id,
            p.instance, p.variant, p.sheet_index, p.x_mm, p.y_mm,
            p.width_mm, p.height_mm, s.sheet_ordinal,
            s.sheet_width_mm, s.sheet_height_mm, s.base_svg,
            r.result_no,
            cut_version_fields.regular_cut_number, cut_version_fields.vacuum_cut_number,
            COALESCE(r.snapshot_job ->> 'name', 'Раскрой ' || p.cut_job_id::text) AS cut_job_name,
            j.source_display_number,
            ${CUT_RESULT_SHEET_IS_VACUUM_SQL} AS is_vacuum,
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
     JOIN cut_job j
       ON j.cut_job_id = p.cut_job_id
      AND j.status <> 'archived'
     LEFT JOIN cut_param_profiles cpp
       ON cpp.cut_param_profile_id = j.param_profile_id
     LEFT JOIN cut_result_archive_state archive
       ON archive.cut_job_id = r.cut_job_id
      AND archive.result_no = r.result_no
     JOIN order_details od
       ON od.detail_id = p.order_detail_id
      AND od.delete_flag = false
     ${DETAIL_CUT_RESULT_VERSION_FIELDS_SQL}
     WHERE p.cut_result_placement_id = ANY($1::bigint[])
       AND ($2::bigint IS NULL OR p.order_id = $2)
       AND archive.archived_at IS NULL`,
    [[...placementIds], orderId ?? null],
  );
  const placementById = new Map(result.rows.map((row) => [toNumber(row.cut_result_placement_id), row]));
  if (placementById.size !== placementIds.size) {
    throw new ApiError(409, 'LABEL_CUT_MAP_SELECTION_STALE', 'Выбранный раскрой больше недоступен');
  }
  if (cutMapSource) {
    for (const placement of placementById.values()) {
      if (!cutMapPlacementMatchesSource(placement, cutMapSource)) {
        throw new ApiError(422, 'LABEL_CUT_MAP_SELECTION_SOURCE_MISMATCH', 'Раскрой не соответствует выбранному полю детали', {
          cutMapSource,
          cutNumber: formatCutNumber(toNumber(placement.cut_job_id), toNumber(placement.result_no), placement.is_vacuum === true, placement.source_display_number),
          expectedCutNumber: cutMapSource === 'bath' ? placement.vacuum_cut_number : placement.regular_cut_number,
          cutResultPlacementId: toNumber(placement.cut_result_placement_id),
        });
      }
    }
  }

  const assets = new Map<string | number, LabelCutMapAsset>();
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
      cutNumber: formatCutNumber(toNumber(placement.cut_job_id), toNumber(placement.result_no), placement.is_vacuum === true, placement.source_display_number),
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
    assets.set(`cut_result:${cutResultSheetMapId}`, {
      svg: placement.base_svg,
      isVacuum: placement.is_vacuum === true,
    });
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
  return resolveTelegramFallbackRows(client, resolvedRows, assets, orderId, cutMapSource, telegram);
}

async function resolveTelegramFallbackRows(
  client: DatabaseClient,
  rows: LabelRow[],
  initialAssets: LabelCutMapAssets,
  orderId: number | undefined,
  cutMapSource: LabelCutMapSource | undefined,
  telegram: {
    enabled: boolean;
    capability?: 'v1';
    mediaDir: string;
    preparedImages?: Map<string, PreparedTelegramImage>;
    imageMode?: 'prepare' | 'validate';
  } | undefined,
): Promise<{
  rows: LabelRow[];
  assets: LabelCutMapAssets;
  preparedImages: Map<string, PreparedTelegramImage>;
  unavailable: Map<string, TelegramImageUnavailableReason>;
  imageCandidates: Map<string, TelegramImageAvailability>;
}> {
  const assets = new Map(initialAssets);
  const preparedImages = new Map<string, PreparedTelegramImage>();
  const unavailable = new Map<string, TelegramImageUnavailableReason>();
  const imageCandidates = new Map<string, TelegramImageAvailability>();
  if (!telegram?.enabled || telegram.capability !== 'v1' || cutMapSource !== 'regular' || orderId === undefined) {
    return { rows, assets, preparedImages, unavailable, imageCandidates };
  }
  const targets = rows.filter((row) => row.cutMap === undefined);
  if (targets.length === 0) return { rows, assets, preparedImages, unavailable, imageCandidates };
  const params = [
    targets.map((row) => row.orderId),
    targets.map((row) => row.detailId),
    targets.map((row) => row.copyIndex),
  ];
  const svgResult = await client.query<TelegramSvgCandidateRow>(
    `WITH requested AS (
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::integer[])
         AS value(order_id, detail_id, instance)
     ), requested_details AS (
       SELECT DISTINCT order_id, detail_id FROM requested
     ), svg_candidates AS (
       SELECT DISTINCT
       map.telegram_label_sheet_map_id,
       packet.packet_id, packet.source_version, packet.source_message_id, packet.cutting_sequence_no, map.layout_digest,
       placement.order_id, placement.order_detail_id,
       map.sheet_width_mm, map.sheet_height_mm, map.base_svg,
       COALESCE(packet.completed_at, packet.source_updated_at, packet.source_created_at, packet.updated_at) AS candidate_at
       FROM requested_details
       JOIN cnc_telegram_label_placement placement
         ON placement.order_id=requested_details.order_id
        AND placement.order_detail_id=requested_details.detail_id
       JOIN cnc_telegram_label_sheet_map map
         ON map.telegram_label_sheet_map_id=placement.telegram_label_sheet_map_id
       JOIN cnc_telegram_packets packet
         ON packet.packet_id=map.packet_id AND packet.source_version=map.source_version
       JOIN cnc_telegram_packet_evidence_set evidence_set
         ON evidence_set.packet_id=packet.packet_id
        AND evidence_set.source_version=packet.source_version
        AND evidence_set.payload_hash=packet.payload_hash
       WHERE packet.parse_status IN ('parsed','needs_review')
         AND packet.rework=false
         AND (packet.completion_status='completed' OR packet.thumbs_up=true)
         AND packet.cut_layout_json->>'status'='valid'
     ), ranked_svg_candidates AS (
       SELECT candidate.*,
       row_number() OVER (
         PARTITION BY candidate.order_id, candidate.order_detail_id
         ORDER BY candidate.candidate_at DESC, candidate.source_version DESC,
                  candidate.source_message_id DESC NULLS LAST, candidate.packet_id DESC
       ) AS candidate_rank
       FROM svg_candidates candidate
     )
     SELECT candidate.telegram_label_sheet_map_id, placement.telegram_label_placement_id,
       candidate.packet_id, candidate.source_version, candidate.source_message_id, candidate.cutting_sequence_no, candidate.layout_digest,
       requested.order_id, requested.detail_id AS order_detail_id, requested.instance,
       candidate.sheet_width_mm, candidate.sheet_height_mm, candidate.base_svg,
       placement.x_mm, placement.y_mm, placement.width_mm, placement.height_mm
     FROM requested
     JOIN ranked_svg_candidates candidate
      ON candidate.order_id=requested.order_id
      AND candidate.order_detail_id=requested.detail_id
      AND candidate.candidate_rank=1
     JOIN cnc_telegram_label_placement placement
       ON placement.telegram_label_sheet_map_id=candidate.telegram_label_sheet_map_id
      AND placement.order_id=requested.order_id
      AND placement.order_detail_id=requested.detail_id
      AND placement.instance=requested.instance
     JOIN order_details detail
       ON detail.detail_id=requested.detail_id
      AND detail.order_id=requested.order_id
      AND detail.delete_flag=false
     JOIN orders order_row ON order_row.order_id=detail.order_id AND order_row.delete_flag=false
     WHERE requested.instance <= detail.quantity
       AND (
         (abs(placement.source_width_mm-detail.width) <= placement.tolerance_mm
          AND abs(placement.source_height_mm-detail.height) <= placement.tolerance_mm)
         OR
         (abs(placement.source_width_mm-detail.height) <= placement.tolerance_mm
          AND abs(placement.source_height_mm-detail.width) <= placement.tolerance_mm)
       )`,
    params,
  );
  const svgByCopy = new Map(svgResult.rows.map((row) => [
    `${Number(row.order_id)}:${Number(row.order_detail_id)}:${Number(row.instance)}`,
    row,
  ]));
  let resolvedRows = rows.map((row): LabelRow => {
    if (row.cutMap) return row;
    const candidate = svgByCopy.get(`${row.orderId}:${row.detailId}:${row.copyIndex}`);
    if (!candidate) return row;
    const sheetMapId = Number(candidate.telegram_label_sheet_map_id);
    const assetKey = `telegram_svg:${sheetMapId}`;
    assets.set(assetKey, { kind: 'svg', svg: candidate.base_svg, isVacuum: false });
    const cutMap: LabelRowCutMapSnapshot = {
      source: 'telegram_svg',
      assetKey,
      telegramLabelSheetMapId: sheetMapId,
      telegramLabelPlacementId: Number(candidate.telegram_label_placement_id),
      packetId: candidate.packet_id,
      sourceVersion: Number(candidate.source_version),
      sourceMessageId: nullableNumber(candidate.source_message_id),
      sourceDigest: candidate.layout_digest,
      cutNumber: telegramPacketCutNumber(candidate),
      cutJobName: telegramPacketCutJobName(candidate, 'Telegram SVG'),
      variant: 'telegram',
      sheetIndex: 0,
      sheetNumber: 1,
      sheetWidthMm: Number(candidate.sheet_width_mm),
      sheetHeightMm: Number(candidate.sheet_height_mm),
      xMm: Number(candidate.x_mm),
      yMm: Number(candidate.y_mm),
      widthMm: Number(candidate.width_mm),
      heightMm: Number(candidate.height_mm),
    };
    return withCutMap(row, cutMap);
  });

  const imageTargets = resolvedRows.filter((row) => row.cutMap === undefined);
  if (imageTargets.length === 0) return { rows: resolvedRows, assets, preparedImages, unavailable, imageCandidates };
  const imageResult = await client.query<TelegramImageCandidateRow>(
    `WITH requested AS (
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::integer[])
         AS value(order_id, detail_id, instance)
     ), requested_details AS (
       SELECT DISTINCT order_id, detail_id FROM requested
     ), evidence_by_detail AS (
       SELECT evidence.packet_id, evidence.source_version, evidence.payload_hash,
              evidence.match_order_id AS order_id, evidence.match_detail_id AS detail_id,
              min(evidence.quantity)::integer AS quantity,
              min(evidence.width_mm) AS width_mm, min(evidence.height_mm) AS height_mm,
              min(evidence.source) AS source,
              count(*)=1 AND bool_and(evidence.match_status='matched') AS evidence_eligible
       FROM cnc_telegram_packet_item_evidence evidence
       JOIN cnc_telegram_packet_evidence_set evidence_set
         ON evidence_set.packet_id=evidence.packet_id
        AND evidence_set.source_version=evidence.source_version
        AND evidence_set.payload_hash=evidence.payload_hash
       WHERE evidence.match_order_id IS NOT NULL AND evidence.match_detail_id IS NOT NULL
       GROUP BY evidence.packet_id, evidence.source_version, evidence.payload_hash,
                evidence.match_order_id, evidence.match_detail_id
     ), ranked_candidates AS (
       SELECT evidence.order_id, evidence.detail_id, evidence.quantity AS evidence_quantity,
              evidence.width_mm, evidence.height_mm, evidence.source, evidence.evidence_eligible,
              packet.packet_id, packet.source_version, packet.source_message_id, packet.cutting_sequence_no,
              packet.sheet_image_storage_key, packet.sheet_image_content_type, packet.sheet_image_size_bytes,
              packet.cut_layout_json #>> '{sheet,widthMm}' AS sheet_width_mm,
              packet.cut_layout_json #>> '{sheet,heightMm}' AS sheet_height_mm,
              row_number() OVER (
                PARTITION BY evidence.order_id, evidence.detail_id
                ORDER BY COALESCE(packet.completed_at, packet.source_updated_at, packet.source_created_at, packet.updated_at) DESC,
                         packet.source_version DESC, packet.source_message_id DESC NULLS LAST, packet.packet_id DESC
              ) AS candidate_rank
       FROM requested_details
       JOIN evidence_by_detail evidence
         ON evidence.order_id=requested_details.order_id AND evidence.detail_id=requested_details.detail_id
       JOIN cnc_telegram_packets packet
         ON packet.packet_id=evidence.packet_id
        AND packet.source_version=evidence.source_version
        AND packet.payload_hash=evidence.payload_hash
       WHERE packet.parse_status IN ('parsed','needs_review')
         AND packet.rework=false
         AND (packet.completion_status='completed' OR packet.thumbs_up=true)
         AND packet.sheet_image_storage_key IS NOT NULL
         AND (
           packet.svg_cut_import_status IS DISTINCT FROM 'imported'
           OR packet.svg_cut_job_id IS NULL
           OR packet.svg_cut_result_id IS NULL
         )
     )
     SELECT candidate.packet_id, candidate.source_version, candidate.source_message_id, candidate.cutting_sequence_no,
       requested.order_id, requested.detail_id AS order_detail_id, requested.instance,
       candidate.sheet_image_storage_key, candidate.sheet_image_content_type, candidate.sheet_image_size_bytes,
       candidate.sheet_width_mm, candidate.sheet_height_mm,
       candidate.evidence_quantity, candidate.evidence_eligible
     FROM requested
     JOIN ranked_candidates candidate
       ON candidate.order_id=requested.order_id
      AND candidate.detail_id=requested.detail_id
      AND candidate.candidate_rank=1
     JOIN order_details detail
       ON detail.detail_id=candidate.detail_id AND detail.order_id=candidate.order_id AND detail.delete_flag=false
     JOIN orders order_row ON order_row.order_id=detail.order_id AND order_row.delete_flag=false
     WHERE candidate.width_mm IS NOT NULL AND candidate.height_mm IS NOT NULL
       AND (
         (abs(candidate.width_mm-detail.width) <= CASE WHEN candidate.source='ocr' THEN 3 ELSE 0.01 END
          AND abs(candidate.height_mm-detail.height) <= CASE WHEN candidate.source='ocr' THEN 3 ELSE 0.01 END)
         OR
         (abs(candidate.width_mm-detail.height) <= CASE WHEN candidate.source='ocr' THEN 3 ELSE 0.01 END
          AND abs(candidate.height_mm-detail.width) <= CASE WHEN candidate.source='ocr' THEN 3 ELSE 0.01 END)
       )
     ORDER BY requested.order_id, requested.detail_id, requested.instance`,
    [
      imageTargets.map((row) => row.orderId),
      imageTargets.map((row) => row.detailId),
      imageTargets.map((row) => row.copyIndex),
    ],
  );
  const imageByCopy = new Map(imageResult.rows.map((row) => [
    `${Number(row.order_id)}:${Number(row.order_detail_id)}:${Number(row.instance)}`,
    row,
  ]));
  const preparedByStorageKey = new Map<string, PreparedTelegramImage>();
  for (const prepared of telegram.preparedImages?.values() ?? []) {
    preparedByStorageKey.set(prepared.storageKey, prepared);
  }
  const unavailableByStorageKey = new Map<string, TelegramImageUnavailableReason>();
  const validatedByStorageKey = new Map<string, Pick<PreparedTelegramImage, 'contentType' | 'sizeBytes'>>();
  const acceptedImageCopyKeys = new Set<string>();
  const attemptedStorageKeys = new Set<string>();
  const openedPreparedImages = new Set<PreparedTelegramImage>();
  let rawTotal = 0;
  for (const candidate of imageResult.rows) {
    const key = candidate.sheet_image_storage_key;
    const copyKey = `${Number(candidate.order_id)}:${Number(candidate.order_detail_id)}:${Number(candidate.instance)}`;
    if (!candidate.evidence_eligible) {
      unavailable.set(copyKey, 'ambiguous_evidence');
      continue;
    }
    if (Number(candidate.instance) > Number(candidate.evidence_quantity)) continue;
    const cachedPrepared = preparedByStorageKey.get(key);
    if (cachedPrepared) {
      if (telegramImageCandidateMatchesMedia(candidate, cachedPrepared)) acceptedImageCopyKeys.add(copyKey);
      else unavailable.set(copyKey, 'invalid_media');
      continue;
    }
    const cachedValidated = validatedByStorageKey.get(key);
    if (cachedValidated) {
      if (telegramImageCandidateMatchesMedia(candidate, cachedValidated)) acceptedImageCopyKeys.add(copyKey);
      else unavailable.set(copyKey, 'invalid_media');
      continue;
    }
    const cachedUnavailable = unavailableByStorageKey.get(key);
    if (cachedUnavailable) {
      unavailable.set(copyKey, cachedUnavailable);
      continue;
    }
    if (!attemptedStorageKeys.has(key) && attemptedStorageKeys.size >= 16) {
      unavailable.set(copyKey, 'request_limit_exceeded');
      continue;
    }
    attemptedStorageKeys.add(key);
    const declared = nullableNumber(candidate.sheet_image_size_bytes) ?? TELEGRAM_IMAGE_LIMITS.maxSourceBytes;
    if (declared > TELEGRAM_IMAGE_LIMITS.maxSourceBytes) {
      unavailable.set(copyKey, 'invalid_media');
      continue;
    }
    if (rawTotal + declared > 32 * 1024 * 1024) {
      unavailable.set(copyKey, 'request_limit_exceeded');
      continue;
    }
    if (telegram.preparedImages !== undefined) {
      unavailableByStorageKey.set(key, 'invalid_media');
      unavailable.set(copyKey, 'invalid_media');
      continue;
    }
    try {
      const metadata = {
        storageKey: key,
        contentType: null,
        sizeBytes: null,
      };
      if (telegram.imageMode === 'validate') {
        const opened = await validateTelegramImage(telegram.mediaDir, metadata);
        if (rawTotal + opened.sizeBytes > 32 * 1024 * 1024) {
          await opened.handle.close();
          unavailableByStorageKey.set(key, 'request_limit_exceeded');
          unavailable.set(copyKey, 'request_limit_exceeded');
          continue;
        }
        rawTotal += opened.sizeBytes;
        validatedByStorageKey.set(key, opened);
        await opened.handle.close();
        if (telegramImageCandidateMatchesMedia(candidate, opened)) acceptedImageCopyKeys.add(copyKey);
        else unavailable.set(copyKey, 'invalid_media');
      } else {
        const prepared = await prepareTelegramImage(telegram.mediaDir, metadata);
        if (rawTotal + prepared.sizeBytes > 32 * 1024 * 1024) {
          await prepared.handle.close();
          unavailableByStorageKey.set(key, 'request_limit_exceeded');
          unavailable.set(copyKey, 'request_limit_exceeded');
          continue;
        }
        rawTotal += prepared.sizeBytes;
        openedPreparedImages.add(prepared);
        preparedByStorageKey.set(key, prepared);
        if (telegramImageCandidateMatchesMedia(candidate, prepared)) acceptedImageCopyKeys.add(copyKey);
        else unavailable.set(copyKey, 'invalid_media');
      }
    } catch {
      unavailableByStorageKey.set(key, 'invalid_media');
      unavailable.set(copyKey, 'invalid_media');
    }
  }
  resolvedRows = resolvedRows.map((row): LabelRow => {
    if (row.cutMap) return row;
    const candidate = imageByCopy.get(`${row.orderId}:${row.detailId}:${row.copyIndex}`);
    if (!candidate) return row;
    if (!candidate.evidence_eligible) return row;
    if (row.copyIndex > Number(candidate.evidence_quantity)) return row;
    const copyKey = `${row.orderId}:${row.detailId}:${row.copyIndex}`;
    if (!acceptedImageCopyKeys.has(copyKey)) return row;
    if (telegram.imageMode === 'validate') {
      imageCandidates.set(copyKey, {
        packetId: candidate.packet_id,
        sourceMessageId: nullableNumber(candidate.source_message_id),
      });
      return row;
    }
    const prepared = preparedByStorageKey.get(candidate.sheet_image_storage_key);
    if (!prepared) return row;
    const assetKey = `telegram_image:${candidate.packet_id}:${candidate.source_version}:${prepared.rawSha256}:${prepared.normalizedSha256}`;
    preparedImages.set(assetKey, prepared);
    assets.set(assetKey, { kind: 'image', dataUri: prepared.dataUri });
    const sheetSize = telegramPacketSheetSize(candidate);
    const cutMap: LabelRowCutMapSnapshot = {
      source: 'telegram_image',
      assetKey,
      packetId: candidate.packet_id,
      sourceVersion: Number(candidate.source_version),
      sourceMessageId: nullableNumber(candidate.source_message_id),
      sourceDigest: `sha256:${prepared.rawSha256}`,
      rawSha256: prepared.rawSha256,
      normalizedSha256: prepared.normalizedSha256,
      cutNumber: telegramPacketCutNumber(candidate),
      cutJobName: telegramPacketCutJobName(candidate, 'Скрин Telegram'),
      variant: 'telegram',
      sheetIndex: 0,
      sheetNumber: 1,
      ...sheetSize,
    };
    return withCutMap(row, cutMap);
  });
  const usedPreparedImages = new Set(preparedImages.values());
  await closePreparedTelegramImages(
    [...openedPreparedImages].filter((prepared) => !usedPreparedImages.has(prepared)),
  );
  const uniqueNormalizedBytes = [...new Set(preparedImages.values())]
    .reduce((sum, prepared) => sum + prepared.normalized.length, 0);
  const expandedBytes = resolvedRows.reduce((sum, row) => {
    if (row.cutMap?.source !== 'telegram_image') return sum;
    const prepared = preparedImages.get(row.cutMap.assetKey);
    return sum + (prepared ? 4 * Math.ceil(prepared.normalized.length / 3) : 0);
  }, 0);
  if (uniqueNormalizedBytes > 8 * 1024 * 1024 || expandedBytes > 64 * 1024 * 1024) {
    await closePreparedTelegramImages(new Set(preparedImages.values()));
    throw new ApiError(422, 'LABEL_TELEGRAM_IMAGE_LIMIT_EXCEEDED', 'Telegram label image request exceeds limits');
  }
  return { rows: resolvedRows, assets, preparedImages, unavailable, imageCandidates };
}

function telegramImageCandidateMatchesMedia(
  candidate: Pick<TelegramImageCandidateRow, 'sheet_image_content_type' | 'sheet_image_size_bytes'>,
  media: { contentType: PreparedTelegramImage['contentType']; sizeBytes: number },
): boolean {
  const storedSize = nullableNumber(candidate.sheet_image_size_bytes);
  if (storedSize !== null && storedSize !== media.sizeBytes) return false;
  if (
    candidate.sheet_image_content_type !== null
    && normalizeTelegramMediaContentType(candidate.sheet_image_content_type) !== media.contentType
  ) return false;
  return true;
}

function withCutMap(row: LabelRow, cutMap: LabelRowCutMapSnapshot): LabelRow {
  const values: LabelRow['values'] = {
    ...row.values,
    'cut.number': cutMap.cutNumber,
    'cut.job_name': cutMap.cutJobName,
    'cut.sheet_number': cutMap.sheetNumber,
    'cut.variant': cutMap.variant,
  };
  if (isTelegramCutMap(cutMap)) {
    values[`detail.${DETAIL_CUT_RESULT_VERSION_REGULAR_FIELD}`] = cutMap.cutNumber;
  }
  return {
    ...row,
    cutMap,
    values,
  };
}

function telegramPacketCutNumber(
  source: { cutting_sequence_no?: string | number | null },
): string {
  const sequenceNo = nullablePositiveNumber(source.cutting_sequence_no ?? null);
  return sequenceNo === null ? 'Telegram' : `№${sequenceNo}`;
}

function telegramPacketCutJobName(
  source: { cutting_sequence_no?: string | number | null; source_message_id?: string | number | null },
  fallbackLabel: 'Скрин Telegram' | 'Telegram SVG',
): string {
  const sequenceNo = nullablePositiveNumber(source.cutting_sequence_no ?? null);
  if (sequenceNo !== null) return `Раскрой №${sequenceNo}`;
  const sourceMessageId = nullableNumber(source.source_message_id ?? null);
  return sourceMessageId === null ? fallbackLabel : `${fallbackLabel} · ${sourceMessageId}`;
}

function telegramPacketSheetSize(
  source: { sheet_width_mm?: string | number | null; sheet_height_mm?: string | number | null },
): { sheetWidthMm?: number; sheetHeightMm?: number } {
  const sheetWidthMm = nullablePositiveNumber(source.sheet_width_mm ?? null);
  const sheetHeightMm = nullablePositiveNumber(source.sheet_height_mm ?? null);
  return sheetWidthMm === null || sheetHeightMm === null
    ? {}
    : { sheetWidthMm, sheetHeightMm };
}

function assertTelegramSvgPagesLimit(rows: LabelRow[], pages: string[]): void {
  if (!rows.some((row) => row.cutMap?.source === 'telegram_image')) return;
  const bytes = pages.reduce((sum, page) => sum + Buffer.byteLength(page, 'utf8'), 0);
  if (bytes > 96 * 1024 * 1024) {
    throw new ApiError(422, 'LABEL_TELEGRAM_IMAGE_LIMIT_EXCEEDED', 'Rendered Telegram label pages exceed limits');
  }
}

async function addTelegramFallbackOptions(
  client: DatabaseClient,
  orderId: number,
  details: Map<number, OrderLabelCutMapOptionsDto['details'][number]>,
  mediaDir: string,
): Promise<void> {
  const rows: LabelRow[] = [];
  for (const detail of details.values()) {
    for (let copyIndex = 1; copyIndex <= detail.quantity; copyIndex += 1) {
      const hasRegularCutEvidence = detail.options.some((option) => (
        option.instance === copyIndex
        && !option.isArchived
        && option.isVacuum !== true
        && detail.cutJobCutNumber !== null
        && option.cutNumber === detail.cutJobCutNumber
      ));
      if (hasRegularCutEvidence) continue;
      rows.push({
        rowIndex: rows.length + 1,
        orderId,
        detailId: detail.detailId,
        copyIndex,
        copyCount: detail.quantity,
        values: {},
      });
    }
  }
  const resolved = await resolveTelegramFallbackRows(
    client,
    rows,
    new Map(),
    orderId,
    'regular',
    { enabled: true, capability: 'v1', mediaDir, imageMode: 'validate' },
  );
  try {
    for (const row of resolved.rows) {
      const detail = details.get(row.detailId);
      if (!detail || !row.cutMap) continue;
      if (row.cutMap.source === 'telegram_svg') {
        detail.telegramSvgFallbackInstances.push({
          copyIndex: row.copyIndex,
          packetId: row.cutMap.packetId,
          sourceMessageId: row.cutMap.sourceMessageId,
        });
      }
    }
    for (const row of rows) {
      const candidate = resolved.imageCandidates.get(`${row.orderId}:${row.detailId}:${row.copyIndex}`);
      if (candidate) {
        details.get(row.detailId)?.telegramImageFallbackInstances.push({
          copyIndex: row.copyIndex,
          packetId: candidate.packetId,
          sourceMessageId: candidate.sourceMessageId,
        });
      }
      const reason = resolved.unavailable.get(`${row.orderId}:${row.detailId}:${row.copyIndex}`);
      if (reason) {
        details.get(row.detailId)?.telegramImageUnavailableInstances.push({ copyIndex: row.copyIndex, reason });
      }
    }
  } finally {
    await closePreparedTelegramImages(new Set(resolved.preparedImages.values()));
  }
}

function cutMapSourceMatches(isVacuum: boolean, source: LabelCutMapSource): boolean {
  return source === 'bath' ? isVacuum : !isVacuum;
}

function cutMapPlacementMatchesSource(placement: ResolvedCutMapRow, source: LabelCutMapSource): boolean {
  if (!cutMapSourceMatches(placement.is_vacuum === true, source)) return false;
  const expectedCutNumber = source === 'bath' ? placement.vacuum_cut_number : placement.regular_cut_number;
  return expectedCutNumber === formatCutNumber(toNumber(placement.cut_job_id), toNumber(placement.result_no), placement.is_vacuum === true, placement.source_display_number);
}

async function insertGenerationCutPlacements(
  client: DatabaseClient,
  generationId: number,
  rows: LabelRow[],
): Promise<void> {
  const mapped = rows.filter((row): row is LabelRow & { cutMap: CutResultLabelRowCutMapSnapshot } => isCutResultCutMap(row.cutMap));
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

export async function insertGenerationTelegramSources(
  client: DatabaseClient,
  generationId: number,
  rows: LabelRow[],
  preparedImages: Map<string, PreparedTelegramImage>,
): Promise<void> {
  const mapped = rows.filter((row): row is LabelRow & {
    cutMap: TelegramSvgLabelRowCutMapSnapshot | TelegramImageLabelRowCutMapSnapshot;
  } => isTelegramCutMap(row.cutMap));
  const frozenAssetKeys = new Set<string>();
  for (const row of mapped) {
    const cutMap = row.cutMap;
    if (cutMap.source === 'telegram_image' && !frozenAssetKeys.has(cutMap.assetKey)) {
      const prepared = preparedImages.get(cutMap.assetKey);
      if (!prepared) throw new ApiError(409, 'LABEL_TELEGRAM_MEDIA_STALE', 'Prepared Telegram image is missing');
      const packet = await client.query<{
        source_version: string | number;
        sheet_image_storage_key: string | null;
        sheet_image_content_type: string | null;
        sheet_image_size_bytes: string | number | null;
      }>(
        `SELECT source_version, sheet_image_storage_key, sheet_image_content_type, sheet_image_size_bytes
         FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`,
        [cutMap.packetId],
      );
      const current = packet.rows[0];
      if (
        !current
        || Number(current.source_version) !== cutMap.sourceVersion
        || current.sheet_image_storage_key !== prepared.storageKey
        || (
          current.sheet_image_content_type !== null
          && normalizeTelegramMediaContentType(current.sheet_image_content_type) !== prepared.contentType
        )
        || (
          current.sheet_image_size_bytes !== null
          && nullableNumber(current.sheet_image_size_bytes) !== prepared.sizeBytes
        )
      ) {
        throw new ApiError(409, 'LABEL_TELEGRAM_MEDIA_STALE', 'Telegram image changed after preview');
      }
      await verifyPreparedTelegramImage(prepared);
      await client.query(
        `INSERT INTO label_generation_media_asset
           (order_label_generation_id, asset_key, content_type, content_bytes, content_sha256, byte_count)
         VALUES ($1,$2,'image/png',$3,$4,$5)
         ON CONFLICT (order_label_generation_id, asset_key) DO NOTHING`,
        [generationId, cutMap.assetKey, prepared.normalized, cutMap.normalizedSha256, prepared.normalized.length],
      );
      frozenAssetKeys.add(cutMap.assetKey);
    }
    await client.query(
      `INSERT INTO label_generation_telegram_source
         (order_label_generation_id, row_index, detail_id, copy_index, source_kind,
          packet_id, source_version, source_message_id, asset_key, media_asset_key, source_digest,
          telegram_label_sheet_map_id, telegram_label_placement_id)
       VALUES ($1,$2,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13)`,
      [
        generationId,
        row.rowIndex,
        row.detailId,
        row.copyIndex,
        cutMap.source,
        cutMap.packetId,
        cutMap.sourceVersion,
        cutMap.sourceMessageId,
        cutMap.assetKey,
        cutMap.source === 'telegram_image' ? cutMap.assetKey : null,
        cutMap.sourceDigest,
        cutMap.source === 'telegram_svg' ? cutMap.telegramLabelSheetMapId : null,
        cutMap.source === 'telegram_svg' ? cutMap.telegramLabelPlacementId : null,
      ],
    );
  }
}

function isCutResultCutMap(
  value: LabelRowCutMapSnapshot | undefined,
): value is CutResultLabelRowCutMapSnapshot {
  return value !== undefined && (value.source === undefined || value.source === 'cut_result');
}

function isTelegramCutMap(
  value: LabelRowCutMapSnapshot | undefined,
): value is TelegramSvgLabelRowCutMapSnapshot | TelegramImageLabelRowCutMapSnapshot {
  return value?.source === 'telegram_svg' || value?.source === 'telegram_image';
}

async function loadCutMapAssets(
  client: DatabaseClient,
  rows: LabelRow[],
  generationId?: number,
): Promise<LabelCutMapAssets> {
  const assets = new Map<string | number, LabelCutMapAsset | { kind: 'image'; dataUri: string }>();
  const ids = [...new Set(rows.flatMap((row) => isCutResultCutMap(row.cutMap) ? [row.cutMap.cutResultSheetMapId] : []))];
  if (ids.length > 0) {
    const result = await client.query<{
    cut_result_sheet_map_id: string | number;
    base_svg: string;
    is_vacuum: boolean;
    }>(
      `SELECT s.cut_result_sheet_map_id, s.base_svg,
            ${CUT_RESULT_SHEET_IS_VACUUM_SQL} AS is_vacuum
       FROM cut_result_sheet_map s
       JOIN cut_result r ON r.cut_result_id = s.cut_result_id
       JOIN cut_job j ON j.cut_job_id = s.cut_job_id
       LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = j.param_profile_id
       WHERE s.cut_result_sheet_map_id = ANY($1::bigint[])`,
      [ids],
    );
    for (const row of result.rows) {
      const id = toNumber(row.cut_result_sheet_map_id);
      assets.set(`cut_result:${id}`, { kind: 'svg', svg: row.base_svg, isVacuum: row.is_vacuum === true });
    }
  }
  const svgMaps = rows.flatMap((row) => row.cutMap?.source === 'telegram_svg' ? [row.cutMap] : []);
  const svgIds = [...new Set(svgMaps.map((map) => map.telegramLabelSheetMapId))];
  if (svgIds.length > 0) {
    const result = await client.query<{
      telegram_label_sheet_map_id: string | number;
      base_svg: string;
      layout_digest: string;
    }>(
      `SELECT telegram_label_sheet_map_id, base_svg, layout_digest
       FROM cnc_telegram_label_sheet_map
       WHERE telegram_label_sheet_map_id=ANY($1::bigint[])`,
      [svgIds],
    );
    const expected = new Map(svgMaps.map((map) => [map.telegramLabelSheetMapId, map.sourceDigest]));
    for (const row of result.rows) {
      const id = Number(row.telegram_label_sheet_map_id);
      if (expected.get(id) !== row.layout_digest) throw new Error(`Telegram SVG digest mismatch ${id}`);
      assets.set(`telegram_svg:${id}`, { kind: 'svg', svg: row.base_svg, isVacuum: false });
    }
  }
  const imageKeys = [...new Set(rows.flatMap((row) => row.cutMap?.source === 'telegram_image' ? [row.cutMap.assetKey] : []))];
  if (imageKeys.length > 0) {
    if (!generationId) throw new Error('Generation id required for frozen Telegram images');
    const result = await client.query<{
      asset_key: string;
      content_bytes: Buffer;
      content_sha256: string;
      byte_count: string | number;
    }>(
      `SELECT asset_key, content_bytes, content_sha256, byte_count
       FROM label_generation_media_asset
       WHERE order_label_generation_id=$1 AND asset_key=ANY($2::text[])`,
      [generationId, imageKeys],
    );
    for (const row of result.rows) {
      if (row.content_bytes.length !== Number(row.byte_count) || sha256Buffer(row.content_bytes) !== row.content_sha256) {
        throw new Error(`Telegram image digest mismatch ${row.asset_key}`);
      }
      assets.set(row.asset_key, { kind: 'image', dataUri: `data:image/png;base64,${row.content_bytes.toString('base64')}` });
    }
  }
  if (assets.size !== ids.length + svgIds.length + imageKeys.length) {
    throw new Error('Missing frozen cut-map assets');
  }
  return assets;
}

interface PreviewTokenPayload {
  generationScope?: 'order' | 'details';
  orderId?: number;
  templateId: number;
  templateVersion: number;
  detailIds: number[];
  useBasisFields?: boolean;
  cutMapSource?: LabelCutMapSource;
  telegramCutMapFallbackVersion?: 'v1';
  detailInstances?: LabelCutSheetDetailInstanceInput[];
  cutSheetScope?: LabelCutSheetScopeInput;
  cutMapFallbackImage?: LabelCutMapFallbackImageInput;
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

function detailLabelScopeSnapshot(input: PreviewDetailLabelsCommand['input']): Pick<
  PreviewTokenPayload,
  'detailInstances' | 'cutSheetScope' | 'cutMapFallbackImage'
> {
  return {
    ...(input.detailInstances ? { detailInstances: input.detailInstances } : {}),
    ...(input.cutSheetScope ? { cutSheetScope: input.cutSheetScope } : {}),
    ...(input.cutMapFallbackImage ? { cutMapFallbackImage: canonicalCutMapFallbackImage(input.cutMapFallbackImage) } : {}),
  };
}

function detailLabelScopeFromToken(token: PreviewTokenPayload): Pick<
  PreviewTokenPayload,
  'detailInstances' | 'cutSheetScope' | 'cutMapFallbackImage'
> {
  return {
    ...(token.detailInstances ? { detailInstances: token.detailInstances } : {}),
    ...(token.cutSheetScope ? { cutSheetScope: token.cutSheetScope } : {}),
    ...(token.cutMapFallbackImage ? { cutMapFallbackImage: canonicalCutMapFallbackImage(token.cutMapFallbackImage) } : {}),
  };
}

function canonicalCutMapFallbackImage(
  input: LabelCutMapFallbackImageInput,
): LabelCutMapFallbackImageInput {
  return {
    packetId: input.packetId,
    sourceVersion: input.sourceVersion,
    storageKey: input.storageKey,
    contentType: input.contentType ?? null,
    sizeBytes: input.sizeBytes ?? null,
  };
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

function sha256Buffer(value: Buffer): string {
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

async function readIdempotencyReplay<T>(
  client: DatabaseClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<T | null> {
  const existing = await client.query<{ request_hash: string; response_json: T | null; status: string }>(
    `SELECT request_hash, response_json, status
     FROM command_idempotency_keys
     WHERE idempotency_key=$1`,
    [idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request');
  }
  if (row.status === 'completed' && row.response_json !== null) return row.response_json;
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
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
            ${DETAIL_FIELDS_JSON_SQL},
            ld.bazis_fields, ld.custom_fields, ld.custom_field_schema_snapshot, ld.version
     FROM order_details_view od
     ${DETAIL_CUT_RESULT_VERSION_FIELDS_SQL}
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
  options: { quantityMode?: 'requestedCount' | 'actual' } = {},
): Promise<OrderLabelDataDetailDto[]> {
  const uniqueDetailIds = [...new Set(detailIds)];
  const result = await client.query<OrderLabelDetailRow>(
    `SELECT od.detail_id, od.order_id, od.detail_number, od.detail_name, od.height, od.width, od.quantity,
            od.material_name, od.note, od.basis_project, od.basis_data,
            ${DETAIL_FIELDS_JSON_SQL},
            ld.bazis_fields, ld.custom_fields, ld.custom_field_schema_snapshot, ld.version
     FROM order_details_view od
     ${DETAIL_CUT_RESULT_VERSION_FIELDS_SQL}
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
  return uniqueDetailIds.map((detailId) => {
    const detail = byId.get(detailId)!;
    const requestedCount = detailIds.filter((id) => id === detailId).length;
    return {
      ...detail,
      quantity: options.quantityMode === 'actual' ? detail.quantity : requestedCount,
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

function nullablePositiveNumber(value: string | number | null): number | null {
  const parsed = nullableNumber(value);
  return parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
