import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import { DatabaseService } from '../../../database/database.service';
import { actorId } from '../application/labels.service';
import { buildLabelRows, hashLabelRows, type LabelRow } from '../application/label-row-builder';
import { renderLabelsZip, renderSvgPages } from '../application/label-renderer';
import type {
  CreateLabelQrTemplateCommand,
  CreateLabelTemplateCommand,
  DeleteLabelQrTemplateCommand,
  DeleteLabelTemplateCommand,
  ExportOrderLabelsQuery,
  ExportDetailLabelsQuery,
  GenerateOrderLabelsCommand,
  GenerateDetailLabelsCommand,
  GetOrderLabelDataQuery,
  GetLabelTemplateQuery,
  LabelExportFormat,
  LabelQrTemplateDto,
  LabelTemplateDto,
  LabelTemplateElementDto,
  LabelTemplateElementInput,
  LabelsPermissionDeniedInput,
  LabelsPort,
  DetailLabelsPreviewDto,
  LatestOrderLabelsPreviewDto,
  ListLabelQrTemplatesQuery,
  ListLabelTemplatesQuery,
  OrderLabelDataDetailDto,
  OrderLabelDataDto,
  OrderLabelGenerationDto,
  OrderLabelsPreviewDto,
  PreviewDetailLabelsCommand,
  PreviewOrderLabelsCommand,
  ScanCandidateRow,
  ScanSearchInput,
  UpdateLabelQrTemplateCommand,
  UpdateOrderLabelDataCommand,
  UpdateLabelTemplateCommand,
} from '../application/labels.types';
import {
  LabelCustomFieldSchemaStaleError,
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
}

interface ElementRow extends QueryResultRow {
  label_template_element_id: string | number;
  element_key: string;
  kind: 'text' | 'line' | 'rect' | 'qr';
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

const TEMPLATE_COLUMNS = `label_template_id, name, description, version, is_active,
  canvas_width_mm, canvas_height_mm, dpi, default_export_formats, custom_field_schema`;

const QR_TEMPLATE_COLUMNS = `label_qr_template_id, name, content_template, error_correction,
  default_size_mm, is_active, version`;

interface QrTemplateRow extends QueryResultRow {
  label_qr_template_id: string | number;
  name: string;
  content_template: string;
  error_correction: string;
  default_size_mm: string | number;
  is_active: boolean;
  version: string | number;
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

export class PgLabelsRepository implements LabelsPort {
  constructor(private readonly database: DatabaseService) {}

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
    return templates.map((template) => ({ ...template, elements: elementsByTemplate.get(template.labelTemplateId) ?? [] }));
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
           custom_field_schema, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6::text[],$7::jsonb,$8,$8)
         RETURNING ${TEMPLATE_COLUMNS}`,
        [
          input.name,
          input.description ?? null,
          input.canvasWidthMm,
          input.canvasHeightMm,
          input.dpi,
          input.defaultExportFormats,
          JSON.stringify(input.customFieldSchema),
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
           version=version+1, updated_by=$9, updated_at=now()
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
            (name, content_template, error_correction, default_size_mm, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$5)
           RETURNING ${QR_TEMPLATE_COLUMNS}`,
          [input.name, input.contentTemplate, input.errorCorrection, input.defaultSizeMm,
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
             version=version+1, updated_by=$6, updated_at=now()
           WHERE label_qr_template_id=$1
           RETURNING ${QR_TEMPLATE_COLUMNS}`,
          [
            command.id,
            input.name,
            input.contentTemplate,
            input.errorCorrection,
            input.defaultSizeMm,
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
    const rows = buildLabelRows({ orderName, orderFields, template, details, useBasisFields });
    const rowHash = hashLabelRows(rows);
    const svgPages = renderSvgPages(template, rows).pages;
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
      const template = await this.readTemplate(tx, command.input.templateId, true, true);
      assertTemplateVersion(template.version, command.input.templateVersion);
      const detailIds = command.input.detailFilters?.detailIds ?? [];
      const useBasisFields = command.input.useBasisFields ?? true;
      await assertOrderExists(tx, command.orderId);
      await assertDetailsBelongToOrder(tx, command.orderId, detailIds);
      const orderFields = await readOrderFields(tx, command.orderId);
      const orderName = readOrderNameFromFields(orderFields);
      const details = filterDetails(
        await readOrderLabelDetails(tx, command.orderId, template.labelTemplateId, template.customFieldSchema),
        detailIds,
      );
      const rows = buildLabelRows({ orderName, orderFields, template, details, useBasisFields });
      const rowHash = hashLabelRows(rows);
      const token = decodePreviewToken(command.input.previewToken);
      if (
        token.orderId !== command.orderId ||
        token.templateId !== template.labelTemplateId ||
        token.templateVersion !== template.version ||
        token.rowHash !== rowHash ||
        JSON.stringify(token.detailIds ?? []) !== JSON.stringify(detailIds) ||
        (token.useBasisFields ?? true) !== useBasisFields
      ) {
        throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
      }

      const requestHash = hashRequest({
          orderId: command.orderId,
          templateId: template.labelTemplateId,
          templateVersion: template.version,
          detailIds,
          useBasisFields,
          rowHash,
          exportFormats: command.input.exportFormats,
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
      if (existing) {
        return existing;
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
        after: { ...generation, exportFormats: command.input.exportFormats },
        diff: { labelCount: generation.labelCount },
        metadata: { idempotencyKey: command.input.idempotencyKey },
        relatedEntities: [
          { entityType: 'order_label_generation', entityId: generation.generationId },
          ...details.map((detail) => ({ entityType: 'order_detail', entityId: detail.detailId })),
        ],
      });
      await tx.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('order_labels.generated','order',$1,$2::jsonb,$3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          command.orderId,
          JSON.stringify({ ...generation, templateId: template.labelTemplateId }),
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
    const svgPages = renderSvgPages(template, rows).pages;
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
      const template = await this.readTemplate(tx, command.input.templateId, true, true);
      assertTemplateVersion(template.version, command.input.templateVersion);
      const detailIds = command.input.detailIds;
      const useBasisFields = command.input.useBasisFields ?? true;
      const details = await readDetailLabelDetails(tx, detailIds, template.labelTemplateId, template.customFieldSchema);
      const rows = buildLabelRows({ orderName: null, template, details, useBasisFields });
      const rowHash = hashLabelRows(rows);
      const token = decodePreviewToken(command.input.previewToken);
      if (
        token.generationScope !== 'details' ||
        token.templateId !== template.labelTemplateId ||
        token.templateVersion !== template.version ||
        token.rowHash !== rowHash ||
        JSON.stringify(token.detailIds ?? []) !== JSON.stringify(detailIds) ||
        (token.useBasisFields ?? true) !== useBasisFields
      ) {
        throw new ApiError(409, 'LABEL_PREVIEW_TOKEN_STALE', 'Label preview token is stale');
      }

      const requestHash = hashRequest({
        generationScope: 'details',
        templateId: template.labelTemplateId,
        templateVersion: template.version,
        detailIds,
        useBasisFields,
        rowHash,
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
      if (existing) {
        return existing;
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
    });
    return {
      filename: `order-${query.orderId}-labels-${generation.generationId}.zip`,
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
    });
    return {
      filename: `labels-generation-${generation.generationId}.zip`,
      contentType: 'application/zip',
      body,
    };
  }

  async getLatestOrderLabelsPreview(query: ExportOrderLabelsQuery): Promise<LatestOrderLabelsPreviewDto> {
    const generation = await readLatestGeneration(this.database, query.orderId);
    const svgPages = renderSvgPages(generation.template, generation.rows).pages;
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
    return { ...template, elements };
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
    // narrow-then-verify. Read-surface = order_details_view (тот же, что остальные
    // label-read пути этого файла: см. readOrderLabelDetails ~:1295) + явный guard
    // orders.delete_flag=false (паттерн ~:1261). Снапшот печати НЕ «существование
    // строки», а РЕАЛЬНОЕ containment-совпадение распарсенных bazis-полей.
    const hasBazis = input.bazisFields != null && Object.keys(input.bazisFields).length > 0;
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    const conditions: string[] = [];
    if (input.detailId != null) conditions.push(`od.detail_id = ${p(input.detailId)}`);
    if (input.orderId != null) conditions.push(`od.order_id = ${p(input.orderId)}`);
    if (input.orderName) conditions.push(`lower(o.order_name) = lower(${p(input.orderName)})`);
    // Источник 2: заказ переименовали после печати — ищем по снапшоту.
    if (hasBazis) {
      conditions.push(`ld_match.detail_id IS NOT NULL`);
    }
    if (conditions.length === 0) return []; // защита от полного скана

    const detailNumberParam = input.detailNumber != null ? p(input.detailNumber) : null;
    const bazisParam = hasBazis ? p(JSON.stringify(input.bazisFields)) : null;

    const result = await this.database.query<ScanCandidateQueryRow>(
      `SELECT od.detail_id, od.order_id, o.order_name, od.detail_number,
              od.width, od.height, od.quantity, od.material_name,
              ps.production_status_name,
              ${bazisParam ? `(ld_match.detail_id IS NOT NULL) AS snapshot_match` : `FALSE AS snapshot_match`}
              ${detailNumberParam ? `, (od.detail_number = ${detailNumberParam}) AS detail_number_match` : ''}
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
    );

    return result.rows.map((row) => {
      const matched: string[] = [];
      if (input.detailId != null && toNumber(row.detail_id) === input.detailId) matched.push('detail_id');
      if (input.orderId != null && toNumber(row.order_id) === input.orderId) matched.push('order_id');
      if (input.orderName && (row.order_name ?? '').toLowerCase() === input.orderName.toLowerCase()) matched.push('order_name');
      if (detailNumberParam && row.detail_number_match === true) matched.push('detail_number');
      if (row.snapshot_match === true) matched.push('snapshot');
      return {
        detailId: toNumber(row.detail_id),
        orderId: toNumber(row.order_id),
        orderName: row.order_name ?? '',
        detailNumber: row.detail_number == null ? null : Number(row.detail_number),
        width: nullableNumber(row.width),
        height: nullableNumber(row.height),
        quantity: nullableNumber(row.quantity),
        materialName: row.material_name,
        productionStatusName: row.production_status_name,
        matchedFields: matched,
      };
    });
  }
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
