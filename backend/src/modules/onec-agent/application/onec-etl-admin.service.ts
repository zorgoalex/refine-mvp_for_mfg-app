import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { PgOnecEtlRepository } from '../adapters/pg-onec-etl-repository';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

/** Read side of the ETL tab: runs, their batches, entity state. No row data. */
@Injectable()
export class OnecEtlAdminService {
  constructor(
    @Inject(PgOnecEtlRepository) private readonly etl: PgOnecEtlRepository,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  async listRuns(query: { agentId?: string; limit?: string }) {
    this.runtime.requireEnabled();
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const rows = await this.etl.listRuns({ agentId: query.agentId || undefined, limit });
    return rows.map(runView);
  }

  async getRun(runId: string) {
    this.runtime.requireEnabled();
    const row = await this.etl.getRunView(runId);
    if (!row) throw new ApiError(404, 'ONEC_ETL_RUN_NOT_FOUND', 'Выгрузка не найдена');
    const batches = await this.etl.listRunBatches(this.etl.db, runId);
    return {
      ...runView(row),
      batches: batches.map((b) => ({
        batchId: b.batchId,
        entity: b.entityCode,
        status: b.status,
        rowCount: b.rowCount,
        parsedRows: b.parsedRows,
        invalidReason: b.invalidReason,
        parseAttempt: b.parseAttempt,
        receivedAt: iso(b.receivedAt),
        acknowledged: b.ack !== null,
      })),
    };
  }

  async listEntities(agentId: string | undefined) {
    this.runtime.requireEnabled();
    let sourceId: number | null = null;
    if (agentId) {
      const agent = await this.repository.getAgent(this.repository.db, agentId);
      if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
      sourceId = agent.sourceId;
    }
    const rows = await this.etl.listEntityStates(sourceId);
    return rows.map((row) => ({
      sourceId: Number(row.source_id),
      entity: row.entity_code,
      lastRunId: row.last_run_id,
      lastRunAt: iso(row.last_run_at),
      lastStatus: row.last_status,
      lastReadScope: row.last_read_scope,
      lastCompleteness: row.last_completeness,
      lastCompletenessReason: row.last_completeness_reason,
      lastSnapshotAt: iso(row.last_snapshot_at),
      lastFullAt: iso(row.last_full_at),
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      rowCount: Number(row.row_count),
      deletedCount: Number(row.deleted_count),
      missingCount: Number(row.missing_count),
    }));
  }
}

function runView(row: QueryResultRow) {
  return {
    runId: row.run_id,
    agentId: row.agent_id,
    sourceId: Number(row.source_id),
    sourceGeneration: Number(row.source_generation),
    status: row.status,
    mode: row.mode,
    modeOrigin: row.mode_origin,
    commandId: row.command_id,
    batchCount: Number(row.batch_count ?? 0),
    rowTotal: Number(row.row_total ?? 0),
    entitiesFailed: row.entities_failed === null ? null : Number(row.entities_failed),
    entities: (row.completion?.entities as unknown[] | undefined) ?? null,
    createdAt: iso(row.created_at),
    firstBatchAt: iso(row.first_batch_at),
    completedAt: iso(row.completed_at),
  };
}
