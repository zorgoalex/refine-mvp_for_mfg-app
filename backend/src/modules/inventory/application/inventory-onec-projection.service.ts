import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { OnecAlertsPort } from '../../onec-agent/application/onec-alerts-port';
import { OnecCatalogReader, type OnecWarehouse } from '../../onec-agent/onec-catalog-reader';
import { PgOnecProjectionRepository, type ProjectionActor } from '../adapters/pg-onec-projection-repository';
import { PgWarehouseRepository, supersededCompensation, type OnecCompensationResult } from '../adapters/pg-warehouse-repository';
import { desiredForDocument, parseStockKey, projectionDeltas, projectionHash, stockKey } from '../domain/onec-projection';
import { InventoryService } from './inventory.service';
import type { CommandContext } from './inventory.types';
import {
  CONSUMPTION_DOC_KINDS, ONEC_CONSUMPTION_READER, ONEC_DOCUMENTS_SIGNAL,
  type ConsumptionDocumentView, type OnecConsumptionReader, type OnecDocumentsSignal,
} from './onec-consumption.port';

export const PROJECTION_ALERT_KIND = 'inventory_onec_projection_failed';
const HOURLY_MS = 60 * 60_000;
const FIRST_PASS_DELAY_MS = 90_000;
const describe = (error: unknown): string =>
  error instanceof ApiError ? error.code : error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : 'unknown error';
const unavailable = (error: unknown) =>
  error instanceof ApiError && (error.code === 'ONEC_DOCUMENTS_UNAVAILABLE' || error.code === 'ONEC_MIRROR_UNAVAILABLE');

export type ProjectionPassOutcome =
  | { status: 'skipped'; reason: 'disabled' | 'onec_unavailable' | 'busy' }
  | { status: 'done'; candidates: number; processed: number; documents: number; failed: number };

/**
 * Проекция расхода 1С в учёт плёнки (план 2026-09-30-onec-consumption-documents-plan.md §4): сходящийся проход
 * по документам 1С с изменившимся hash входов; транзакция на документ; документы-дельты source='onec'.
 * Флаг BACKEND_INVENTORY_ONEC_CONSUMPTION; исполнитель — служебный пользователь автосинхронизации складов.
 */
@Injectable()
export class InventoryOnecProjectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoryOnecProjectionService.name);
  private readonly repository = new PgOnecProjectionRepository();
  private readonly warehouses: PgWarehouseRepository;
  private firstPass: NodeJS.Timeout | null = null;
  private hourly: NodeJS.Timeout | null = null;
  private running: Promise<ProjectionPassOutcome> | null = null;
  /** requestId идущего прохода — им помечены движения и аудит документов этого прохода. */
  private runningRequestId: string | null = null;
  private rerun = false;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDocuments: (() => void) | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OnecCatalogReader) private readonly onec: OnecCatalogReader,
    @Inject(ONEC_CONSUMPTION_READER) private readonly reader: OnecConsumptionReader,
    @Inject(OnecAlertsPort) private readonly alerts: OnecAlertsPort,
    @Inject(ONEC_DOCUMENTS_SIGNAL) private readonly documentsSignal: OnecDocumentsSignal,
  ) {
    this.warehouses = new PgWarehouseRepository(database);
  }

  enabled(): boolean {
    return this.inventory.enabled() && this.config.get('BACKEND_INVENTORY_ONEC_CONSUMPTION', { infer: true }) === true;
  }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.unsubscribe = this.inventory.onProjectionInputsChanged((reason) => void this.safePass(reason));
    // Сигнал загрузчика 1С: только виды расхода (приходы/оплаты проекции не касаются).
    this.unsubscribeDocuments = this.documentsSignal.onDocumentsLoaded((event) => {
      if (event.docKinds.some((kind) => (CONSUMPTION_DOC_KINDS as readonly string[]).includes(kind))) void this.safePass('onec-documents');
    });
    this.firstPass = setTimeout(() => void this.safePass('startup'), FIRST_PASS_DELAY_MS);
    this.firstPass.unref?.();
    this.hourly = setInterval(() => void this.safePass('hourly'), HOURLY_MS);
    this.hourly.unref?.();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribeDocuments?.();
    if (this.firstPass) clearTimeout(this.firstPass);
    if (this.hourly) clearInterval(this.hourly);
  }

  /** Фоновый проход (сигнал загрузчика, таймер, смена даты начала): ошибки только в лог. */
  async safePass(trigger: string): Promise<void> {
    try {
      const outcome = await this.runPass(trigger);
      if (outcome.status === 'done' && (outcome.documents > 0 || outcome.failed > 0)) {
        this.logger.log(`1C consumption projection (${trigger}): ${JSON.stringify(outcome)}`);
      }
    } catch (error) {
      this.logger.error(`1C consumption projection (${trigger}) failed: ${describe(error)}`);
    }
  }

  /** Один проход за раз; сигнал во время прохода запускает ещё один после него (изменения не теряются). */
  async runPass(trigger: string): Promise<ProjectionPassOutcome> {
    if (!this.enabled()) return { status: 'skipped', reason: 'disabled' };
    return this.beginPass(trigger).done;
  }

  /**
   * Запускает проход или присоединяется к идущему — синхронно, без ожиданий: вызывающий сразу знает requestId прохода,
   * которым будут помечены движения и аудит документов (ручной запуск сохраняет связь с ним до ожидания итога).
   */
  private beginPass(
    trigger: string,
    requestId: string = `onec-consumption-${trigger}-${randomUUID()}`,
  ): { passRequestId: string; done: Promise<ProjectionPassOutcome>; joined: boolean } {
    if (this.running && this.runningRequestId) {
      this.rerun = true;
      return { passRequestId: this.runningRequestId, done: this.running, joined: true };
    }
    this.runningRequestId = requestId;
    const done = this.pass(trigger, requestId).finally(() => {
      this.running = null;
      this.runningRequestId = null;
      if (this.rerun) {
        this.rerun = false;
        void this.safePass(`${trigger}-rerun`);
      }
    });
    this.running = done;
    return { passRequestId: requestId, done, joined: false };
  }

  private async pass(trigger: string, requestId: string): Promise<ProjectionPassOutcome> {
    let candidates: ConsumptionDocumentView[];
    let onecWarehouses: OnecWarehouse[];
    const sources = (await this.database.query<{ source_id: string }>('SELECT source_id FROM onec_sources ORDER BY source_id')).rows
      .map((row) => Number(row.source_id));
    try {
      candidates = await this.reader.consumptionCandidates({ sourceIds: sources });
      onecWarehouses = await this.onec.listWarehouses();
    } catch (error) {
      if (unavailable(error)) return { status: 'skipped', reason: 'onec_unavailable' };
      throw error;
    }
    const actor = await this.readyActor();
    const itemKeys = candidates.flatMap((doc) => doc.lines.map((line) => line.nomenclatureRefKey)).filter((key): key is string => key !== null);
    const context = await this.repository.context(this.database, onecWarehouses, itemKeys);
    const states = await this.repository.states(this.database);
    const appliedWarehouses = await this.repository.appliedWarehouses(this.database);
    const dirty: number[] = [];
    const sourceOf = new Map<number, number>();
    const seen = new Set<number>();
    for (const doc of candidates) {
      sourceOf.set(doc.documentId, doc.sourceId);
      seen.add(doc.documentId);
      const applied = appliedWarehouses.get(doc.documentId) ?? [];
      const desired = desiredForDocument(doc, context, { appliedWarehouseIds: applied });
      const state = states.get(doc.documentId);
      // Документ, не касающийся участвующих складов и без применённого, состояния не заводит.
      if (!state && desired.desired.size === 0 && desired.issues.length === 0 && applied.length === 0) continue;
      if (state?.inputsHash !== projectionHash(doc, desired)) dirty.push(doc.documentId);
    }
    // Исчезнувшие документы (смена вида и т. п.) с применённым — вернуть к 0. Пересматриваются, пока применённое не
    // ушло (в т.ч. после `gone`): применённое замороженного склада возвращается, когда заморозка снята (hash её отражает).
    for (const state of states.values()) {
      const applied = appliedWarehouses.get(state.onecDocumentId);
      if (seen.has(state.onecDocumentId) || !applied) continue;
      if (state.inputsHash !== projectionHash(null, desiredForDocument(null, context, { appliedWarehouseIds: applied }))) {
        dirty.push(state.onecDocumentId);
        sourceOf.set(state.onecDocumentId, state.onecSourceId);
      }
    }
    let documents = 0;
    const failures = new Map<number, { count: number; lastError: string }>();
    for (const onecDocumentId of dirty) {
      try {
        documents += await this.projectDocument(onecDocumentId, actor, requestId);
      } catch (error) {
        if (unavailable(error)) return { status: 'skipped', reason: 'onec_unavailable' };
        const sourceId = sourceOf.get(onecDocumentId) ?? 0;
        const current = failures.get(sourceId) ?? { count: 0, lastError: '' };
        failures.set(sourceId, { count: current.count + 1, lastError: describe(error) });
        this.logger.warn(`1C consumption projection: document ${onecDocumentId} failed: ${describe(error)}`);
      }
    }
    // Алерт на экране «1С» по источнику: сбой прохода поднимает, успешный проход снимает.
    await this.database.transaction(async (tx) => {
      for (const sourceId of sources) {
        const dedupeKey = `${PROJECTION_ALERT_KIND}:${sourceId}`;
        const failure = failures.get(sourceId);
        if (!failure) await this.alerts.resolve(tx, dedupeKey);
        else await this.alerts.raise(tx, { kind: PROJECTION_ALERT_KIND, sourceId, dedupeKey, severity: 'warning', details: { failed: failure.count, lastError: failure.lastError, requestId } });
      }
    });
    const failed = [...failures.values()].reduce((sum, failure) => sum + failure.count, 0);
    return { status: 'done', candidates: candidates.length, processed: dirty.length, documents, failed };
  }

  /** Транзакция документа 1С (порядок блокировок §4.3): число созданных документов-дельт. */
  async projectDocument(onecDocumentId: number, actor: ProjectionActor, requestId: string): Promise<number> {
    return this.database.transaction(async (tx) => {
      const view = await this.reader.lockDocumentForProjection(onecDocumentId, tx);
      const state = await this.repository.lockState(tx, onecDocumentId, view);
      if (!state) return 0;
      const applied = await this.repository.applied(tx, onecDocumentId);
      const appliedWarehouseIds = [...new Set([...applied.keys()].map((key) => parseStockKey(key).warehouseId))];
      const onecWarehouses = await this.onec.listWarehouses(tx);
      const itemKeys = (view?.lines ?? []).map((line) => line.nomenclatureRefKey).filter((key): key is string => key !== null);
      const preliminary = await this.repository.context(tx, onecWarehouses, itemKeys);
      const warehouseIds = new Set<number>(appliedWarehouseIds);
      for (const refKey of [view?.warehouseRefKey, view?.destinationWarehouseRefKey, ...(view?.lines ?? []).map((line) => line.warehouseRefKey)]) {
        const warehouse = refKey ? preliminary.warehouseByRefKey.get(refKey.toLowerCase()) : undefined;
        if (warehouse) warehouseIds.add(warehouse.warehouseId);
      }
      await this.repository.lockWarehouses(tx, [...warehouseIds].sort((a, b) => a - b));
      await this.repository.lockFilms(tx, itemKeys);
      // Канон плёнок и склады зафиксированы — ключи остатков известны; блокируем их до чтения отсечек.
      const locked = await this.repository.context(tx, onecWarehouses, itemKeys);
      const keys = new Set<string>(applied.keys());
      for (const warehouseId of warehouseIds) {
        for (const filmId of new Set(locked.filmByRefKey.values())) keys.add(stockKey(warehouseId, filmId));
      }
      const balances = await this.repository.lockBalances(tx, [...keys]);
      // Применённое, отсечки, ворота и поколения — заново после блокировки остатков: проведение инвентаризации под той же
      // блокировкой обнуляет применённое (w, f) и сдвигает отсечку; прочитанное до блокировки могло устареть (§4.3).
      // Ключи применённого меняют только проход и компенсация (под блокировкой состояния) — они уже среди заблокированных.
      const current = await this.repository.applied(tx, onecDocumentId);
      for (const key of current.keys()) {
        if (!balances.has(key)) throw new ApiError(409, 'ONEC_PROJECTION_RETRY', 'Изменилось применённое во время прохода — повтор');
      }
      const currentWarehouseIds = [...new Set([...current.keys()].map((key) => parseStockKey(key).warehouseId))];
      const context = await this.repository.context(tx, onecWarehouses, itemKeys);
      const desired = desiredForDocument(view, context, { appliedWarehouseIds: currentWarehouseIds });
      for (const key of desired.desired.keys()) {
        if (!balances.has(key)) throw new ApiError(409, 'ONEC_PROJECTION_RETRY', 'Изменились привязки во время прохода — повтор');
      }
      const { deltas, nextApplied } = projectionDeltas(desired, current);
      const documents = await this.writeDeltas(tx, { actor, requestId, view, onecDocumentId, state: { sourceId: view?.sourceId, refKey: view?.onecRefKey }, deltas, balances });
      await this.repository.saveOutcome(tx, { onecDocumentId, nextApplied, view, hash: projectionHash(view, desired), issues: desired.issues });
      return documents;
    });
  }

  private async writeDeltas(
    tx: TransactionClient,
    input: {
      actor: ProjectionActor; requestId: string; view: ConsumptionDocumentView | null; onecDocumentId: number;
      state: { sourceId?: number; refKey?: string }; deltas: Map<string, number>; balances: Map<string, number>;
      reason?: 'projection' | 'compensate';
    },
  ): Promise<number> {
    const byWarehouse = new Map<number, Map<number, number>>();
    for (const [key, cents] of input.deltas) {
      const { warehouseId, filmId } = parseStockKey(key);
      if (!byWarehouse.has(warehouseId)) byWarehouse.set(warehouseId, new Map());
      byWarehouse.get(warehouseId)!.set(filmId, cents);
    }
    if (byWarehouse.size === 0) return 0;
    const ids = await tx.query<{ onec_source_id: string; onec_ref_key: string }>(
      'SELECT onec_source_id, onec_ref_key::text AS onec_ref_key FROM inventory_onec_projection WHERE onec_document_id = $1',
      [input.onecDocumentId],
    );
    const sourceId = input.state.sourceId ?? Number(ids.rows[0].onec_source_id);
    const refKey = input.state.refKey ?? ids.rows[0].onec_ref_key;
    for (const warehouseId of [...byWarehouse.keys()].sort((a, b) => a - b)) {
      await this.repository.writeDelta(tx, {
        actor: input.actor, requestId: input.requestId, view: input.view, onecDocumentId: input.onecDocumentId,
        onecSourceId: sourceId, onecRefKey: refKey, warehouseId, deltas: byWarehouse.get(warehouseId)!, balances: input.balances,
        reason: input.reason,
      });
    }
    return byWarehouse.size;
  }

  /**
   * Компенсация склада (откат, §7.3): since := NULL и применённое склада → 0 по всем документам 1С любого
   * источника. Без чтения документов 1С (работает при выключенном модуле 1С, флаге проекции и AMBIGUOUS_SOURCE).
   */
  async compensate(ctx: CommandContext, warehouseId: number): Promise<OnecCompensationResult> {
    this.require(ctx.currentUser.permissions, 'inventory.manage');
    const start = await this.warehouses.beginOnecCompensation(ctx, warehouseId);
    if (start.replay) return start.replay;
    const actor = { id: Number(ctx.currentUser.id), username: ctx.currentUser.username ?? '', role: ctx.currentUser.role };
    const mineOf = (applied: Map<string, number>) => new Map([...applied].filter(([key]) => parseStockKey(key).warehouseId === warehouseId));
    let documents = 0;
    for (const onecDocumentId of await this.repository.documentsWithApplied(this.database, warehouseId)) {
      documents += await this.database.transaction(async (tx) => {
        const state = await this.repository.lockState(tx, onecDocumentId, null);
        if (!state) return 0;
        const seen = mineOf(await this.repository.applied(tx, onecDocumentId));
        if (seen.size === 0) return 0;
        // Откат актуален, только пока дата начала пуста: склад FOR SHARE (конфликтует с изменением склада) и проверка
        // в каждой транзакции документа — расход, снова включённый посреди отката, прежний откат не трогает.
        const warehouse = await tx.query<{ since: Date | null }>(
          'SELECT onec_consumption_since AS since FROM warehouses WHERE warehouse_id = $1 FOR SHARE', [warehouseId],
        );
        if (warehouse.rows[0]?.since != null) throw supersededCompensation();
        await tx.query(
          'SELECT film_id FROM films WHERE film_id = ANY($1::bigint[]) ORDER BY film_id FOR SHARE',
          [[...seen.keys()].map((key) => parseStockKey(key).filmId)],
        );
        const balances = await this.repository.lockBalances(tx, [...seen.keys()]);
        // Применённое — заново под блокировкой остатков: проведённая тем временем инвентаризация его обнулила.
        const mine = mineOf(await this.repository.applied(tx, onecDocumentId));
        for (const key of mine.keys()) {
          if (!balances.has(key)) throw new ApiError(409, 'ONEC_PROJECTION_RETRY', 'Изменилось применённое во время отката — повторите');
        }
        const deltas = new Map([...mine].filter(([, cents]) => cents !== 0).map(([key, cents]) => [key, -cents]));
        const written = await this.writeDeltas(tx, { actor, requestId: ctx.requestId, view: null, onecDocumentId, state: {}, deltas, balances, reason: 'compensate' });
        // hash сброшен: следующий обычный проход пересчитает документ (при since = NULL желаемое по складу — 0).
        await tx.query('DELETE FROM inventory_onec_applied WHERE onec_document_id = $1 AND warehouse_id = $2', [onecDocumentId, warehouseId]);
        await tx.query('UPDATE inventory_onec_projection SET inputs_hash = NULL, updated_at = now() WHERE onec_document_id = $1', [onecDocumentId]);
        return written;
      });
    }
    const result = { documents, remaining: await this.repository.appliedTotal(this.database, warehouseId) };
    return this.warehouses.completeOnecCompensation(ctx, warehouseId, result);
  }

  private require(permissions: readonly string[], permission: 'inventory.view' | 'inventory.manage'): void {
    if (!this.inventory.enabled()) throw new ApiError(404, 'NOT_FOUND', 'Склад выключен');
    if (!permissions.includes(permission)) {
      throw new ApiError(403, 'FORBIDDEN', 'Недостаточно прав', { requiredPermissions: [permission] });
    }
  }

  listIssues(permissions: readonly string[], filter: { warehouseId: number | null; code: string | null; includeBeforeCutoff: boolean; offset: number; limit: number }) {
    this.require(permissions, 'inventory.view');
    return this.repository.listIssues(this.database, filter);
  }

  /**
   * Ручной запуск прохода («Пересчитать сейчас»; при выключенном флаге — skipped). Движения прохода пишутся от
   * служебного исполнителя с requestId прохода. Кто и каким HTTP-запросом его запустил, сохраняется ДО начала прохода
   * событием аудита `inventory.onec_consumption_run_requested` (инициатор, requestId запроса, requestId прохода): связь
   * остаётся и тогда, когда проход записал движения и упал позже. Итог или сбой — отдельным событием
   * `inventory.onec_consumption_run_finished`.
   */
  async runNow(ctx: { currentUser: CurrentUser; requestId: string }): Promise<ProjectionPassOutcome> {
    this.require(ctx.currentUser.permissions, 'inventory.manage');
    if (!this.enabled()) return { status: 'skipped', reason: 'disabled' };
    const record = (event: 'requested' | 'finished', passRequestId: string, statusCode: string, metadata: Record<string, unknown>) =>
      this.database.transaction((tx) => auditService.record(tx, {
        event: `inventory.onec_consumption_run_${event}`,
        entityType: 'inventory_onec_projection',
        entityId: passRequestId,
        actorUserId: ctx.currentUser.id,
        actorUsername: ctx.currentUser.username ?? null,
        actorRole: ctx.currentUser.role ?? null,
        requestId: ctx.requestId,
        source: 'inventory',
        statusField: 'status',
        statusCode,
        stageCode: 'manual_run',
        metadata: { passRequestId, ...metadata },
      }));
    let begun: ReturnType<InventoryOnecProjectionService['beginPass']>;
    if (this.running && this.runningRequestId) {
      // Проход уже идёт (запущен не этим запросом): присоединиться и записать связь с ним, не дожидаясь итога.
      begun = this.beginPass('manual');
      await record('requested', begun.passRequestId, 'joined', { joined: true });
    } else {
      const planned = `onec-consumption-manual-${randomUUID()}`;
      await record('requested', planned, 'started', { joined: false });
      begun = this.beginPass('manual', planned);
      // Пока писалась связь, проход мог начать другой сигнал — тогда движения помечены его requestId.
      if (begun.joined) await record('requested', begun.passRequestId, 'joined', { joined: true, plannedPassRequestId: planned });
    }
    let outcome: ProjectionPassOutcome;
    try {
      outcome = await begun.done;
    } catch (error) {
      await record('finished', begun.passRequestId, 'failed', { error: describe(error) })
        .catch((auditError) => this.logger.error(`1C consumption manual run: failure audit not written: ${describe(auditError)}`));
      throw error;
    }
    await record('finished', begun.passRequestId, outcome.status, { outcome });
    return outcome;
  }

  /** Служебный исполнитель: тот же, что у автосинхронизации складов (is_service_account, integration_service). */
  private async readyActor(): Promise<ProjectionActor> {
    const id = Number(this.config.get('BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID', { infer: true }) || 0);
    const { rows } = await this.database.query<{ user_id: string; username: string }>(
      `SELECT u.user_id, u.username
         FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = $1 AND u.is_active = true AND u.is_service_account = true
          AND r.role_code = 'integration_service' AND r.is_active = true`,
      [id],
    );
    if (!rows[0]) throw new ApiError(503, 'ACTOR_NOT_READY', 'Служебный пользователь проекции расхода 1С не готов');
    return { id: Number(rows[0].user_id), username: rows[0].username };
  }
}
