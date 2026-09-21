import { z } from 'zod';
import type { Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import type { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import type { Bitrix24OAuthTokenService } from '../reverse/bitrix24-oauth-token.service';
import type { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import {
  StageRepository,
  type StageActor,
  type StageApproval,
  type StageCatalog,
  type StageJob,
} from './stage-repository';
import {
  normalizeStages,
  provisioningRows,
  stageError,
  targetStage,
  verifyDeal,
  type StageConfig,
} from './stage-policy';
import { safeBitrixError } from '../../audit/application/bitrix-audit-sanitization';

export const stageSettingsSchema = z
  .object({
    version: z.number().int().positive(),
    categoryId: z.number().int().nonnegative(),
    completedStatusId: z.number().int().positive(),
    enabled: z.boolean(),
    mappings: z
      .array(
        z
          .object({
            orderStatusId: z.number().int().positive(),
            stageId: z.string().min(1).max(100),
          })
          .strict()
      )
      .max(500),
  })
  .strict();
type StageSettings = z.infer<typeof stageSettingsSchema>;
export interface StatusReference {
  id: number;
  name: string;
  code: string;
  color: string;
  active: boolean;
  used: boolean;
}
const approvalSchema = z.object({
  orderId: z.string(),
  statusId: z.number(),
  orderVersion: z.number(),
  bitrixId: z.string(),
  observed: z.string(),
  target: z.string(),
  configVersion: z.number(),
  epoch: z.number(),
});
const provisionRowSchema = z.object({
  statusId: z.number(),
  code: z.string(),
  id: z.string(),
  name: z.string(),
  color: z.string(),
  sort: z.number(),
});

export class StageAdminService {
  constructor(
    private readonly repo: StageRepository,
    private readonly bitrix: Bitrix24ApiPort,
    private readonly runtime: CrmSyncRuntimeConfigService,
    private readonly tokens: Bitrix24OAuthTokenService,
    private readonly local: Bitrix24LocalAppClient
  ) {}
  private async binding(): Promise<{ member: string; domain: string }> {
    const domain = this.runtime.getReverseSync().portalDomain;
    const webhook = this.runtime.getBitrix24().webhookUrl;
    if (!domain || !webhook || new URL(webhook).hostname !== domain)
      throw stageError(
        'PORTAL_CONFLICT',
        'Адреса прямой и обратной синхронизации не совпадают',
        503
      );
    const { rows } = await this.repo.db.query<{ member_id: string }>(
      'SELECT member_id FROM bitrix24_app_installation WHERE domain=$1 AND status=$2',
      [domain, 'active']
    );
    if (rows.length !== 1)
      throw stageError(
        'INSTALLATION_REQUIRED',
        'Требуется единственная активная установка Bitrix',
        503
      );
    const c = await this.repo.config();
    if (
      c.binding_locked &&
      (c.member_id !== rows[0].member_id || c.domain !== domain)
    )
      throw stageError('PORTAL_CONFLICT', 'Привязка портала изменилась');
    return { member: rows[0].member_id, domain };
  }
  private assertRuntime(): void {
    const f = this.runtime.getFlags(),
      r = this.runtime.getReverseSync();
    if (
      !f.enabled ||
      f.relayOwner !== 'in_process' ||
      f.dryRun ||
      !r.enabled ||
      r.relayOwner !== 'in_process' ||
      r.dryRun
    )
      throw stageError(
        'RUNTIME_DISABLED',
        'Для записи нужны включённые прямой и обратный обработчики in_process без dry-run',
        503
      );
  }
  private async statuses(): Promise<StatusReference[]> {
    return (
      await this.repo.db
        .query<StatusReference>(`SELECT s.order_status_id AS id,s.order_status_name AS name,s.order_status_code AS code,s.color,s.is_active AS active,
      EXISTS(SELECT 1 FROM orders o WHERE o.order_status_id=s.order_status_id AND o.order_kind='production_order' AND NOT o.delete_flag) AS used
      FROM order_statuses s WHERE s.order_status_code<>'crm_request' ORDER BY s.sort_order,s.order_status_id`)
    ).rows;
  }
  async state() {
    const c = await this.repo.config();
    const jobs = await this.repo.db.query<{
      job_id: string;
      kind: string;
      created_at: Date;
    }>(
      'SELECT job_id,kind,created_at FROM bitrix24_stage_job WHERE member_id=$1 AND category_id=$2 ORDER BY created_at DESC LIMIT 20',
      [c.member_id, c.category_id]
    );
    const [statuses, catalogs, mappings, counts] = await Promise.all([
      this.statuses(),
      this.repo.db.query<StageCatalog>(
        'SELECT * FROM bitrix24_stage_catalog ORDER BY category_id'
      ),
      this.repo.mappings(c),
      this.repo.db.query<{ status: string; count: string }>(
        'SELECT status,count(*)::text FROM bitrix24_stage_work WHERE member_id=$1 AND category_id=$2 AND epoch=$3 GROUP BY status',
        [c.member_id, c.category_id, c.epoch]
      ),
    ]);
    return {
      config: c,
      jobs: jobs.rows,
      statuses,
      catalogs: catalogs.rows,
      mappings,
      counts: counts.rows,
      runtime: {
        forward: this.runtime.getFlags().relayOwner,
        reverse: this.runtime.getReverseSync().relayOwner,
      },
    };
  }
  async refresh(actor: StageActor) {
    const b = await this.binding();
    if (!this.bitrix.listDealCategories || !this.bitrix.listDealStages)
      throw stageError(
        'CLIENT_UNAVAILABLE',
        'Клиент справочника недоступен',
        503
      );
    const categories = await this.bitrix.listDealCategories();
    const all: Array<{
      id: number;
      name: string;
      stages: ReturnType<typeof normalizeStages>;
    }> = [];
    for (const category of categories) {
      const id = Number(category.id);
      if (!Number.isInteger(id) || id < 0 || typeof category.name !== 'string')
        throw stageError('CATALOG_INVALID', 'Некорректный список воронок', 502);
      all.push({
        id,
        name: category.name,
        stages: normalizeStages(await this.bitrix.listDealStages(id)),
      });
    }
    // No partial refresh on upstream failure; removed categories are not usable.
    await this.repo.db.transaction(async (tx) => {
      for (const cat of all)
        await tx.query(
          `INSERT INTO bitrix24_stage_catalog(member_id,category_id,category_name,stages) VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(member_id,category_id) DO UPDATE SET category_name=EXCLUDED.category_name,stages=EXCLUDED.stages,revision=gen_random_uuid(),fetched_at=now()`,
          [b.member, cat.id, cat.name, JSON.stringify(cat.stages)]
        );
      await tx.query(
        "UPDATE bitrix24_stage_catalog SET stages='[]'::jsonb,revision=gen_random_uuid(),fetched_at=now() WHERE member_id=$1 AND NOT(category_id=ANY($2::int[]))",
        [b.member, all.map((c) => c.id)]
      );
      await this.repo.record(tx, 'catalog_refreshed', actor, {
        memberId: b.member,
        categories: all.length,
      });
    });
    return this.state();
  }
  private async createJob(
    kind: StageJob['kind'],
    c: StageConfig,
    actor: StageActor,
    payload: Record<string, unknown>
  ): Promise<StageJob> {
    return this.repo.db.transaction(async (tx) => {
      const { rows } = await tx.query<StageJob>(
        `INSERT INTO bitrix24_stage_job(member_id,category_id,epoch,config_version,kind,payload,actor_user_id,request_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
        [
          c.member_id,
          c.category_id,
          c.epoch,
          c.version,
          kind,
          JSON.stringify(payload),
          actor.id,
          actor.requestId,
        ]
      );
      await this.repo.record(tx, 'preview_created', actor, {
        jobId: rows[0].job_id,
        kind,
        memberId: c.member_id,
        categoryId: c.category_id,
      });
      return rows[0];
    });
  }
  async job(id: string): Promise<StageJob> {
    const { rows } = await this.repo.db.query<StageJob>(
      'SELECT * FROM bitrix24_stage_job WHERE job_id=$1',
      [id]
    );
    if (!rows[0]) throw stageError('JOB_NOT_FOUND', 'Операция не найдена', 404);
    return rows[0];
  }
  private checkJob(job: StageJob, c: StageConfig): void {
    if (
      job.expires_at.getTime() < Date.now() ||
      job.config_version !== c.version ||
      job.epoch !== c.epoch
    )
      throw stageError('PREVIEW_STALE', 'Предпросмотр устарел; обновите его');
    if (
      c.binding_locked &&
      (job.member_id !== c.member_id || job.category_id !== c.category_id)
    )
      throw stageError('PORTAL_CONFLICT', 'Привязка операции не совпадает');
  }
  private async validateSettings(s: StageSettings) {
    const c = await this.repo.config();
    if (s.version !== c.version)
      throw stageError(
        'VERSION_CONFLICT',
        'Настройки изменены другим пользователем'
      );
    // Emergency stop is local-only. An invalid catalog, expired installation or
    // disabled runtime must never prevent cancelling enrolled work. Other form
    // edits are discarded; preview shows the stored binding and mappings.
    if (c.enabled && !s.enabled) {
      return {
        c,
        b: { member: c.member_id!, domain: c.domain! },
        catalog: null,
      };
    }
    const b = await this.binding();
    if (
      c.binding_locked &&
      (c.category_id !== s.categoryId || c.member_id !== b.member)
    )
      throw stageError(
        'BINDING_LOCKED',
        'Смена воронки после включения запрещена'
      );
    const catalog = await this.repo.catalog({
      ...c,
      member_id: b.member,
      category_id: s.categoryId,
    });
    if (!catalog?.stages.length)
      throw stageError('CATALOG_REQUIRED', 'Сначала обновите каталог воронок');
    const statuses = await this.statuses();
    if (
      !statuses.some(
        (x) =>
          x.id === s.completedStatusId &&
          x.name.trim().toLowerCase().replace(/ё/g, 'е') === 'завершен'
      )
    )
      throw stageError('STATUS_INVALID', 'Выберите статус ERP «Завершен»');
    const unique = new Set(s.mappings.map((x) => x.orderStatusId));
    if (unique.size !== s.mappings.length)
      throw stageError('DUPLICATE_MAPPING', 'Статус ERP указан дважды', 422);
    for (const m of s.mappings) {
      if (!statuses.some((x) => x.id === m.orderStatusId))
        throw stageError('STATUS_INVALID', 'Неизвестный статус ERP');
      targetStage(
        m.orderStatusId,
        m.stageId,
        catalog.stages,
        s.completedStatusId
      );
    }
    if (s.enabled) {
      this.assertRuntime();
      if (statuses.some((x) => (x.active || x.used) && !unique.has(x.id)))
        throw stageError(
          'MAPPING_INCOMPLETE',
          'Сопоставьте все активные и используемые статусы заказов'
        );
    }
    return { c, b, catalog };
  }
  async previewSettings(settings: StageSettings, actor: StageActor) {
    const { c, b, catalog } = await this.validateSettings(settings);
    if (c.enabled && !settings.enabled) {
      settings = {
        version: c.version,
        categoryId: c.category_id!,
        completedStatusId: c.completed_status_id!,
        enabled: false,
        mappings: (await this.repo.mappings(c)).map((m) => ({
          orderStatusId: m.order_status_id,
          stageId: m.stage_id,
        })),
      };
    }
    const impact = await this.repo.db.query<{ order_id: string }>(
      `SELECT order_id::text FROM bitrix24_stage_work WHERE member_id=$1 AND category_id=$2 AND epoch=$3 AND status<>'cancelled' ORDER BY order_id`,
      [b.member, settings.categoryId, c.epoch]
    );
    return this.createJob(
      'settings',
      { ...c, member_id: b.member, category_id: settings.categoryId },
      actor,
      {
        settings,
        catalogRevision: catalog?.revision ?? null,
        affectedOrderIds: impact.rows.map((x) => x.order_id),
      }
    );
  }
  async applySettings(id: string, actor: StageActor) {
    const job = await this.job(id);
    if (job.kind !== 'settings')
      throw stageError('JOB_KIND', 'Неверный тип операции');
    if (job.results.applied) return this.state();
    const settings = stageSettingsSchema.parse(job.payload.settings);
    const { c, b, catalog } = await this.validateSettings(settings);
    this.checkJob(job, c);
    if (job.payload.catalogRevision !== (catalog?.revision ?? null))
      throw stageError(
        'PREVIEW_STALE',
        'Каталог изменился; обновите предпросмотр'
      );
    await this.repo.db.transaction(async (tx) => {
      const r = await tx.query(
        `UPDATE bitrix24_stage_config SET member_id=$1,domain=$2,category_id=$3,completed_status_id=$4,enabled=$5,
        binding_locked=binding_locked OR $5::boolean,epoch=epoch+CASE WHEN enabled AND NOT $5::boolean THEN 1 ELSE 0 END,version=version+1,updated_by=$6,updated_at=now()
        WHERE singleton AND version=$7 RETURNING epoch`,
        [
          b.member,
          b.domain,
          settings.categoryId,
          settings.completedStatusId,
          settings.enabled,
          actor.id,
          c.version,
        ]
      );
      if (!r.rowCount)
        throw stageError('VERSION_CONFLICT', 'Настройки изменены');
      await tx.query(
        'DELETE FROM bitrix24_stage_mapping WHERE member_id=$1 AND category_id=$2',
        [b.member, settings.categoryId]
      );
      for (const m of settings.mappings)
        await tx.query(
          'INSERT INTO bitrix24_stage_mapping(member_id,category_id,order_status_id,stage_id,updated_by) VALUES($1,$2,$3,$4,$5)',
          [b.member, settings.categoryId, m.orderStatusId, m.stageId, actor.id]
        );
      if (!settings.enabled)
        await tx.query(
          "UPDATE bitrix24_stage_work SET status='cancelled',lock_token=NULL,locked_at=NULL,updated_at=now() WHERE member_id=$1 AND category_id=$2 AND status<>'cancelled'",
          [b.member, settings.categoryId]
        );
      else if (c.enabled) {
        const ids = z.array(z.string()).parse(job.payload.affectedOrderIds);
        for (const orderId of ids)
          await tx.query('SELECT bitrix24_stage_enqueue($1::bigint)', [
            orderId,
          ]);
      }
      await tx.query(
        "UPDATE bitrix24_stage_job SET results=jsonb_build_object('applied','Настройки сохранены') WHERE job_id=$1",
        [id]
      );
      await this.repo.record(tx, 'mapping_changed', actor, {
        jobId: id,
        memberId: b.member,
        categoryId: settings.categoryId,
        before: c,
        after: settings,
        affectedCount: Array.isArray(job.payload.affectedOrderIds)
          ? job.payload.affectedOrderIds.length
          : 0,
      });
    });
    return this.state();
  }
  async previewProvision(statusIds: number[], actor: StageActor) {
    const c = await this.repo.config();
    await this.binding();
    const catalog = await this.repo.catalog(c);
    if (!catalog)
      throw stageError(
        'CATALOG_REQUIRED',
        'Сохраните воронку и обновите каталог'
      );
    const refs = await this.statuses();
    const selected = refs.filter((s) => statusIds.includes(s.id));
    if (
      selected.length !== new Set(statusIds).size ||
      selected.some((s) => s.id === c.completed_status_id)
    )
      throw stageError(
        'STATUS_INVALID',
        'Создавать можно только рабочие стадии',
        422
      );
    const rows = provisioningRows(selected, catalog.stages, c.category_id!);
    if (rows.some((r) => catalog.stages.some((s) => s.id === r.id)))
      throw stageError(
        'STAGE_EXISTS',
        'Стадия уже существует — используйте сопоставление'
      );
    return this.createJob('provision', c, actor, {
      rows,
      catalogRevision: catalog.revision,
    });
  }
  async applyProvision(id: string, actor: StageActor) {
    this.assertRuntime();
    const b = await this.binding();
    const c = await this.repo.config();
    const job = await this.job(id);
    this.checkJob(job, c);
    if (job.kind !== 'provision' || job.member_id !== b.member)
      throw stageError('JOB_KIND', 'Неверная операция');
    const token = await this.tokens.getAccessToken(b.domain);
    const admin = await this.local.currentUser({
      domain: b.domain,
      accessToken: token,
    });
    if (!admin.active || !admin.admin)
      throw stageError(
        'ADMIN_REQUIRED',
        'Требуются актуальные права администратора Bitrix',
        403
      );
    const rows = z.array(provisionRowSchema).parse(job.payload.rows);
    const outcome = await this.repo.db.withAdvisoryLock(
      'bitrix24-live-writer',
      (assertOwned) =>
        this.bitrix.withRequestGuard(
          async () => {
            await assertOwned();
            this.assertRuntime();
            await this.binding();
            this.checkJob(job, await this.repo.config());
          },
          async () => {
            if (!this.bitrix.listDealStages || !this.bitrix.createWorkingStage)
              throw stageError(
                'CLIENT_UNAVAILABLE',
                'Клиент создания стадий недоступен',
                503
              );
            for (const row of rows) {
              const existingJob = await this.job(id);
              if (existingJob.results[String(row.statusId)] === 'Создана')
                continue;
              this.checkJob(existingJob, await this.repo.config());
              let remote = normalizeStages(
                await this.bitrix.listDealStages(c.category_id!)
              );
              let existing = remote.find((s) => s.id === row.id);
              if (existing && !existingJob.results[String(row.statusId)])
                throw stageError(
                  'PROVISION_CONFLICT',
                  'Код стадии появился после предпросмотра. Обновите каталог и используйте сопоставление'
                );
              if (!existing) {
                if (
                  remote.some((s) => s.semantics === 'S' && s.sort <= row.sort)
                )
                  throw stageError('NO_SORT_SPACE', 'Порядок стадий изменился');
                if (
                  existingJob.results[String(row.statusId)] === 'Отправляется'
                )
                  throw stageError(
                    'PROVISION_UNCERTAIN',
                    'Результат создания не подтверждён. Повторное создание запрещено; проверьте каталог Bitrix'
                  );
                await this.repo.db.query(
                  "UPDATE bitrix24_stage_job SET results=results||jsonb_build_object($2::text,'Отправляется') WHERE job_id=$1",
                  [id, String(row.statusId)]
                );
                // The reviewed deterministic ID is the recovery identity; call never retries ambiguous create.
                await this.bitrix.createWorkingStage({
                  ENTITY_ID:
                    c.category_id === 0
                      ? 'DEAL_STAGE'
                      : `DEAL_STAGE_${c.category_id}`,
                  STATUS_ID: row.code,
                  NAME: row.name,
                  COLOR: row.color,
                  SORT: row.sort,
                });
                remote = normalizeStages(
                  await this.bitrix.listDealStages(c.category_id!)
                );
                existing = remote.find((s) => s.id === row.id);
              }
              if (
                !existing ||
                existing.name !== row.name ||
                existing.sort !== row.sort ||
                existing.semantics !== ''
              )
                throw stageError(
                  'PROVISION_CONFLICT',
                  'Код занят стадией с другими параметрами'
                );
              await this.repo.db.transaction(async (tx) => {
                const r = await tx.query(
                  "UPDATE bitrix24_stage_job SET results=results||jsonb_build_object($2::text,'Создана') WHERE job_id=$1 AND results->>$2::text IS DISTINCT FROM 'Создана'",
                  [id, String(row.statusId)]
                );
                if (r.rowCount)
                  await this.repo.record(tx, 'created', actor, {
                    jobId: id,
                    memberId: b.member,
                    categoryId: c.category_id,
                    stageId: existing!.id,
                    bitrixActorId: admin.id,
                    after: existing,
                  });
              });
            }
            return true;
          }
        )
    );
    if (!outcome) throw stageError('JOB_BUSY', 'Операция уже выполняется');
    await this.refresh(actor);
    return this.job(id);
  }
  async previewReconcile(
    afterId: number,
    limit: number,
    actor: StageActor,
    selection: {
      sort?: 'asc' | 'desc';
      orderId?: number;
      orderName?: string;
    } = {}
  ) {
    const c = await this.repo.config();
    await this.binding();
    const catalog = await this.repo.catalog(c),
      mappings = await this.repo.mappings(c);
    if (!catalog)
      throw stageError('CATALOG_REQUIRED', 'Сначала настройте воронку');
    const sort = selection.sort === 'desc' ? 'desc' : 'asc';
    const ids = await this.repo.db.query<{ order_id: string }>(
      `SELECT o.order_id::text FROM orders o
      WHERE o.order_kind='production_order' AND NOT o.delete_flag
        AND EXISTS (SELECT 1 FROM crm_sync_mapping m WHERE m.entity_type='order' AND m.erp_id=o.order_id::text AND m.bitrix_object='deal' AND m.bitrix_id IS NOT NULL)
        AND ($1::bigint=0 OR o.order_id ${
          sort === 'desc' ? '<' : '>'
        } $1::bigint)
        AND ($3::bigint IS NULL OR o.order_id=$3::bigint)
        AND ($4::text IS NULL OR o.order_name::text=$4::text)
      ORDER BY o.order_id ${sort === 'desc' ? 'DESC' : 'ASC'} LIMIT $2`,
      [
        afterId,
        limit + 1,
        selection.orderId ?? null,
        selection.orderName ?? null,
      ]
    );
    const page = ids.rows.slice(0, limit);
    const rows: Array<Record<string, unknown>> = [];
    for (const { order_id } of page) {
      const order = await this.repo.order(order_id);
      if (!order?.bitrix_id) continue;
      try {
        const remote = await this.bitrix.getCrmItem(2, order.bitrix_id);
        if (!remote) throw stageError('DEAL_MISSING', 'Сделка недоступна');
        verifyDeal(order, remote, c);
        const target = targetStage(
          order.order_status_id,
          mappings.find((x) => x.order_status_id === order.order_status_id)
            ?.stage_id,
          catalog.stages,
          c.completed_status_id
        );
        const approval: StageApproval = {
          orderId: order.order_id,
          statusId: order.order_status_id,
          orderVersion: order.version,
          bitrixId: order.bitrix_id,
          observed: String(remote.stageId),
          target: target.id,
          configVersion: c.version,
          epoch: c.epoch,
        };
        rows.push({
          ...approval,
          orderName: order.order_name,
          oldName:
            catalog.stages.find((x) => x.id === remote.stageId)?.name ??
            String(remote.stageId),
          newName: target.name,
          semantics: target.semantics,
          change: remote.stageId !== target.id,
          error: null,
        });
      } catch (error) {
        rows.push({
          orderId: order.order_id,
          orderName: order.order_name,
          bitrixId: order.bitrix_id,
          error: safeBitrixError(
            error instanceof Error ? error.message : String(error)
          ),
        });
      }
    }
    return this.createJob('reconcile', c, actor, {
      rows,
      nextCursor: page.at(-1)?.order_id ?? String(afterId),
      hasMore: ids.rows.length > limit,
      selection: { ...selection, sort },
    });
  }
  async applyReconcile(id: string, selected: string[], actor: StageActor) {
    this.assertRuntime();
    const c = await this.repo.config();
    await this.binding();
    if (!c.enabled)
      throw stageError('DISABLED', 'Передача стадий выключена', 503);
    const job = await this.job(id);
    this.checkJob(job, c);
    if (job.kind !== 'reconcile')
      throw stageError('JOB_KIND', 'Неверный тип операции');
    const rows = z
      .array(
        z
          .object({ orderId: z.string(), error: z.string().nullable() })
          .passthrough()
      )
      .parse(job.payload.rows);
    if (selected.some((id) => !rows.some((r) => r.orderId === id && !r.error)))
      throw stageError(
        'INVALID_SELECTION',
        'В выборке есть заблокированные или неизвестные заказы',
        422
      );
    for (const idOrder of selected) {
      const approval = approvalSchema.parse(
        rows.find((r) => r.orderId === idOrder)
      );
      await this.repo.db.transaction(async (tx) => {
        const locked = await tx.query<StageJob>(
          'SELECT * FROM bitrix24_stage_job WHERE job_id=$1 FOR UPDATE',
          [id]
        );
        if (locked.rows[0].results[idOrder]) return;
        this.checkJob(locked.rows[0], await this.repo.config(tx));
        const order = await tx.query(
          'SELECT order_status_id,version FROM orders WHERE order_id=$1 AND order_kind=$2 AND NOT delete_flag FOR UPDATE',
          [idOrder, 'production_order']
        );
        if (
          !order.rows[0] ||
          order.rows[0].version !== approval.orderVersion ||
          order.rows[0].order_status_id !== approval.statusId
        ) {
          await tx.query(
            "UPDATE bitrix24_stage_job SET results=results||jsonb_build_object($2::text,'Предпросмотр устарел') WHERE job_id=$1",
            [id, idOrder]
          );
          return;
        }
        // Avoid replacing an in-flight/live transition with stale approval.
        const busy = await tx.query(
          "SELECT 1 FROM bitrix24_stage_work WHERE member_id=$1 AND category_id=$2 AND order_id=$3 AND epoch=$4 AND status IN ('pending','processing')",
          [c.member_id, c.category_id, idOrder, c.epoch]
        );
        if (busy.rowCount)
          throw stageError(
            'ORDER_BUSY',
            'Заказ уже ожидает передачи; обновите сверку после обработки'
          );
        await tx.query('SELECT bitrix24_stage_enqueue($1::bigint)', [idOrder]);
        await tx.query(
          'UPDATE bitrix24_stage_work SET approval=$4::jsonb,actor_user_id=$5,request_id=$6,job_id=$7 WHERE member_id=$1 AND category_id=$2 AND order_id=$3',
          [
            c.member_id,
            c.category_id,
            idOrder,
            JSON.stringify(approval),
            actor.id,
            actor.requestId,
            id,
          ]
        );
        await tx.query(
          "UPDATE bitrix24_stage_job SET results=results||jsonb_build_object($2::text,'В очереди') WHERE job_id=$1",
          [id, idOrder]
        );
        await this.repo.record(
          tx,
          'reconcile_enqueued',
          actor,
          {
            jobId: id,
            bitrixId: approval.bitrixId,
            memberId: c.member_id,
            categoryId: c.category_id,
            after: approval,
          },
          (await this.repo.order(idOrder, tx)) ?? undefined
        );
      });
    }
    return this.job(id);
  }
  async retry(id: string, actor: StageActor) {
    this.assertRuntime();
    const c = await this.repo.config();
    await this.repo.db.transaction(async (tx) => {
      const r = await tx.query(
        `UPDATE bitrix24_stage_work w SET status='pending',revision=revision+1,attempts=0,restore_count=0,restore_window=NULL,last_error=NULL,next_attempt_at=now(),actor_user_id=$4,request_id=$5
        FROM bitrix24_stage_config c WHERE c.enabled AND w.member_id=c.member_id AND w.category_id=c.category_id AND w.epoch=c.epoch AND w.member_id=$1 AND w.category_id=$2 AND w.order_id=$3 AND w.status IN ('blocked','failed','waiting_mapping')`,
        [c.member_id, c.category_id, id, actor.id, actor.requestId]
      );
      if (!r.rowCount)
        throw stageError(
          'RETRY_UNAVAILABLE',
          'Нет остановленного задания для повтора'
        );
      await this.repo.record(
        tx,
        'retry_requested',
        actor,
        { orderId: id, memberId: c.member_id, categoryId: c.category_id },
        (await this.repo.order(id, tx)) ?? undefined
      );
    });
    return { queued: true };
  }
}
