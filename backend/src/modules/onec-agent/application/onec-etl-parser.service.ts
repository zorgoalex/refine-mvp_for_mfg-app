import { promises as fs } from 'node:fs';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PgOnecEtlRepository, type BatchRow, type StagingChunkRow } from '../adapters/pg-onec-etl-repository';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { checkRowLine, ONEC_ETL_LIMITS } from '../domain/onec-etl';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { EtlLimitError, readLines } from './onec-etl-spool';

const POLL_MS = 2000;

/**
 * Owner-gated background parser (BACKEND_ONEC_ETL_WORKER_OWNER=in_process):
 * stored batch → staging rows (plan §6.6). One batch at a time per process;
 * several processes never parse the same batch (SKIP LOCKED claim, attempt
 * number on every write). Parsing runs on the event loop in 1000-row chunks
 * with awaits between them (deviation from worker_threads, see review packet).
 */
@Injectable()
export class OnecEtlParserService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnecEtlParserService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(
    @Inject(PgOnecEtlRepository) private readonly etl: PgOnecEtlRepository,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.owns()) return;
    this.timer = setInterval(() => this.wake(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private owns(): boolean {
    const config = this.runtime.get();
    return config.enabled && config.etlWorkerOwner === 'in_process';
  }

  /** Called after a batch is stored and by complete while it waits. */
  wake(): void {
    if (!this.owns() || this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.drainQueue();
  }

  /** Parses stored batches until none is left (also used directly by tests). */
  async drainQueue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let parsed = 0;
    try {
      do {
        this.again = false;
        for (;;) {
          if (this.stopped) return parsed;
          const batch = await this.etl.transaction((tx) => this.etl.claimForParse(tx));
          if (!batch) break;
          await this.parseBatch(batch);
          parsed += 1;
        }
      } while (this.again);
    } catch (error) {
      this.logger.error(`1C ETL parser failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
    return parsed;
  }

  private async parseBatch(batch: BatchRow): Promise<void> {
    const attempt = batch.parseAttempt;
    if (!batch.spoolPath || !(await exists(batch.spoolPath))) {
      await this.invalid(batch, attempt, 'SPOOL_MISSING', null);
      return;
    }
    let lineNo = 0;
    let chunk: StagingChunkRow[] = [];
    const flush = async (): Promise<boolean> => {
      if (chunk.length === 0) return true;
      const ok = await this.etl.insertStagingChunk(batch, attempt, chunk);
      chunk = [];
      return ok;
    };
    try {
      for await (const line of readLines(batch.spoolPath)) {
        lineNo += 1;
        const check = checkRowLine(line);
        if (!check.ok) {
          await this.invalid(batch, attempt, check.reason, lineNo);
          return;
        }
        chunk.push({ lineNo, line, ...check.row });
        if (chunk.length >= ONEC_ETL_LIMITS.parseChunkRows && !(await flush())) return; // a newer attempt owns the batch
      }
      if (!(await flush())) return;
    } catch (error) {
      if (error instanceof EtlLimitError) {
        await this.invalid(batch, attempt, error.code, lineNo);
        return;
      }
      throw error;
    }
    const outcome = await this.etl.finishParse(batch, attempt);
    if (outcome === 'invalid') await this.incident(batch, 'ROW_COUNT_AFTER_PARSE', null);
  }

  private async invalid(batch: BatchRow, attempt: number, reason: string, lineNo: number | null): Promise<void> {
    if (await this.etl.markInvalid(batch.batchId, attempt, reason)) await this.incident(batch, reason, lineNo);
  }

  /** No row data in incidents: identifiers, reason and line number only. */
  private async incident(batch: BatchRow, reason: string, lineNo: number | null): Promise<void> {
    await this.repository.recordIncident(this.repository.db, {
      agentId: batch.agentId,
      kind: 'etl_batch_invalid',
      dedupeKey: `etl_batch_invalid:${batch.batchId}`,
      details: { batchId: batch.batchId, runId: batch.runId, entity: batch.entityCode, reason, lineNo },
      runId: batch.runId,
      batchId: batch.batchId,
    });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
