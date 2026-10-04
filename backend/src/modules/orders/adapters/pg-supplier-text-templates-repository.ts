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
  SetDefaultTemplateCommand,
  SupplierTextTemplateScope,
  TemplateVersionCommand,
  VisibleSupplierTextTemplatesDto,
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
  /** Общий шаблон по умолчанию для компании; у личных всегда false. */
  is_default: boolean;
  version: number;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  /** null — общий шаблон. */
  owner_user_id: string | null;
}

const SHARED_SELECT = `SELECT template_id::text AS template_id, name, body, line_template, is_default, version, updated_at, deleted_at,
         NULL::text AS owner_user_id
    FROM supplier_request_text_templates`;
const OWN_COLUMNS = `template_id::text AS template_id, name, body, line_template, false AS is_default, version, updated_at, deleted_at,
         owner_user_id::text AS owner_user_id`;
const OWN_SELECT = `SELECT ${OWN_COLUMNS} FROM supplier_request_user_text_templates`;
/** Блокировка набора личных шаблонов владельца — перед блокировками строк, у каждой команды (план 2026-10-04 §4). */
const OWNER_LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('supplier_request_user_text_templates:' || $1::text, 0))`;
const SOURCE = 'backend-supplier-text-templates';

const scopeOf = (row: TemplateRow): SupplierTextTemplateScope => (row.owner_user_id === null ? 'shared' : 'own');

function toDto(row: TemplateRow, effectiveDefaultId: number | null): SupplierTextTemplateDto {
  return {
    templateId: Number(row.template_id),
    name: row.name,
    body: row.body,
    lineTemplate: row.line_template,
    isDefault: Number(row.template_id) === effectiveDefaultId,
    version: Number(row.version),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    scope: scopeOf(row),
  };
}

const fingerprint = (value: string) => ({ sha256: createHash('sha256').update(value, 'utf8').digest('hex'), length: value.length });

/**
 * Снимок аудита БЕЗ свободного текста (plan R2-1 базового плана): у имени и текстов — только sha256 и длина; видно,
 * что и когда менялось, содержимое — только в таблице.
 */
export function auditSnapshot(row: TemplateRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    templateId: Number(row.template_id),
    version: Number(row.version),
    scope: scopeOf(row),
    ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id),
    deleted: row.deleted_at !== null,
    name: fingerprint(row.name),
    body: fingerprint(row.body),
    lineTemplate: fingerprint(row.line_template),
  };
}

function invalid(field: string, code: string, detail?: string): ApiError {
  return new ApiError(422, 'SUPPLIER_TEXT_TEMPLATE_INVALID', 'Шаблон не сохранён: проверьте поля', { field, code, detail });
}

/** Проверка полей шаблона (длины и грамматика, базовый план §2). */
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

export const sharedReadOnly = () => new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_SHARED_READ_ONLY',
  'Общий шаблон не изменяется — скопируйте его себе и измените копию');
const notFound = () => new ApiError(404, 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND', 'Шаблон не найден');

/**
 * Шаблоны текста заявки поставщику. Общие (миграция 229) — только чтение; личные (миграция 239) видит и меняет только
 * владелец; у каждого пользователя свой выбор «по умолчанию» (план 2026-10-04). Каждая команда — одна транзакция:
 * актор → ключ повтора → блокировка набора владельца → строка + версия → запись → аудит в той же транзакции →
 * результат в ключ. Идентификатор владельца — всегда актор из сессии, не из запроса. Имена команд в ключах повтора
 * новые (`my_supplier_text_template.*`): ответы команд прежнего маршрута этим кодом не возвращаются.
 */
export class PgSupplierTextTemplatesRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Общие и личные шаблоны пользователя (маршрут личных шаблонов). */
  async listVisible(currentUser: CurrentUser): Promise<VisibleSupplierTextTemplatesDto> {
    // Список и выбор по умолчанию — один снимок: иначе между двумя запросами другой вкладкой можно создать и выбрать
    // шаблон, и ответ получил бы новую ревизию без шаблона по умолчанию в списке (code review R1-2).
    return this.database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return this.visibleTemplates(tx, Number(currentUser.id));
    });
  }

  /** Только общие шаблоны — прежний маршрут для FE до личных шаблонов; `isDefault` — общий по умолчанию. */
  async listShared(): Promise<SupplierTextTemplateDto[]> {
    const rows = (await this.database.query<TemplateRow>(
      `${SHARED_SELECT} WHERE deleted_at IS NULL ORDER BY is_default DESC, lower(name), template_id`)).rows;
    const shared = rows.find((row) => row.is_default);
    return rows.map((row) => toDto(row, shared ? Number(shared.template_id) : null));
  }

  async create(command: CreateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto> {
    const input = validateInput(command) as { name: string; body: string; lineTemplate: string };
    return this.command(command, 'my_supplier_text_template.create', { ...input }, async (tx, actor) => {
      const active = Number((await tx.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM supplier_request_user_text_templates WHERE owner_user_id = $1 AND deleted_at IS NULL',
        [actor.userId])).rows[0].count);
      if (active >= SUPPLIER_TEXT_LIMITS.ownTemplates) {
        throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_LIMIT', `Не больше ${SUPPLIER_TEXT_LIMITS.ownTemplates} своих шаблонов`);
      }
      await this.assertNameFree(tx, actor.userId, input.name, null);
      const row = (await tx.query<TemplateRow>(
        `INSERT INTO supplier_request_user_text_templates (owner_user_id, name, body, line_template, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $1, $1)
         RETURNING ${OWN_COLUMNS}`,
        [actor.userId, input.name, input.body, input.lineTemplate],
      )).rows[0];
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_created', Number(row.template_id), null, auditSnapshot(row)!);
      return { changed: true, templateId: Number(row.template_id) };
    });
  }

  async update(command: UpdateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto> {
    const input = validateInput(command);
    return this.command(command, 'my_supplier_text_template.update', { templateId: command.templateId, expectedVersion: command.expectedVersion, ...input }, async (tx, actor) => {
      const before = await this.lockOwn(tx, actor.userId, command.templateId, command.expectedVersion);
      const next = { name: input.name ?? before.name, body: input.body ?? before.body, lineTemplate: input.lineTemplate ?? before.line_template };
      if (next.name === before.name && next.body === before.body && next.lineTemplate === before.line_template) {
        return { changed: false, templateId: command.templateId };
      }
      if (next.name !== before.name) await this.assertNameFree(tx, actor.userId, next.name, command.templateId);
      const after = (await tx.query<TemplateRow>(
        `UPDATE supplier_request_user_text_templates
            SET name = $3, body = $4, line_template = $5, version = version + 1, updated_at = now(), updated_by = $2
          WHERE template_id = $1 AND owner_user_id = $2
          RETURNING ${OWN_COLUMNS}`,
        [command.templateId, actor.userId, next.name, next.body, next.lineTemplate],
      )).rows[0];
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_updated', command.templateId, auditSnapshot(before), auditSnapshot(after)!);
      return { changed: true, templateId: command.templateId };
    });
  }

  async remove(command: TemplateVersionCommand): Promise<SupplierTextTemplateCommandResultDto> {
    return this.command(command, 'my_supplier_text_template.delete', { templateId: command.templateId, expectedVersion: command.expectedVersion }, async (tx, actor) => {
      const before = await this.lockOwn(tx, actor.userId, command.templateId, command.expectedVersion);
      // Удаляемый шаблон был личным выбором по умолчанию — выбор снимается (ревизия растёт), дальше действует общий.
      const wasDefault = ((await tx.query(
        `UPDATE supplier_request_text_template_defaults
            SET own_template_id = NULL, revision = revision + 1, updated_at = now()
          WHERE user_id = $1 AND own_template_id = $2`,
        [actor.userId, command.templateId])).rowCount ?? 0) > 0;
      const after = (await tx.query<TemplateRow>(
        `UPDATE supplier_request_user_text_templates
            SET deleted_at = now(), deleted_by = $2, version = version + 1, updated_at = now(), updated_by = $2
          WHERE template_id = $1 AND owner_user_id = $2
          RETURNING ${OWN_COLUMNS}`,
        [command.templateId, actor.userId],
      )).rows[0];
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_deleted', command.templateId,
        auditSnapshot(before), auditSnapshot(after)!, { wasPersonalDefault: wasDefault });
      return { changed: true, templateId: null };
    });
  }

  async setDefault(command: SetDefaultTemplateCommand): Promise<SupplierTextTemplateCommandResultDto> {
    const payload = { templateId: command.templateId, expectedVersion: command.expectedVersion, expectedDefaultRevision: command.expectedDefaultRevision };
    return this.command(command, 'my_supplier_text_template.default', payload, async (tx, actor) => {
      // Цель: свой личный (FOR UPDATE) или общий (FOR SHARE — не должен исчезнуть до записи выбора); чужой личный — 404.
      const target = await this.findVisible(tx, actor.userId, command.templateId, 'FOR SHARE');
      if (!target) throw notFound();
      assertVersion(target, command.expectedVersion);
      // Ревизия выбора — после сохранённого результата ключа (он проверен в `command`): выполненная команда
      // возвращает свой результат, а не дошедшая до сервера и устаревшая — не затирает более поздний выбор (R4-1).
      const state = await this.defaultState(tx, actor.userId);
      if (state.revision !== command.expectedDefaultRevision) {
        throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_CONFLICT', 'Шаблон по умолчанию уже меняли — обновите список', {
          expectedDefaultRevision: command.expectedDefaultRevision, currentDefaultRevision: state.revision,
        });
      }
      const previousId = state.effectiveId;
      if (previousId === command.templateId) return { changed: false, templateId: command.templateId };
      // Выбран общий шаблон по умолчанию — личная цель не нужна (возврат к общему правилу), но ревизия растёт.
      const sharedDefault = scopeOf(target) === 'shared' && target.is_default;
      await tx.query(
        `INSERT INTO supplier_request_text_template_defaults (user_id, shared_template_id, own_template_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET shared_template_id = EXCLUDED.shared_template_id, own_template_id = EXCLUDED.own_template_id,
               revision = supplier_request_text_template_defaults.revision + 1, updated_at = now()`,
        [actor.userId, !sharedDefault && scopeOf(target) === 'shared' ? command.templateId : null, scopeOf(target) === 'own' ? command.templateId : null],
      );
      await this.audit(tx, command, actor, 'procurement.supplier_text_template_default_changed', command.templateId,
        { userId: actor.userId, effectiveDefaultTemplateId: previousId },
        { userId: actor.userId, effectiveDefaultTemplateId: command.templateId },
        { userId: actor.userId, previousTemplateId: previousId, scope: scopeOf(target) },
        previousId === null ? [] : [previousId]);
      return { changed: true, templateId: command.templateId };
    });
  }

  private async command(
    command: { currentUser: CurrentUser; commandKey: string },
    name: string,
    payload: unknown,
    work: (tx: DatabaseClient, actor: Actor) => Promise<{ changed: boolean; templateId: number | null }>,
  ): Promise<SupplierTextTemplateCommandResultDto> {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const stored = await claimCommandKey(tx, command.commandKey, name, actor.userId, bodyHash(payload));
      if (stored) return stored as SupplierTextTemplateCommandResultDto;
      await tx.query(OWNER_LOCK, [actor.userId]);
      const partial = await work(tx, actor);
      const { templates, defaultRevision } = await this.visibleTemplates(tx, actor.userId);
      const result: SupplierTextTemplateCommandResultDto = {
        changed: partial.changed,
        template: partial.templateId === null ? null : templates.find((template) => template.templateId === partial.templateId) ?? null,
        templates,
        defaultRevision,
      };
      await tx.query('UPDATE procurement_command_keys SET result_json = $2::jsonb WHERE request_id = $1', [command.commandKey, JSON.stringify(result)]);
      return result;
    });
  }

  /** Общие активные шаблоны и личные активные шаблоны ЭТОГО пользователя; действующий по умолчанию — первым. */
  private async visibleTemplates(client: Pick<DatabaseClient, 'query'>, userId: number): Promise<VisibleSupplierTextTemplatesDto> {
    const rows = (await client.query<TemplateRow>(
      `${SHARED_SELECT} WHERE deleted_at IS NULL
       UNION ALL
       ${OWN_SELECT} WHERE owner_user_id = $1 AND deleted_at IS NULL`, [userId])).rows;
    const state = await this.defaultState(client, userId);
    const rank = (template: SupplierTextTemplateDto) => (template.isDefault ? 0 : template.scope === 'own' ? 1 : 2);
    return {
      templates: rows.map((row) => toDto(row, state.effectiveId)).sort((left, right) => rank(left) - rank(right)
        || left.name.toLowerCase().localeCompare(right.name.toLowerCase(), 'ru') || left.templateId - right.templateId),
      defaultRevision: state.revision,
    };
  }

  /**
   * Действующий шаблон по умолчанию (личный выбор, если он указывает на активный видимый шаблон; иначе общий по
   * умолчанию) и ревизия личного выбора (0 — строки выбора ещё нет).
   */
  private async defaultState(client: Pick<DatabaseClient, 'query'>, userId: number): Promise<{ effectiveId: number | null; revision: number }> {
    const row = (await client.query<{ template_id: string | null; revision: number }>(
      `SELECT COALESCE(
         (SELECT COALESCE(s.template_id, o.template_id)
            FROM supplier_request_text_template_defaults d
            LEFT JOIN supplier_request_text_templates s ON s.template_id = d.shared_template_id AND s.deleted_at IS NULL
            LEFT JOIN supplier_request_user_text_templates o
              ON o.template_id = d.own_template_id AND o.owner_user_id = d.user_id AND o.deleted_at IS NULL
           WHERE d.user_id = $1),
         (SELECT template_id FROM supplier_request_text_templates WHERE is_default AND deleted_at IS NULL LIMIT 1)
       )::text AS template_id,
       COALESCE((SELECT revision FROM supplier_request_text_template_defaults WHERE user_id = $1), 0)::int AS revision`, [userId])).rows[0];
    return { effectiveId: row?.template_id == null ? null : Number(row.template_id), revision: Number(row?.revision ?? 0) };
  }

  /** Активный шаблон, видимый пользователю: свой личный (всегда FOR UPDATE) или общий (с `sharedLock`). */
  private async findVisible(tx: DatabaseClient, userId: number, templateId: number, sharedLock: '' | 'FOR SHARE'): Promise<TemplateRow | null> {
    const own = (await tx.query<TemplateRow>(
      `${OWN_SELECT} WHERE template_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [templateId, userId])).rows[0];
    if (own) return own;
    return (await tx.query<TemplateRow>(`${SHARED_SELECT} WHERE template_id = $1 AND deleted_at IS NULL ${sharedLock}`, [templateId])).rows[0] ?? null;
  }

  /** Цель команды записи: только свой личный шаблон. Общий — 409 (только чтение); чужой личный и несуществующий — 404. */
  private async lockOwn(tx: DatabaseClient, userId: number, templateId: number, expectedVersion: number): Promise<TemplateRow> {
    const row = await this.findVisible(tx, userId, templateId, '');
    if (!row) throw notFound();
    if (scopeOf(row) === 'shared') throw sharedReadOnly();
    assertVersion(row, expectedVersion);
    return row;
  }

  private async assertNameFree(tx: DatabaseClient, userId: number, name: string, exceptId: number | null): Promise<void> {
    const taken = (await tx.query(
      `SELECT 1 FROM supplier_request_user_text_templates
        WHERE owner_user_id = $1 AND deleted_at IS NULL AND lower(btrim(name)) = lower(btrim($2))
          AND ($3::bigint IS NULL OR template_id <> $3)`,
      [userId, name, exceptId],
    )).rowCount;
    if (taken) throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_NAME_TAKEN', 'У вас уже есть шаблон с таким названием');
  }

  private async audit(
    tx: DatabaseClient,
    command: { currentUser: CurrentUser; requestId: string },
    actor: Actor,
    event: string,
    templateId: number,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    metadata: Record<string, unknown> = {},
    relatedTemplateIds: number[] = [],
  ): Promise<void> {
    await auditService.record(tx, {
      event,
      entityType: 'supplier_text_template',
      entityId: templateId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: command.currentUser.role,
      requestId: command.requestId,
      source: SOURCE,
      before,
      after,
      diff: computeDiff(before, after),
      metadata: { templateId, ownerUserId: actor.userId, ...metadata },
      relatedEntities: [
        { entityType: 'supplier_text_template', entityId: templateId },
        ...relatedTemplateIds.map((id) => ({ entityType: 'supplier_text_template', entityId: id })),
        { entityType: 'user', entityId: actor.userId },
      ],
    });
  }
}

function assertVersion(row: TemplateRow, expectedVersion: number): void {
  if (Number(row.version) !== expectedVersion) {
    throw new ApiError(409, 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT', 'Шаблон изменился — обновите список', {
      expectedVersion, currentVersion: Number(row.version),
    });
  }
}
