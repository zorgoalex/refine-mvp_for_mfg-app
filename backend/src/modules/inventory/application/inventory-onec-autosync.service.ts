import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OnecAlertsPort } from '../../onec-agent/application/onec-alerts-port';
import { OnecEtlEvents, type WarehousesPublished } from '../../onec-agent/application/onec-etl-events';
import { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { InventoryService } from './inventory.service';
import type { CommandContext } from './inventory.types';

export const AUTOSYNC_ALERT_KIND = 'warehouse_autosync_failed';

/** Диагностика без данных запроса: код ошибки API или класс и сообщение. */
const describe = (error: unknown): string =>
  error instanceof ApiError ? error.code : error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : 'unknown error';
const HOURLY_MS = 60 * 60_000;
const FIRST_PASS_DELAY_MS = 60_000;

/** Что запустило автосинхронизацию: выгрузка run или часовой страховочный проход. */
export type AutosyncTrigger =
  | { kind: 'run'; sourceId: number; runId: string; requestId: string; correlationId: string }
  | { kind: 'hourly'; sourceId: number; hour: string };

export type AutosyncOutcome =
  | { status: 'skipped'; reason: 'disabled' }
  | { status: 'succeeded'; seq: number; created: number; linked: number; skipped: number; replayed: boolean }
  | { status: 'failed'; seq: number; code: string };

/**
 * Автозапуск синхронизации складов 1С → ERP (план `2026-09-29-onec-warehouse-autosync-plan.md`).
 * Та же `syncFromOnec`, что у кнопки. Исполнитель — служебный пользователь
 * (`BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID`, is_service_account, роль integration_service).
 * Порядок итогов: номер запуска выделяется отдельной транзакцией до синхронизации, итог и алерт
 * пишутся под FOR UPDATE строки состояния только если номер больше последнего записанного.
 */
@Injectable()
export class InventoryOnecAutosyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoryOnecAutosyncService.name);
  private unsubscribe: (() => void) | null = null;
  private firstPass: NodeJS.Timeout | null = null;
  private hourly: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OnecCatalogReader) private readonly onec: OnecCatalogReader,
    @Inject(OnecEtlEvents) private readonly events: OnecEtlEvents,
    @Inject(OnecAlertsPort) private readonly alerts: OnecAlertsPort,
  ) {}

  onModuleInit(): void {
    if (!this.configured()) return;
    this.unsubscribe = this.events.onWarehousesPublished((event) => this.onPublished(event));
    this.firstPass = setTimeout(() => void this.safeHourlyPass(), FIRST_PASS_DELAY_MS);
    this.firstPass.unref?.();
    this.hourly = setInterval(() => void this.safeHourlyPass(), HOURLY_MS);
    this.hourly.unref?.();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.firstPass) clearTimeout(this.firstPass);
    if (this.hourly) clearInterval(this.hourly);
  }

  /** Флаги склада и автозапуска (модуль 1С проверяется при чтении зеркала). */
  private configured(): boolean {
    return this.inventory.enabled() && this.config.get('BACKEND_INVENTORY_ONEC_AUTOSYNC', { infer: true }) === true;
  }

  /** Граница сигнала: фоновая синхронизация не должна ронять процесс (необработанный rejection). */
  private async onPublished(event: WarehousesPublished): Promise<void> {
    try {
      const outcome = await this.run({ kind: 'run', ...event });
      this.logger.log(`warehouses autosync after run ${event.runId}: ${JSON.stringify(outcome)}`);
    } catch (error) {
      this.logger.error(`warehouses autosync after run ${event.runId} failed: ${describe(error)}`);
    }
  }

  /** Граница таймеров: любая ошибка (БД недоступна и т. п.) только логируется, следующий тик повторит. */
  async safeHourlyPass(now = new Date()): Promise<void> {
    try {
      await this.hourlyPass(now);
    } catch (error) {
      this.logger.error(`warehouses hourly autosync failed: ${describe(error)}`);
    }
  }

  async hourlyPass(now = new Date()): Promise<void> {
    const sources = await this.sourcesOrNull();
    if (sources === null) return;
    const hour = now.toISOString().slice(0, 13).replace(/[-T]/g, '');
    for (const sourceId of sources) {
      // Сбой одного источника не мешает остальным.
      try {
        const outcome = await this.run({ kind: 'hourly', sourceId, hour });
        if (outcome.status === 'failed') this.logger.warn(`warehouses hourly autosync source ${sourceId}: ${outcome.code}`);
      } catch (error) {
        this.logger.error(`warehouses hourly autosync source ${sourceId} failed: ${describe(error)}`);
      }
    }
  }

  /** null — модуль 1С выключен или зеркало недоступно (ничего не делаем, алерт не трогаем). */
  private async sourcesOrNull(): Promise<number[] | null> {
    if (!this.configured()) return null;
    try {
      return await this.onec.warehouseSourceIds();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return null;
      throw error;
    }
  }

  async run(trigger: AutosyncTrigger): Promise<AutosyncOutcome> {
    // Общий gate (R2-3): склад включён, автозапуск включён, модуль 1С включён — до выделения номера.
    if ((await this.sourcesOrNull()) === null) return { status: 'skipped', reason: 'disabled' };
    const seq = await this.allocateSeq(trigger.sourceId);
    try {
      const actor = await this.readyActor();
      const ctx = this.context(trigger, actor);
      let fresh = false;
      const result = await this.inventory.syncWarehousesAsService(ctx, trigger.sourceId, {
        resetSessionUser: true,
        onFreshResult: async (tx, value) => {
          fresh = true;
          await this.finish(tx, trigger.sourceId, seq, { ok: true, created: value.created.length, linked: value.linked.length, skipped: value.skipped.length });
        },
      });
      // Повтор по ключу: прежний результат, алерт не меняется (R1-2).
      return {
        status: 'succeeded', seq, replayed: !fresh,
        created: result.created.length, linked: result.linked.length, skipped: result.skipped.length,
      };
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'AUTOSYNC_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      await this.database.transaction((tx) => this.finish(tx, trigger.sourceId, seq, { ok: false, code, message }));
      return { status: 'failed', seq, code };
    }
  }

  /** Отдельная короткая транзакция с commit до синхронизации: откат синхронизации номер не возвращает. */
  private async allocateSeq(sourceId: number): Promise<number> {
    const { rows } = await this.database.query<{ last_seq: string }>(
      `INSERT INTO inventory_onec_autosync_state AS state (source_id, last_seq, finished_seq)
       VALUES ($1, 1, 0)
       ON CONFLICT (source_id) DO UPDATE SET last_seq = state.last_seq + 1
       RETURNING last_seq`,
      [sourceId],
    );
    return Number(rows[0].last_seq);
  }

  /** Итог и алерт — только от самого свежего завершившегося запуска (seq > finished_seq). */
  private async finish(
    tx: DatabaseClient,
    sourceId: number,
    seq: number,
    outcome: { ok: true; created: number; linked: number; skipped: number } | { ok: false; code: string; message: string },
  ): Promise<void> {
    const { rows } = await tx.query<{ finished_seq: string }>(
      'SELECT finished_seq FROM inventory_onec_autosync_state WHERE source_id = $1 FOR UPDATE',
      [sourceId],
    );
    if (!rows[0] || Number(rows[0].finished_seq) >= seq) return;
    await tx.query(
      `UPDATE inventory_onec_autosync_state
          SET finished_seq = $2, finished_at = now(), last_outcome = $3, last_error_code = $4, last_result = $5::jsonb
        WHERE source_id = $1`,
      [sourceId, seq, outcome.ok ? 'succeeded' : 'failed', outcome.ok ? null : outcome.code, JSON.stringify(outcome)],
    );
    const dedupeKey = `${AUTOSYNC_ALERT_KIND}:${sourceId}`;
    if (outcome.ok) {
      await this.alerts.resolve(tx, dedupeKey);
    } else {
      await this.alerts.raise(tx, {
        kind: AUTOSYNC_ALERT_KIND, sourceId, dedupeKey, severity: 'warning',
        details: { seq, code: outcome.code, message: outcome.message.slice(0, 500) },
      });
    }
  }

  /** Служебный исполнитель: активный, is_service_account, роль integration_service (как у Bitrix24 reverse sync). */
  private async readyActor(): Promise<{ id: number; username: string }> {
    const id = Number(this.config.get('BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID', { infer: true }) || 0);
    const { rows } = await this.database.query<{ user_id: string; username: string }>(
      `SELECT u.user_id, u.username
         FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = $1 AND u.is_active = true AND u.is_service_account = true
          AND r.role_code = 'integration_service' AND r.is_active = true`,
      [id],
    );
    if (!rows[0]) throw new ApiError(503, 'ACTOR_NOT_READY', 'Служебный пользователь автосинхронизации складов не готов');
    return { id: Number(rows[0].user_id), username: rows[0].username };
  }

  private context(trigger: AutosyncTrigger, actor: { id: number; username: string }): CommandContext {
    // Служебный пользователь без прав: проверка прав в этом пути не вызывается (нет HTTP-маршрута).
    const currentUser = { id: String(actor.id), username: actor.username, roleId: 0, permissions: [] } as unknown as CurrentUser;
    if (trigger.kind === 'run') {
      return {
        currentUser, actorRole: 'integration_service', source: 'onec_autosync',
        idempotencyKey: `onec-autosync:${trigger.sourceId}:${trigger.runId}`,
        requestId: trigger.requestId, correlationId: trigger.correlationId,
      };
    }
    const id = `onec-autosync-hourly-${trigger.sourceId}-${trigger.hour}`;
    return {
      currentUser, actorRole: 'integration_service', source: 'onec_autosync',
      idempotencyKey: `onec-autosync-hourly:${trigger.sourceId}:${trigger.hour}`,
      requestId: id, correlationId: id,
    };
  }
}
