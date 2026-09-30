import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import { OnecAlertsPort } from '../../onec-agent/application/onec-alerts-port';
import { OnecEtlEvents, type EntitiesPublished } from '../../onec-agent/application/onec-etl-events';
import { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { PgOnecDocumentsLoaderRepository, type LoadContext } from '../adapters/pg-onec-documents-loader-repository';
import { DOCUMENT_ENTITIES } from '../domain/onec-document-normalizer';
import { OnecDocumentConsumers } from './onec-document-consumers';

export const LOAD_ALERT_KIND = 'onec_documents_load_failed';
const HOURLY_MS = 60 * 60_000;
const FIRST_PASS_DELAY_MS = 60_000;

export type LoadTrigger =
  | { kind: 'run'; sourceId: number; entityCode: string; runId: string; requestId: string; correlationId: string }
  | { kind: 'hourly'; sourceId: number; entityCode: string; hour: string };

export interface PassResult {
  created: number;
  changed: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  invalid: Record<string, number>;
  failed: number;
}

export type PassOutcome =
  | { status: 'skipped'; reason: 'disabled' | 'not_a_document' | 'rerun_queued' }
  | { status: 'succeeded' | 'failed'; seq: number; result: PassResult };

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.code : error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : 'unknown error';

/**
 * Загрузчик документов 1С (модуль onec-sync, план 2026-09-30-onec-documents-loader-plan.md): копия ETL →
 * onec_documents / onec_document_lines, потребители — через порт. Запуск — сигнал после commit `complete` и
 * часовой проход; проход обходит документы вида в хронологическом порядке, каждый — своей транзакцией.
 * Итог и алерт прохода пишет только проход с номером больше последнего записанного (как автосинхронизация складов).
 */
@Injectable()
export class OnecDocumentsLoaderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnecDocumentsLoaderService.name);
  private readonly repository: PgOnecDocumentsLoaderRepository;
  private readonly running = new Map<string, LoadTrigger | null>();
  private unsubscribe: (() => void) | null = null;
  private firstPass: NodeJS.Timeout | null = null;
  private hourly: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(OnecCatalogReader) private readonly reader: OnecCatalogReader,
    @Inject(OnecEtlEvents) private readonly events: OnecEtlEvents,
    @Inject(OnecAlertsPort) private readonly alerts: OnecAlertsPort,
    @Inject(OnecDocumentConsumers) consumers: OnecDocumentConsumers,
  ) {
    this.repository = new PgOnecDocumentsLoaderRepository(database, reader, consumers, alerts);
  }

  onModuleInit(): void {
    if (!this.configured()) return;
    this.unsubscribe = this.events.onEntitiesPublished((event) => this.onPublished(event));
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

  /** Флаг загрузчика и модуль закупок (единственный потребитель сейчас); модуль 1С — при чтении копии. */
  private configured(): boolean {
    return this.config.get('BACKEND_ONEC_DOCUMENTS_LOAD', { infer: true }) === true
      && this.config.get('BACKEND_RESOURCE_PROCUREMENT_ENABLED', { infer: true }) === true;
  }

  /** Граница сигнала: фоновая загрузка не должна ронять процесс. */
  private async onPublished(event: EntitiesPublished): Promise<void> {
    for (const entityCode of event.entities.filter((entity) => entity in DOCUMENT_ENTITIES)) {
      try {
        const outcome = await this.run({ kind: 'run', sourceId: event.sourceId, entityCode, runId: event.runId, requestId: event.requestId, correlationId: event.correlationId });
        this.logger.log(`1C documents ${entityCode} after run ${event.runId}: ${JSON.stringify(outcome)}`);
      } catch (error) {
        this.logger.error(`1C documents ${entityCode} after run ${event.runId} failed: ${describe(error)}`);
      }
    }
  }

  async safeHourlyPass(now = new Date()): Promise<void> {
    try {
      await this.hourlyPass(now);
    } catch (error) {
      this.logger.error(`1C documents hourly pass failed: ${describe(error)}`);
    }
  }

  async hourlyPass(now = new Date()): Promise<void> {
    if (!this.configured()) return;
    const hour = now.toISOString().slice(0, 13).replace(/[-T]/g, '');
    for (const entityCode of Object.keys(DOCUMENT_ENTITIES).sort()) {
      const sources = await this.sourcesOrNull(entityCode);
      if (sources === null) return;
      for (const sourceId of sources) {
        try {
          const outcome = await this.run({ kind: 'hourly', sourceId, entityCode, hour });
          if (outcome.status === 'failed') this.logger.warn(`1C documents ${entityCode} source ${sourceId}: ${JSON.stringify(outcome.result)}`);
        } catch (error) {
          this.logger.error(`1C documents ${entityCode} source ${sourceId} failed: ${describe(error)}`);
        }
      }
    }
  }

  private async sourcesOrNull(entityCode: string): Promise<number[] | null> {
    try {
      return await this.reader.entitySourceIds(entityCode);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return null;
      throw error;
    }
  }

  /**
   * Один проход по виду документа источника. Параллельный запрос того же вида в этом процессе не запускает второй
   * проход, а ставит повтор после текущего (копия могла измениться за время прохода).
   */
  async run(trigger: LoadTrigger): Promise<PassOutcome> {
    const config = DOCUMENT_ENTITIES[trigger.entityCode];
    if (!config) return { status: 'skipped', reason: 'not_a_document' };
    if (!this.configured() || (await this.sourcesOrNull(trigger.entityCode)) === null) return { status: 'skipped', reason: 'disabled' };
    const slot = `${trigger.sourceId}:${trigger.entityCode}`;
    if (this.running.has(slot)) {
      this.running.set(slot, trigger);
      return { status: 'skipped', reason: 'rerun_queued' };
    }
    this.running.set(slot, null);
    try {
      let outcome = await this.pass(trigger);
      for (let queued = this.running.get(slot); queued; queued = this.running.get(slot)) {
        this.running.set(slot, null);
        outcome = await this.pass(queued);
      }
      return outcome;
    } finally {
      this.running.delete(slot);
    }
  }

  private async pass(trigger: LoadTrigger): Promise<PassOutcome> {
    const config = DOCUMENT_ENTITIES[trigger.entityCode];
    const seq = await this.allocateSeq(trigger.sourceId, trigger.entityCode);
    const result: PassResult = { created: 0, changed: 0, unchanged: 0, skipped: 0, conflicts: 0, invalid: {}, failed: 0 };
    let firstError: string | null = null;
    try {
      const ctx: LoadContext = trigger.kind === 'run'
        ? { sourceId: trigger.sourceId, entityCode: trigger.entityCode, config, requestId: trigger.requestId, correlationId: trigger.correlationId, runId: trigger.runId }
        : { sourceId: trigger.sourceId, entityCode: trigger.entityCode, config, runId: null,
          requestId: `onec-documents-hourly-${trigger.sourceId}-${trigger.entityCode}-${trigger.hour}`,
          correlationId: `onec-documents-hourly-${trigger.sourceId}-${trigger.entityCode}-${trigger.hour}` };
      const refs = await this.repository.loadReferences(trigger.sourceId);
      const stored = await this.repository.storedState(trigger.sourceId, config.docKind);
      const keys = await this.reader.orderedDocumentKeys(trigger.sourceId, trigger.entityCode);
      const rows = await this.reader.mirrorRows(this.database, trigger.sourceId, trigger.entityCode, keys);
      for (const key of keys) {
        const row = rows.get(key);
        const preview = row ? this.repository.previewFingerprint(ctx, row.data, row.missing, refs) : null;
        const known = preview ? stored.get(preview.refKey) : undefined;
        if (preview && known && known.observed === preview.fingerprint && !known.blocking) { result.unchanged += 1; continue; }
        try {
          const outcome = await this.repository.loadDocument(ctx, key, refs);
          if (outcome.status === 'invalid') result.invalid[outcome.code] = (result.invalid[outcome.code] ?? 0) + 1;
          else { result[outcome.status] += 1; result.conflicts += outcome.conflicts; }
        } catch (error) {
          result.failed += 1;
          firstError ??= describe(error);
          this.logger.error(`1C document ${trigger.entityCode}/${key} failed: ${describe(error)}`);
        }
      }
    } catch (error) {
      result.failed += 1;
      firstError ??= describe(error);
    }
    const invalid = Object.keys(result.invalid).length > 0;
    const ok = result.failed === 0 && !invalid;
    const code = ok ? null : result.failed > 0 ? (firstError ?? 'LOAD_ERROR').slice(0, 64) : `INVALID_DOCUMENTS:${Object.keys(result.invalid).sort().join(',')}`.slice(0, 64);
    await this.database.transaction((tx) => this.finish(tx, trigger, seq, ok, code, result));
    return { status: ok ? 'succeeded' : 'failed', seq, result };
  }

  /** Отдельная короткая транзакция до прохода: откат прохода номер не возвращает. */
  private async allocateSeq(sourceId: number, entityCode: string): Promise<number> {
    const { rows } = await this.database.query<{ last_seq: string }>(
      `INSERT INTO onec_documents_load_state AS state (source_id, entity_code, last_seq, finished_seq)
       VALUES ($1, $2, 1, 0)
       ON CONFLICT (source_id, entity_code) DO UPDATE SET last_seq = state.last_seq + 1
       RETURNING last_seq`,
      [sourceId, entityCode],
    );
    return Number(rows[0].last_seq);
  }

  /** Итог и алерт — только от самого свежего завершившегося прохода (seq > finished_seq). */
  private async finish(tx: DatabaseClient, trigger: LoadTrigger, seq: number, ok: boolean, code: string | null, result: PassResult): Promise<void> {
    const { rows } = await tx.query<{ finished_seq: string }>(
      'SELECT finished_seq FROM onec_documents_load_state WHERE source_id = $1 AND entity_code = $2 FOR UPDATE',
      [trigger.sourceId, trigger.entityCode],
    );
    if (!rows[0] || Number(rows[0].finished_seq) >= seq) return;
    await tx.query(
      `UPDATE onec_documents_load_state SET finished_seq = $3, finished_at = now(), last_outcome = $4, last_error_code = $5, last_result = $6::jsonb
        WHERE source_id = $1 AND entity_code = $2`,
      [trigger.sourceId, trigger.entityCode, seq, ok ? 'succeeded' : 'failed', code, JSON.stringify(result)],
    );
    const dedupeKey = `${LOAD_ALERT_KIND}:${trigger.sourceId}:${trigger.entityCode}`;
    if (ok) await this.alerts.resolve(tx, dedupeKey);
    else await this.alerts.raise(tx, { kind: LOAD_ALERT_KIND, sourceId: trigger.sourceId, dedupeKey, severity: 'warning', details: { entityCode: trigger.entityCode, seq, code, result } });
  }
}
