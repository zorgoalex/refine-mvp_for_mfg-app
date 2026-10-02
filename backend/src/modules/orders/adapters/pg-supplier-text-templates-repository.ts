import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CreateSupplierTextTemplateCommand,
  SupplierTextTemplateCommandResultDto,
  SupplierTextTemplateDto,
  TemplateVersionCommand,
  UpdateSupplierTextTemplateCommand,
} from '../application/supplier-text-templates.types';
import { SUPPLIER_TEXT_LIMITS, validateTemplate } from '../domain/supplier-text-template';
import { lockActor, type Actor } from './pg-order-resource-procurement-repository';
import { claimCommandKey } from './pg-supplier-requests-repository';

interface TemplateRow extends QueryResultRow {
  template_id: string;
  name: string;
  body: string;
  line_template: string;
  is_default: boolean;
  version: number;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

const SELECT = `SELECT template_id::text AS template_id, name, body, line_template, is_default, version, updated_at, deleted_at
  FROM supplier_request_text_templates`;
/** Общая блокировка набора шаблонов — перед блокировками строк, у каждой команды (план §3.1). */
const SET_LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('supplier_request_text_templates', 0))`;
const SOURCE = 'backend-supplier-text-templates';

function toDto(row: TemplateRow): SupplierTextTemplateDto {
  return {
    templateId: Number(row.template_id),
    name: row.name,
    body: row.body,
    lineTemplate: row.line_template,
    isDefault: row.is_default,
    version: Number(row.version),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  };
}

const fingerprint = (value: string) => ({ sha256: createHash('sha256').update(value, 'utf8').digest('hex'), length: value.length });

/**
 * Снимок аудита БЕЗ свободного текста (plan R2-1): у имени и текстов — только sha256 и длина; видно, что и когда
 * менялось, содержимое — только в таблице.
 */
export function auditSnapshot(row: TemplateRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    templateId: Number(row.template_id),
    version: Number(row.version),
    isDefault: row.is_default,
    deleted: row.deleted_at !== null,
    name: fingerprint(row.name),
    body: fingerprint(row.body),
    lineTemplate: fingerprint(row.line_template),
  };
}

function invalid(field: string, code: string, detail?: string): ApiError {
  return new ApiError(422, 'SUPPLIER_TEXT_TEMPLATE_INVALID', 'Шаблон не сохранён: проверьте поля', { field, code, detail });
}

/** Проверка полей шаблона (длины и грамматика, план §2). */
export function validateInput(input: { name?: string; body?: string; lineTemplate?: string }): { name?: string; body?: string; lineTemplate?: string } {
  const out: { name?: string; body?: string; lineTemplate?: string } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 1 || name.length > SUPPLIER_TEXT_LIMITS.name) throw invalid('name', 'LENGTH');
    out.name = name;
  }
  if (input.body !== undefined) {
    if (input.body.trim().length < 1 || input.body.length > SUPPLIER_TEXT_LIMITS.body) throw invalid('body', 'LENGTH');
    const error = validateTemplate(input.body, 'body');
    if (error) throw invalid('body', error.code, error.detail);
    out.body = input.body;
  }
  if (input.lineTemplate !== undefined) {
    if (input.lineTemplate.trim().length < 1 || input.lineTemplate.length > SUPPLIER_TEXT_LIMITS.line) throw invalid('lineTemplate', 'LENGTH');
    const error = validateTemplate(input.lineTemplate, 'line');
    if (error) throw invalid('lineTemplate', error.code, error.detail);
    out.lineTemplate = input.lineTemplate;
  }
  return out;
}

const bodyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/**
 * Шаблоны текста заявки поставщику (план 2026-10-02 §3–5): каждая команда — одна транзакция: актор → ключ повтора →
 * блокировка набора → строка FOR UPDATE + версия → запись → аудит в той же транзакции → результат в ключ.
 */
export class PgSupplierTextTemplatesRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<SupplierTextTemplateDto[]> {
    return (await this.database.query<TemplateRow>(`${SELECT} WHERE deleted_at IS NULL ORDER BY is_default DESC, lower(name), template_id`)).rows.map(toDto);
  }

  async create(command: CreateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto> {
    const input = validateInput(command) as { name: string; body: string; lineTemplate: string };
    return this.command(command, 'supplier_text_template.create', { ...input }, async (tx, actor) => {
      const active = Number((await tx.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM supplier_request_text_templates WHERE deleted_at IS NULL')).rows[0].count);
      if (active >= SUPPLIER_TEXT_LIMITS.activeTemplates) {
        throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_LIMIT', `Не больше ${SUPPLIER_TEXT_LIMITS.activeTemplates} шаблонов`);
      }
      await this.assertNameFree(tx, input.name, null);
      const row = (await tx.query<TemplateRow>(
        `INSERT INTO supplier_request_text_templates (name, body, line_template, is_default, created_by, updated_by)
         VALUES ($1, $2, $3, false, $4, $4)
         RETURNING template_id::text AS template_id, name, body, line_template, is_default, version, updated_at, deleted_at`,
        [input.name, input.body, input.lineTemplate, actor.userId],
      )).rows[0];
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_created', Number(row.template_id), null, row);
      return { changed: true, template: toDto(row) };
    });
  }

  async update(command: UpdateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto> {
    const input = validateInput(command);
    return this.command(command, 'supplier_text_template.update', { templateId: command.templateId, expectedVersion: command.expectedVersion, ...input }, async (tx, actor) => {
      const before = await this.lockTarget(tx, command.templateId, command.expectedVersion);
      const next = { name: input.name ?? before.name, body: input.body ?? before.body, lineTemplate: input.lineTemplate ?? before.line_template };
      if (next.name === before.name && next.body === before.body && next.lineTemplate === before.line_template) {
        return { changed: false, template: toDto(before) };
      }
      if (next.name !== before.name) await this.assertNameFree(tx, next.name, command.templateId);
      const after = (await tx.query<TemplateRow>(
        `UPDATE supplier_request_text_templates
            SET name = $2, body = $3, line_template = $4, version = version + 1, updated_at = now(), updated_by = $5
          WHERE template_id = $1
          RETURNING template_id::text AS template_id, name, body, line_template, is_default, version, updated_at, deleted_at`,
        [command.templateId, next.name, next.body, next.lineTemplate, actor.userId],
      )).rows[0];
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_updated', command.templateId, before, after);
      return { changed: true, template: toDto(after) };
    });
  }

  async remove(command: TemplateVersionCommand): Promise<SupplierTextTemplateCommandResultDto> {
    return this.command(command, 'supplier_text_template.delete', { templateId: command.templateId, expectedVersion: command.expectedVersion }, async (tx, actor) => {
      const before = await this.lockTarget(tx, command.templateId, command.expectedVersion);
      if (before.is_default) {
        throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_DELETE', 'Шаблон по умолчанию не удаляется — сначала назначьте другой');
      }
      const active = Number((await tx.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM supplier_request_text_templates WHERE deleted_at IS NULL')).rows[0].count);
      if (active <= 1) throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_LAST_DELETE', 'Последний шаблон не удаляется');
      const after = (await tx.query<TemplateRow>(
        `UPDATE supplier_request_text_templates
            SET deleted_at = now(), deleted_by = $2, version = version + 1, updated_at = now(), updated_by = $2
          WHERE template_id = $1
          RETURNING template_id::text AS template_id, name, body, line_template, is_default, version, updated_at, deleted_at`,
        [command.templateId, actor.userId],
      )).rows[0];
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_deleted', command.templateId, before, after);
      return { changed: true, template: null };
    });
  }

  async setDefault(command: TemplateVersionCommand): Promise<SupplierTextTemplateCommandResultDto> {
    return this.command(command, 'supplier_text_template.default', { templateId: command.templateId, expectedVersion: command.expectedVersion }, async (tx, actor) => {
      const target = await this.lockTarget(tx, command.templateId, command.expectedVersion);
      if (target.is_default) return { changed: false, template: toDto(target) };
      const previous = (await tx.query<TemplateRow>(
        `${SELECT} WHERE is_default AND deleted_at IS NULL FOR UPDATE`)).rows[0] ?? null;
      // Снять и поставить — в одной транзакции, версии обеих строк +1 (план §3.1).
      if (previous) {
        await tx.query(
          `UPDATE supplier_request_text_templates SET is_default = false, version = version + 1, updated_at = now(), updated_by = $2
            WHERE template_id = $1`, [previous.template_id, actor.userId]);
      }
      const after = (await tx.query<TemplateRow>(
        `UPDATE supplier_request_text_templates SET is_default = true, version = version + 1, updated_at = now(), updated_by = $2
          WHERE template_id = $1
          RETURNING template_id::text AS template_id, name, body, line_template, is_default, version, updated_at, deleted_at`,
        [command.templateId, actor.userId],
      )).rows[0];
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_default_changed', command.templateId, target, after, {
        previousDefaultTemplateId: previous ? Number(previous.template_id) : null,
        defaultTemplateId: command.templateId,
      }, previous ? [Number(previous.template_id)] : []);
      return { changed: true, template: toDto(after) };
    });
  }

  private async command(
    command: { currentUser: CurrentUser; commandKey: string },
    name: string,
    payload: unknown,
    work: (tx: DatabaseClient, actor: Actor) => Promise<{ changed: boolean; template: SupplierTextTemplateDto | null }>,
  ): Promise<SupplierTextTemplateCommandResultDto> {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const stored = await claimCommandKey(tx, command.commandKey, name, actor.userId, bodyHash(payload));
      if (stored) return stored as SupplierTextTemplateCommandResultDto;
      await tx.query(SET_LOCK);
      const partial = await work(tx, actor);
      const templates = (await tx.query<TemplateRow>(
        `${SELECT} WHERE deleted_at IS NULL ORDER BY is_default DESC, lower(name), template_id`)).rows.map(toDto);
      const result: SupplierTextTemplateCommandResultDto = { ...partial, templates };
      await tx.query('UPDATE procurement_command_keys SET result_json = $2::jsonb WHERE request_id = $1', [command.commandKey, JSON.stringify(result)]);
      return result;
    });
  }

  private async lockTarget(tx: DatabaseClient, templateId: number, expectedVersion: number): Promise<TemplateRow> {
    const row = (await tx.query<TemplateRow>(`${SELECT} WHERE template_id = $1 AND deleted_at IS NULL FOR UPDATE`, [templateId])).rows[0];
    if (!row) throw new ApiError(404, 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND', 'Шаблон не найден');
    if (Number(row.version) !== expectedVersion) {
      throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT', 'Шаблон изменился — обновите список', {
        expectedVersion, currentVersion: Number(row.version),
      });
    }
    return row;
  }

  private async assertNameFree(tx: DatabaseClient, name: string, exceptId: number | null): Promise<void> {
    const taken = (await tx.query(
      `SELECT 1 FROM supplier_request_text_templates
        WHERE deleted_at IS NULL AND lower(btrim(name)) = lower(btrim($1)) AND ($2::bigint IS NULL OR template_id <> $2)`,
      [name, exceptId],
    )).rowCount;
    if (taken) throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_NAME_TAKEN', 'Шаблон с таким названием уже есть');
  }

  private async audit(
    tx: DatabaseClient,
    command: { currentUser: CurrentUser; requestId: string },
    actor: Actor,
    event: string,
    templateId: number,
    before: TemplateRow | null,
    after: TemplateRow,
    metadata: Record<string, unknown> = {},
    relatedTemplateIds: number[] = [],
  ): Promise<void> {
    const beforeSnapshot = auditSnapshot(before);
    const afterSnapshot = auditSnapshot(after)!;
    await auditService.record(tx, {
      event,
      entityType: 'supplier_text_template',
      entityId: templateId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: command.currentUser.role,
      requestId: command.requestId,
      source: SOURCE,
      before: beforeSnapshot,
      after: afterSnapshot,
      diff: computeDiff(beforeSnapshot, afterSnapshot),
      metadata: { templateId, ...metadata },
      relatedEntities: [
        { entityType: 'supplier_text_template', entityId: templateId },
        ...relatedTemplateIds.map((id) => ({ entityType: 'supplier_text_template', entityId: id })),
      ],
    });
  }
}
