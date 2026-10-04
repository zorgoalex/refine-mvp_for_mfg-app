import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';

/**
 * SQL of the E3a ETL intake. Lock order for every ETL operation (plan §6.7):
 * onec_etl_runs (FOR UPDATE) → onec_etl_batches → onec_etl_entity_state → staging/mirror.
 */

export interface RunRow {
  runId: string;
  agentId: string;
  sourceId: number;
  sourceGeneration: number;
  generationRef: string;
  sourceNamespace: string | null;
  mode: string | null;
  modeOrigin: string | null;
  commandId: string | null;
  status: 'receiving' | 'completed' | 'abandoned';
  completionSha256: string | null;
  completedAt: Date | null;
  createdAt: Date;
  /** Entities revoked while this run was open (kept after a later re-enable, plan §21.3). */
  revokedEntities: string[];
}

export interface BatchRow {
  batchId: string;
  runId: string;
  agentId: string;
  entityCode: string;
  schemaVersion: number;
  rowCount: number;
  contentSha256: string;
  spoolPath: string | null;
  status: 'receiving' | 'stored' | 'parsing' | 'parsed' | 'invalid' | 'discarded' | 'finalized';
  receivingOwner: string | null;
  invalidReason: string | null;
  parseAttempt: number;
  parsedRows: number | null;
  ack: Record<string, unknown> | null;
  receivedAt: Date;
  updatedAt: Date;
  revoked: boolean;
}

const toRun = (row: QueryResultRow): RunRow => ({
  runId: row.run_id,
  agentId: row.agent_id,
  sourceId: Number(row.source_id),
  sourceGeneration: Number(row.source_generation),
  generationRef: row.generation_ref,
  sourceNamespace: row.source_namespace,
  mode: row.mode,
  modeOrigin: row.mode_origin,
  commandId: row.command_id,
  status: row.status,
  completionSha256: row.completion_sha256,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  revokedEntities: row.revoked_entities ?? [],
});

const toBatch = (row: QueryResultRow): BatchRow => ({
  batchId: row.batch_id,
  runId: row.run_id,
  agentId: row.agent_id,
  entityCode: row.entity_code,
  schemaVersion: Number(row.schema_version),
  rowCount: Number(row.row_count),
  contentSha256: row.content_sha256,
  spoolPath: row.spool_path,
  status: row.status,
  receivingOwner: row.receiving_owner,
  invalidReason: row.invalid_reason,
  parseAttempt: Number(row.parse_attempt),
  parsedRows: row.parsed_rows === null ? null : Number(row.parsed_rows),
  ack: row.ack,
  receivedAt: row.received_at,
  updatedAt: row.updated_at,
  revoked: row.revoked === true,
});

export interface EntityStateRow {
  revokedAt: Date | null;
  purgedAt: Date | null;
  snapshotVersion: Date | null;
}

const toEntityState = (row: QueryResultRow): EntityStateRow => ({
  revokedAt: row.revoked_at ?? null,
  purgedAt: row.purged_at ?? null,
  snapshotVersion: row.snapshot_version ?? null,
});

export interface StagingChunkRow {
  lineNo: number;
  line: string;
  sourceKey: string;
  sourceUpdatedAt: string | null;
  deleted: boolean;
}

export interface EntityOutcome {
  entityCode: string;
  status: 'done' | 'failed';
  readScope: string | null;
  completeness: string | null;
  completenessReason: string | null;
  snapshotAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  fullRead: boolean;
}

@Injectable()
export class PgOnecEtlRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  get db(): DatabaseClient {
    return this.database;
  }

  transaction<T>(handler: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    return this.database.transaction(handler);
  }

  // ---------------------------------------------------------------- runs

  async getRun(client: DatabaseClient, runId: string, forUpdate = false): Promise<RunRow | null> {
    const { rows } = await client.query(`SELECT * FROM onec_etl_runs WHERE run_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [runId]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** Creates the run if absent (race-safe); returns the row locked FOR UPDATE. */
  async lockOrCreateRun(
    tx: DatabaseClient,
    run: { runId: string; agentId: string; sourceId: number; generation: number; generationRef: string; namespace: string | null },
  ): Promise<RunRow> {
    await tx.query(
      `INSERT INTO onec_etl_runs (run_id, agent_id, source_id, source_generation, generation_ref, source_namespace)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id) DO NOTHING`,
      [run.runId, run.agentId, run.sourceId, run.generation, run.generationRef, run.namespace],
    );
    return (await this.getRun(tx, run.runId, true))!;
  }

  async setRunNamespace(tx: DatabaseClient, runId: string, namespace: string): Promise<void> {
    await tx.query(`UPDATE onec_etl_runs SET source_namespace = $2, updated_at = now() WHERE run_id = $1 AND source_namespace IS NULL`, [runId, namespace]);
  }

  async touchFirstBatch(tx: DatabaseClient, runId: string): Promise<void> {
    await tx.query(`UPDATE onec_etl_runs SET first_batch_at = COALESCE(first_batch_at, now()), updated_at = now() WHERE run_id = $1`, [runId]);
  }

  /** Mode from an accepted start_full_sync/reload_entity result (data.runId). Never overrides the complete body. */
  async recordCommandMode(
    tx: DatabaseClient,
    run: { runId: string; agentId: string; sourceId: number; generation: number; generationRef: string; mode: string; commandId: string },
  ): Promise<{ created: boolean; completed: boolean; modeOrigin: string | null; mode: string | null }> {
    const { rows } = await tx.query(
      `INSERT INTO onec_etl_runs (run_id, agent_id, source_id, source_generation, generation_ref, mode, mode_origin, command_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'command_result', $7)
       ON CONFLICT (run_id) DO UPDATE SET
         mode = CASE WHEN onec_etl_runs.status = 'receiving' AND onec_etl_runs.mode_origin IS DISTINCT FROM 'complete_body'
                     THEN EXCLUDED.mode ELSE onec_etl_runs.mode END,
         mode_origin = CASE WHEN onec_etl_runs.status = 'receiving' AND onec_etl_runs.mode_origin IS DISTINCT FROM 'complete_body'
                     THEN 'command_result' ELSE onec_etl_runs.mode_origin END,
         command_id = COALESCE(onec_etl_runs.command_id, EXCLUDED.command_id),
         updated_at = now()
       WHERE onec_etl_runs.agent_id = EXCLUDED.agent_id
       RETURNING (xmax = 0) AS created, status, mode_origin, mode`,
      [run.runId, run.agentId, run.sourceId, run.generation, run.generationRef, run.mode, run.commandId],
    );
    const row = rows[0];
    return { created: row?.created === true, completed: row?.status === 'completed', modeOrigin: row?.mode_origin ?? null, mode: row?.mode ?? null };
  }

  /** An ETL command the agent has but whose result has not arrived yet (plan §6.7 step 3). */
  async hasPendingEtlCommand(client: DatabaseClient, agentId: string): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM onec_agent_commands WHERE agent_id = $1
         AND command_type IN ('start_full_sync','reload_entity') AND status IN ('leased','received')) AS pending`,
      [agentId],
    );
    return rows[0]?.pending === true;
  }

  // ---------------------------------------------------------------- batches

  async getBatch(client: DatabaseClient, batchId: string, forUpdate = false): Promise<BatchRow | null> {
    const { rows } = await client.query(`SELECT * FROM onec_etl_batches WHERE batch_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [batchId]);
    return rows[0] ? toBatch(rows[0]) : null;
  }

  async insertReservation(
    tx: DatabaseClient,
    batch: { batchId: string; runId: string; agentId: string; entityCode: string; schemaVersion: number; rowCount: number; sha256: string; owner: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO onec_etl_batches (batch_id, run_id, agent_id, entity_code, schema_version, row_count, content_sha256,
         status, receiving_owner, receiving_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'receiving', $8, now())`,
      [batch.batchId, batch.runId, batch.agentId, batch.entityCode, batch.schemaVersion, batch.rowCount, batch.sha256, batch.owner],
    );
  }

  /** The row is locked by the caller: a repeat of an unfinished attempt takes over. */
  async supersedeReservation(tx: DatabaseClient, batchId: string, owner: string): Promise<void> {
    await tx.query(
      `UPDATE onec_etl_batches SET receiving_owner = $2, receiving_heartbeat_at = now(), updated_at = now() WHERE batch_id = $1`,
      [batchId, owner],
    );
  }

  /** Removes only this attempt's reservation; returns whether it still owned it. */
  async deleteReservation(client: DatabaseClient, batchId: string, owner: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `DELETE FROM onec_etl_batches WHERE batch_id = $1 AND receiving_owner = $2 AND status = 'receiving'`,
      [batchId, owner],
    );
    return (rowCount ?? 0) > 0;
  }

  async heartbeatReservation(client: DatabaseClient, batchId: string, owner: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE onec_etl_batches SET receiving_heartbeat_at = now() WHERE batch_id = $1 AND receiving_owner = $2 AND status = 'receiving'`,
      [batchId, owner],
    );
    return (rowCount ?? 0) > 0;
  }

  /** receiving → stored only while this attempt still owns the reservation. */
  async markStored(
    tx: DatabaseClient,
    input: { batchId: string; owner: string; spoolPath: string; ack: Record<string, unknown>; compressedBytes: number; uncompressedBytes: number },
  ): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE onec_etl_batches SET status = 'stored', spool_path = $3, ack = $4::jsonb, compressed_bytes = $5,
              uncompressed_bytes = $6, stored_at = now(), receiving_owner = NULL, receiving_heartbeat_at = NULL, updated_at = now()
        WHERE batch_id = $1 AND receiving_owner = $2 AND status = 'receiving'`,
      [input.batchId, input.owner, input.spoolPath, JSON.stringify(input.ack), input.compressedBytes, input.uncompressedBytes],
    );
    return (rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------- parsing

  /** Claims one stored batch: parsing, attempt+1, leftovers of a crashed attempt removed. */
  async claimForParse(tx: DatabaseClient): Promise<BatchRow | null> {
    const { rows } = await tx.query(
      `UPDATE onec_etl_batches b SET status = 'parsing', parse_attempt = b.parse_attempt + 1, parse_heartbeat_at = now(), updated_at = now()
        WHERE b.batch_id = (SELECT batch_id FROM onec_etl_batches WHERE status = 'stored'
                             ORDER BY stored_at, batch_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING b.*`,
    );
    if (!rows[0]) return null;
    const batch = toBatch(rows[0]);
    await tx.query(`DELETE FROM onec_etl_staging_rows WHERE batch_id = $1`, [batch.batchId]);
    return batch;
  }

  /**
   * One chunk in its own transaction; written only by the current attempt of a
   * batch still in parsing (a stale attempt writes nothing). The raw line is
   * cast by PostgreSQL so numeric lexemes of 1C values stay exact.
   */
  async insertStagingChunk(batch: BatchRow, attempt: number, rows: StagingChunkRow[]): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const current = await tx.query(
        `SELECT r.source_id, r.revoked_entities FROM onec_etl_batches b JOIN onec_etl_runs r ON r.run_id = b.run_id
          WHERE b.batch_id = $1 AND b.status = 'parsing' AND b.parse_attempt = $2 FOR SHARE OF b`,
        [batch.batchId, attempt],
      );
      if (current.rowCount === 0) return false;
      // Revoked data is never written again (plan §21.3): batch → entity_state order, shared locks.
      if (await this.entityRevoked(tx, Number(current.rows[0].source_id), batch.entityCode, current.rows[0].revoked_entities ?? [])) return false;
      await tx.query(
        `INSERT INTO onec_etl_staging_rows (run_id, batch_id, line_no, entity_code, source_key, source_updated_at, deleted, data)
         SELECT $1, $2, r.line_no, $3, r.source_key, r.source_updated_at, r.deleted, (r.line::jsonb) -> 'data'
           FROM unnest($4::int[], $5::text[], $6::text[], $7::timestamptz[], $8::boolean[])
                AS r(line_no, line, source_key, source_updated_at, deleted)
         ON CONFLICT (batch_id, line_no) DO NOTHING`,
        [
          batch.runId,
          batch.batchId,
          batch.entityCode,
          rows.map((r) => r.lineNo),
          rows.map((r) => r.line),
          rows.map((r) => r.sourceKey),
          rows.map((r) => r.sourceUpdatedAt),
          rows.map((r) => r.deleted),
        ],
      );
      await tx.query(`UPDATE onec_etl_batches SET parse_heartbeat_at = now() WHERE batch_id = $1`, [batch.batchId]);
      return true;
    });
  }

  /** parsing → parsed if every line is in staging, else invalid; only for the current attempt. */
  async finishParse(batch: BatchRow, attempt: number): Promise<'parsed' | 'invalid' | 'stale'> {
    return this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT row_count FROM onec_etl_batches WHERE batch_id = $1 AND status = 'parsing' AND parse_attempt = $2 FOR UPDATE`,
        [batch.batchId, attempt],
      );
      if (locked.rowCount === 0) return 'stale';
      const run = await tx.query(`SELECT source_id, revoked_entities FROM onec_etl_runs WHERE run_id = $1`, [batch.runId]);
      if (await this.entityRevoked(tx, Number(run.rows[0].source_id), batch.entityCode, run.rows[0].revoked_entities ?? [])) {
        await tx.query(`UPDATE onec_etl_batches SET status = 'discarded', revoked = true, updated_at = now() WHERE batch_id = $1`, [batch.batchId]);
        await tx.query(`DELETE FROM onec_etl_staging_rows WHERE batch_id = $1`, [batch.batchId]);
        return 'stale';
      }
      const counted = await tx.query(`SELECT count(*)::int AS n FROM onec_etl_staging_rows WHERE batch_id = $1`, [batch.batchId]);
      const n = Number(counted.rows[0].n);
      if (n !== Number(locked.rows[0].row_count)) {
        await tx.query(
          `UPDATE onec_etl_batches SET status = 'invalid', invalid_reason = 'ROW_COUNT_AFTER_PARSE', parsed_rows = $2, updated_at = now() WHERE batch_id = $1`,
          [batch.batchId, n],
        );
        await tx.query(`DELETE FROM onec_etl_staging_rows WHERE batch_id = $1`, [batch.batchId]);
        return 'invalid';
      }
      await tx.query(
        `UPDATE onec_etl_batches SET status = 'parsed', parsed_rows = $2, parsed_at = now(), updated_at = now() WHERE batch_id = $1`,
        [batch.batchId, n],
      );
      return 'parsed';
    });
  }

  async markInvalid(batchId: string, attempt: number | null, reason: string): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE onec_etl_batches SET status = 'invalid', invalid_reason = $3, updated_at = now()
          WHERE batch_id = $1 AND ($2::int IS NULL OR (status = 'parsing' AND parse_attempt = $2))
            AND status NOT IN ('finalized','discarded','invalid')`,
        [batchId, attempt, reason],
      );
      // A stale attempt (0 rows) must not touch the staging of the current one.
      if ((rowCount ?? 0) === 0) return false;
      await tx.query(`DELETE FROM onec_etl_staging_rows WHERE batch_id = $1`, [batchId]);
      return true;
    });
  }

  // ---------------------------------------------------------------- completion

  async listRunBatches(client: DatabaseClient, runId: string, forUpdate = false): Promise<BatchRow[]> {
    const { rows } = await client.query(
      `SELECT * FROM onec_etl_batches WHERE run_id = $1 ORDER BY received_at, batch_id ${forUpdate ? 'FOR UPDATE' : ''}`,
      [runId],
    );
    return rows.map(toBatch);
  }

  async stagingCount(client: DatabaseClient, batchId: string): Promise<number> {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM onec_etl_staging_rows WHERE batch_id = $1`, [batchId]);
    return Number(rows[0].n);
  }

  /** A parsed batch whose staging vanished (PostgreSQL restart empties UNLOGGED tables) is parsed again. */
  async requeueForParse(tx: DatabaseClient, batchId: string): Promise<void> {
    await tx.query(
      `UPDATE onec_etl_batches SET status = 'stored', parsed_rows = NULL, parsed_at = NULL, updated_at = now() WHERE batch_id = $1 AND status = 'parsed'`,
      [batchId],
    );
  }

  async lockEntityState(tx: DatabaseClient, sourceId: number, entityCode: string): Promise<EntityStateRow> {
    await tx.query(
      `INSERT INTO onec_etl_entity_state (source_id, entity_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [sourceId, entityCode],
    );
    const { rows } = await tx.query(`SELECT * FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2 FOR UPDATE`, [sourceId, entityCode]);
    return toEntityState(rows[0]);
  }

  /** Write gate (plan §21.3): shared lock on the entity state; true when writing its data is forbidden. */
  async entityRevoked(tx: DatabaseClient, sourceId: number, entityCode: string, runRevokedEntities: readonly string[]): Promise<boolean> {
    if (runRevokedEntities.includes(entityCode)) return true;
    const { rows } = await tx.query(
      `SELECT revoked_at FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2 FOR SHARE`,
      [sourceId, entityCode],
    );
    return rows[0]?.revoked_at != null;
  }

  /**
   * Snapshot entity (plan §21.2): the copy becomes exactly the run's set —
   * rows of the run are written as they are (no newer-wins across snapshots,
   * the snapshot version already decided), rows absent from it are removed.
   */
  async replaceSnapshot(tx: DatabaseClient, run: RunRow, entityCode: string): Promise<{ upserted: number; removed: number }> {
    const upsert = await tx.query(
      `WITH latest AS (
         SELECT DISTINCT ON (s.source_key) s.source_key, s.source_updated_at, s.deleted, s.data
           FROM onec_etl_staging_rows s JOIN onec_etl_batches b ON b.batch_id = s.batch_id
          WHERE s.run_id = $1 AND s.entity_code = $3
          ORDER BY s.source_key, b.received_at DESC, b.batch_id DESC, s.line_no DESC)
       INSERT INTO onec_etl_mirror_rows AS m (source_id, entity_code, source_key, source_updated_at, deleted, data, row_hash,
              first_seen_run, last_run_id, missing_in_source_at, missing_in_source_run, updated_at)
       SELECT $2, $3, l.source_key, l.source_updated_at, l.deleted, l.data,
              encode(sha256(convert_to(l.data::text, 'UTF8')), 'hex'), $1, $1, NULL, NULL, now()
         FROM latest l
       ON CONFLICT (source_id, entity_code, source_key) DO UPDATE SET
         source_updated_at = EXCLUDED.source_updated_at, deleted = EXCLUDED.deleted, data = EXCLUDED.data,
         row_hash = EXCLUDED.row_hash, last_run_id = EXCLUDED.last_run_id, updated_at = now()`,
      [run.runId, run.sourceId, entityCode],
    );
    const removed = await tx.query(
      `DELETE FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2 AND last_run_id <> $3`,
      [run.sourceId, entityCode, run.runId],
    );
    return { upserted: upsert.rowCount ?? 0, removed: removed.rowCount ?? 0 };
  }

  async setSnapshotOutcome(tx: DatabaseClient, sourceId: number, entityCode: string, outcome: { version: string | null; rejectedReason: string | null }): Promise<void> {
    await tx.query(
      `UPDATE onec_etl_entity_state SET snapshot_version = COALESCE($3::timestamptz, snapshot_version),
              snapshot_rejected_reason = $4, updated_at = now()
        WHERE source_id = $1 AND entity_code = $2`,
      [sourceId, entityCode, outcome.version, outcome.rejectedReason],
    );
  }

  /**
   * Staging → mirror for one done entity. The latest sourceUpdatedAt wins
   * (NULL loses to a value; on a tie the newer run wins); a row that came in
   * the run always clears its missing mark.
   */
  async publishEntity(tx: DatabaseClient, run: RunRow, entityCode: string): Promise<{ upserted: number }> {
    const { rowCount } = await tx.query(
      `WITH latest AS (
         SELECT DISTINCT ON (s.source_key) s.source_key, s.source_updated_at, s.deleted, s.data
           FROM onec_etl_staging_rows s JOIN onec_etl_batches b ON b.batch_id = s.batch_id
          WHERE s.run_id = $1 AND s.entity_code = $3
          ORDER BY s.source_key, s.source_updated_at DESC NULLS LAST, b.received_at DESC, b.batch_id DESC, s.line_no DESC)
       INSERT INTO onec_etl_mirror_rows AS m (source_id, entity_code, source_key, source_updated_at, deleted, data, row_hash,
              first_seen_run, last_run_id, missing_in_source_at, missing_in_source_run, updated_at)
       SELECT $2, $3, l.source_key, l.source_updated_at, l.deleted, l.data,
              encode(sha256(convert_to(l.data::text, 'UTF8')), 'hex'), $1, $1, NULL, NULL, now()
         FROM latest l
       ON CONFLICT (source_id, entity_code, source_key) DO UPDATE SET
         source_updated_at = CASE WHEN ${newerWins} THEN EXCLUDED.source_updated_at ELSE m.source_updated_at END,
         deleted = CASE WHEN ${newerWins} THEN EXCLUDED.deleted ELSE m.deleted END,
         data = CASE WHEN ${newerWins} THEN EXCLUDED.data ELSE m.data END,
         row_hash = CASE WHEN ${newerWins} THEN EXCLUDED.row_hash ELSE m.row_hash END,
         last_run_id = EXCLUDED.last_run_id,
         missing_in_source_at = NULL,
         missing_in_source_run = NULL,
         updated_at = now()`,
      [run.runId, run.sourceId, entityCode],
    );
    return { upserted: rowCount ?? 0 };
  }

  /** Full read: rows of the entity not seen in this run are marked missing (diagnostics, plan §20). */
  async markMissing(tx: DatabaseClient, run: RunRow, entityCode: string): Promise<number> {
    const { rowCount } = await tx.query(
      `UPDATE onec_etl_mirror_rows SET missing_in_source_at = now(), missing_in_source_run = $1, updated_at = now()
        WHERE source_id = $2 AND entity_code = $3 AND last_run_id <> $1 AND missing_in_source_at IS NULL`,
      [run.runId, run.sourceId, entityCode],
    );
    return rowCount ?? 0;
  }

  async updateEntityState(tx: DatabaseClient, run: RunRow, outcome: EntityOutcome): Promise<void> {
    await tx.query(
      `UPDATE onec_etl_entity_state e SET
         last_run_id = $3, last_run_at = now(), last_status = $4, last_read_scope = $5, last_completeness = $6,
         last_completeness_reason = $7, last_snapshot_at = COALESCE($8::timestamptz, e.last_snapshot_at),
         last_full_run_id = CASE WHEN $4 = 'done' AND $11 THEN $3 ELSE e.last_full_run_id END,
         last_full_at = CASE WHEN $4 = 'done' AND $11 THEN now() ELSE e.last_full_at END,
         last_error_code = $9, last_error_message = $10,
         row_count = c.total, deleted_count = c.deleted, missing_count = c.missing, updated_at = now()
       FROM (SELECT count(*)::int AS total, count(*) FILTER (WHERE deleted)::int AS deleted,
                    count(*) FILTER (WHERE missing_in_source_at IS NOT NULL)::int AS missing
               FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2) c
       WHERE e.source_id = $1 AND e.entity_code = $2`,
      [
        run.sourceId,
        outcome.entityCode,
        run.runId,
        outcome.status,
        outcome.readScope,
        outcome.completeness,
        outcome.completenessReason,
        outcome.snapshotAt,
        outcome.errorCode,
        outcome.errorMessage?.slice(0, 512) ?? null,
        outcome.fullRead,
      ],
    );
  }

  async completeRun(
    tx: DatabaseClient,
    input: { runId: string; mode: string; modeOrigin: string; sha256: string; completion: Record<string, unknown>; entitiesFailed: number },
  ): Promise<void> {
    await tx.query(
      `UPDATE onec_etl_runs SET status = 'completed', mode = $2, mode_origin = $3, completion_sha256 = $4, completion = $5::jsonb,
              entities_failed = $6, completed_at = now(), updated_at = now()
        WHERE run_id = $1`,
      [input.runId, input.mode, input.modeOrigin, input.sha256, JSON.stringify(input.completion), input.entitiesFailed],
    );
    await tx.query(`UPDATE onec_etl_batches SET status = 'finalized', updated_at = now() WHERE run_id = $1 AND status = 'parsed'`, [input.runId]);
    await tx.query(`DELETE FROM onec_etl_staging_rows WHERE run_id = $1`, [input.runId]);
  }

  // ---------------------------------------------------------------- recovery / retention (monitor)

  /** Runs with no complete for 24 h: abandoned, staging dropped (spec §7.2 p.5). */
  async abandonStaleRuns(
    olderThanMs: number,
    onAbandoned: (tx: DatabaseClient, run: { runId: string; agentId: string; sourceId: number; sourceGeneration: number }) => Promise<void>,
  ): Promise<number> {
    return this.database.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE onec_etl_runs r SET status = 'abandoned', updated_at = now()
          WHERE r.run_id IN (SELECT run_id FROM onec_etl_runs WHERE status = 'receiving'
                               AND COALESCE(first_batch_at, created_at) < now() - ($1::bigint * interval '1 millisecond')
                               ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)
          RETURNING r.run_id, r.agent_id, r.source_id, r.source_generation`,
        [olderThanMs],
      );
      for (const row of rows) {
        await tx.query(`UPDATE onec_etl_batches SET status = 'discarded', updated_at = now() WHERE run_id = $1 AND status IN ('stored','parsing','parsed','invalid')`, [row.run_id]);
        await tx.query(`DELETE FROM onec_etl_batches WHERE run_id = $1 AND status = 'receiving'`, [row.run_id]);
        await tx.query(`DELETE FROM onec_etl_staging_rows WHERE run_id = $1`, [row.run_id]);
        await onAbandoned(tx, { runId: row.run_id, agentId: row.agent_id, sourceId: Number(row.source_id), sourceGeneration: Number(row.source_generation) });
      }
      return rows.length;
    });
  }

  /**
   * Reservations without a heartbeat, claimed atomically: the row is deleted first (conditional on the
   * owner that was read), so a late uploader can no longer publish (its markStored finds nothing); only
   * then may the caller remove the attempt's files. A crash in between leaves an unreferenced file, found
   * by the orphan sweep and, for a revoked entity, by its file-name prefix.
   */
  async claimStaleReservations(staleMs: number): Promise<Array<{ batchId: string; owner: string; sourceId: number; entityCode: string }>> {
    const { rows } = await this.database.query(
      `DELETE FROM onec_etl_batches b USING onec_etl_runs r
        WHERE r.run_id = b.run_id AND b.status = 'receiving' AND b.ack IS NULL
          AND b.receiving_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
          AND b.batch_id IN (SELECT batch_id FROM onec_etl_batches WHERE status = 'receiving'
                              AND receiving_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
                              LIMIT 100 FOR UPDATE SKIP LOCKED)
        RETURNING b.batch_id, b.receiving_owner, r.source_id, b.entity_code`,
      [staleMs],
    );
    return rows.map((row) => ({ batchId: row.batch_id, owner: row.receiving_owner, sourceId: Number(row.source_id), entityCode: row.entity_code }));
  }

  async listStaleReservations(staleMs: number): Promise<Array<{ batchId: string; owner: string }>> {
    const { rows } = await this.database.query(
      `SELECT batch_id, receiving_owner FROM onec_etl_batches
        WHERE status = 'receiving' AND receiving_heartbeat_at < now() - ($1::bigint * interval '1 millisecond') LIMIT 100`,
      [staleMs],
    );
    return rows.map((row) => ({ batchId: row.batch_id, owner: row.receiving_owner }));
  }

  /** A parser that stopped heartbeating (backend restart): back to stored, or invalid after too many attempts. */
  async recoverStuckParsing(staleMs: number, maxAttempts: number): Promise<number> {
    const { rowCount } = await this.database.query(
      // SKIP LOCKED: never waits on (or deadlocks with) a completion holding a run's batch rows.
      `WITH stuck AS (
         SELECT batch_id FROM onec_etl_batches
          WHERE status = 'parsing' AND parse_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
          ORDER BY batch_id FOR UPDATE SKIP LOCKED)
       UPDATE onec_etl_batches b SET
         status = CASE WHEN b.parse_attempt >= $2 THEN 'invalid' ELSE 'stored' END,
         invalid_reason = CASE WHEN b.parse_attempt >= $2 THEN 'PARSE_RETRIES_EXHAUSTED' ELSE b.invalid_reason END,
         updated_at = now()
        FROM stuck WHERE b.batch_id = stuck.batch_id`,
      [staleMs, maxAttempts],
    );
    return rowCount ?? 0;
  }

  /**
   * Spool files past retention (finalized/discarded/invalid batches). Paths are only read here; the
   * caller deletes each file and then clears its path (clearSpoolPath), so a failed unlink keeps the
   * record and is retried.
   */
  async listExpiredSpoolFiles(retentionMs: number): Promise<Array<{ batchId: string; path: string }>> {
    const { rows } = await this.database.query(
      `SELECT batch_id, spool_path FROM onec_etl_batches
        WHERE spool_path IS NOT NULL AND status IN ('finalized','discarded','invalid')
          AND updated_at < now() - ($1::bigint * interval '1 millisecond')
        LIMIT 500`,
      [retentionMs],
    );
    return rows.map((row) => ({ batchId: row.batch_id as string, path: row.spool_path as string }));
  }

  async referencedSpoolPaths(): Promise<Set<string>> {
    const { rows } = await this.database.query(`SELECT spool_path FROM onec_etl_batches WHERE spool_path IS NOT NULL`);
    return new Set(rows.map((row) => row.spool_path as string));
  }

  /** stored/parsed batches whose spool file disappeared become invalid (run completes 422). */
  async markSpoolMissing(batchId: string): Promise<boolean> {
    return this.markInvalid(batchId, null, 'SPOOL_MISSING');
  }

  async listBatchesNeedingSpool(): Promise<Array<{ batchId: string; spoolPath: string; agentId: string; runId: string }>> {
    const { rows } = await this.database.query(
      `SELECT batch_id, spool_path, agent_id, run_id FROM onec_etl_batches WHERE status IN ('stored','parsed') AND spool_path IS NOT NULL`,
    );
    return rows.map((row) => ({ batchId: row.batch_id, spoolPath: row.spool_path, agentId: row.agent_id, runId: row.run_id }));
  }

  async purgeJournal(days: number): Promise<number> {
    return this.database.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT run_id FROM onec_etl_runs WHERE status IN ('completed','abandoned') AND updated_at < now() - ($1::int * interval '1 day')
          ORDER BY updated_at LIMIT 500 FOR UPDATE SKIP LOCKED`,
        [days],
      );
      const ids = rows.map((row) => row.run_id);
      if (ids.length === 0) return 0;
      await tx.query(`DELETE FROM onec_etl_batches WHERE run_id = ANY($1::uuid[]) AND spool_path IS NULL`, [ids]);
      const { rowCount } = await tx.query(
        `DELETE FROM onec_etl_runs r WHERE r.run_id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM onec_etl_batches b WHERE b.run_id = r.run_id)`,
        [ids],
      );
      return rowCount ?? 0;
    });
  }

  // ---------------------------------------------------------------- revocation (plan §21.3, §21.6)

  /** complete of a run that still holds a revoked entity's batches: discard them (run → batches already locked). */
  async discardRevokedInRun(tx: DatabaseClient, runId: string, entityCode: string): Promise<void> {
    await tx.query(
      `UPDATE onec_etl_runs SET revoked_entities = array_append(revoked_entities, $2), updated_at = now()
        WHERE run_id = $1 AND status = 'receiving' AND NOT ($2 = ANY(revoked_entities))`,
      [runId, entityCode],
    );
    // Reservations are kept (discarded, with their owner) for the revocation cleanup to remove their files.
    await tx.query(
      `UPDATE onec_etl_batches SET status = 'discarded', revoked = true, updated_at = now()
        WHERE run_id = $1 AND entity_code = $2 AND status NOT IN ('discarded','finalized')`,
      [runId, entityCode],
    );
    await tx.query(`DELETE FROM onec_etl_staging_rows WHERE run_id = $1 AND entity_code = $2`, [runId, entityCode]);
  }

  /** Step 1 of a revocation: the write ban (entity_state only; batches and data untouched here). */
  async markRevoked(tx: DatabaseClient, sourceId: number, entityCode: string, actorId: number): Promise<boolean> {
    await this.lockEntityState(tx, sourceId, entityCode);
    const { rowCount } = await tx.query(
      `UPDATE onec_etl_entity_state SET revoked_at = now(), revoked_by = $3, purged_at = NULL, updated_at = now()
        WHERE source_id = $1 AND entity_code = $2 AND revoked_at IS NULL`,
      [sourceId, entityCode, actorId],
    );
    return (rowCount ?? 0) > 0;
  }

  async listRevokedEntities(): Promise<Array<{ sourceId: number; entityCode: string; purged: boolean }>> {
    const { rows } = await this.database.query(`SELECT source_id, entity_code, purged_at FROM onec_etl_entity_state WHERE revoked_at IS NOT NULL`);
    return rows.map((row) => ({ sourceId: Number(row.source_id), entityCode: row.entity_code, purged: row.purged_at != null }));
  }

  /**
   * Step 2, idempotent, repeated until clean: every run of the source with this
   * entity's batches (open or closed) in lock order run → batches → entity_state;
   * then the source-wide copy (entity_state → mirror). Returns spool files to
   * delete after commit.
   */
  async cleanupRevokedEntity(sourceId: number, entityCode: string): Promise<{
    files: Array<{ batchId: string; path: string }>;
    reservations: Array<{ batchId: string; owner: string }>;
    purged: boolean;
  }> {
    // Note: files are also swept by name prefix in the service; database records are not the only link.
    const files: Array<{ batchId: string; path: string }> = [];
    const reservations: Array<{ batchId: string; owner: string }> = [];
    const { rows: runs } = await this.database.query(
      `SELECT DISTINCT b.run_id FROM onec_etl_batches b JOIN onec_etl_runs r ON r.run_id = b.run_id
        WHERE r.source_id = $1 AND b.entity_code = $2
          AND (b.status NOT IN ('discarded','finalized') OR b.spool_path IS NOT NULL OR b.receiving_owner IS NOT NULL
               OR (r.status = 'receiving' AND NOT ($2 = ANY(r.revoked_entities))))`,
      [sourceId, entityCode],
    );
    for (const { run_id: runId } of runs) {
      await this.database.transaction(async (tx) => {
        const run = await this.getRun(tx, runId, true);
        if (!run) return;
        await tx.query(`SELECT 1 FROM onec_etl_batches WHERE run_id = $1 AND entity_code = $2 ORDER BY batch_id FOR UPDATE`, [runId, entityCode]);
        const state = await tx.query(`SELECT revoked_at FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2 FOR SHARE`, [sourceId, entityCode]);
        if (state.rows[0]?.revoked_at == null) return; // re-enabled meanwhile: nothing to clean
        if (run.status === 'receiving' && !run.revokedEntities.includes(entityCode)) {
          await tx.query(`UPDATE onec_etl_runs SET revoked_entities = array_append(revoked_entities, $2), updated_at = now() WHERE run_id = $1`, [runId, entityCode]);
        }
        // Unacknowledged reservations are discarded but KEPT with their owner: a crash after the file
        // was written (before markStored) leaves `<batchId>.<owner>.*` on disk, and the owner is the only
        // link to it. The row goes only after its files are confirmed gone (clearReservationFiles).
        await tx.query(
          `UPDATE onec_etl_batches SET status = 'discarded', revoked = true, updated_at = now()
            WHERE run_id = $1 AND entity_code = $2 AND status NOT IN ('discarded','finalized')`,
          [runId, entityCode],
        );
        const { rows: owners } = await tx.query(
          `SELECT batch_id, receiving_owner FROM onec_etl_batches WHERE run_id = $1 AND entity_code = $2 AND receiving_owner IS NOT NULL`,
          [runId, entityCode],
        );
        reservations.push(...owners.map((row) => ({ batchId: row.batch_id as string, owner: row.receiving_owner as string })));
        // Paths stay recorded until each file is confirmed deleted (clearSpoolPath): a crash or a failed
        // unlink leaves the entity "not clean" and the next cleanup retries.
        const { rows: paths } = await tx.query(
          `SELECT batch_id, spool_path FROM onec_etl_batches WHERE run_id = $1 AND entity_code = $2 AND spool_path IS NOT NULL`,
          [runId, entityCode],
        );
        files.push(...paths.map((row) => ({ batchId: row.batch_id as string, path: row.spool_path as string })));
        await tx.query(`DELETE FROM onec_etl_staging_rows WHERE run_id = $1 AND entity_code = $2`, [runId, entityCode]);
      });
    }
    const purged = await this.database.transaction(async (tx) => {
      const { rows } = await tx.query(`SELECT revoked_at FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2 FOR UPDATE`, [sourceId, entityCode]);
      if (rows[0]?.revoked_at == null) return false;
      await tx.query(`DELETE FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2`, [sourceId, entityCode]);
      await tx.query(
        `UPDATE onec_etl_entity_state SET purged_at = COALESCE(purged_at, now()), row_count = 0, deleted_count = 0, missing_count = 0,
                snapshot_version = NULL, updated_at = now()
          WHERE source_id = $1 AND entity_code = $2`,
        [sourceId, entityCode],
      );
      return true;
    });
    return { files, reservations, purged };
  }

  /** An unacknowledged attempt's files are gone: drop its row (its ACK never existed). */
  async clearReservationFiles(batchId: string, owner: string): Promise<void> {
    await this.database.query(
      `DELETE FROM onec_etl_batches WHERE batch_id = $1 AND receiving_owner = $2 AND ack IS NULL AND status IN ('receiving','discarded')`,
      [batchId, owner],
    );
  }

  /** SHARE lock on the entity state held for the duration of a revocation file sweep. */
  async stillRevokedShared(tx: DatabaseClient, sourceId: number, entityCode: string): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT revoked_at FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2 FOR SHARE`,
      [sourceId, entityCode],
    );
    return rows[0]?.revoked_at != null;
  }

  /** After the file is gone: forget its path (only if it still points to that file). */
  async clearSpoolPath(batchId: string, path: string): Promise<void> {
    await this.database.query(`UPDATE onec_etl_batches SET spool_path = NULL WHERE batch_id = $1 AND spool_path = $2`, [batchId, path]);
  }

  /** The revoked entity leaves nothing behind (condition to allow a re-enable). */
  async revokedEntityClean(client: DatabaseClient, sourceId: number, entityCode: string): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT
         NOT EXISTS (SELECT 1 FROM onec_etl_batches b JOIN onec_etl_runs r ON r.run_id = b.run_id
                      WHERE r.source_id = $1 AND b.entity_code = $2
                        AND (b.status NOT IN ('discarded','finalized') OR b.spool_path IS NOT NULL OR b.receiving_owner IS NOT NULL)) AND
         NOT EXISTS (SELECT 1 FROM onec_etl_staging_rows s JOIN onec_etl_runs r ON r.run_id = s.run_id
                      WHERE r.source_id = $1 AND s.entity_code = $2) AND
         NOT EXISTS (SELECT 1 FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2) AS clean`,
      [sourceId, entityCode],
    );
    return rows[0]?.clean === true;
  }

  async clearRevoked(tx: DatabaseClient, sourceId: number, entityCode: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE onec_etl_entity_state SET revoked_at = NULL, revoked_by = NULL, updated_at = now()
        WHERE source_id = $1 AND entity_code = $2 AND revoked_at IS NOT NULL AND purged_at IS NOT NULL`,
      [sourceId, entityCode],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Personal data not confirmed by a verified snapshot for the TTL is removed from the copy. */
  async expirePersonalData(entityCodes: readonly string[], ttlMs: number): Promise<number> {
    let removed = 0;
    const { rows } = await this.database.query(
      `SELECT source_id, entity_code FROM onec_etl_entity_state
        WHERE entity_code = ANY($1::text[]) AND (snapshot_version IS NULL OR snapshot_version < now() - ($2::bigint * interval '1 millisecond'))`,
      [entityCodes, ttlMs],
    );
    for (const row of rows) {
      removed += await this.database.transaction(async (tx) => {
        // Re-check under the lock: a completion may have just published a fresh snapshot.
        const locked = await tx.query(
          `SELECT 1 FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2
             AND (snapshot_version IS NULL OR snapshot_version < now() - ($3::bigint * interval '1 millisecond')) FOR UPDATE`,
          [row.source_id, row.entity_code, ttlMs],
        );
        if (locked.rowCount === 0) return 0;
        const { rowCount } = await tx.query(`DELETE FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2`, [row.source_id, row.entity_code]);
        if ((rowCount ?? 0) > 0) {
          await tx.query(`UPDATE onec_etl_entity_state SET row_count = 0, deleted_count = 0, missing_count = 0, updated_at = now() WHERE source_id = $1 AND entity_code = $2`, [row.source_id, row.entity_code]);
        }
        return rowCount ?? 0;
      });
    }
    return removed;
  }

  // ---------------------------------------------------------------- rebaseline (plan §3.2)

  /**
   * New generation of the source (called under the agent row lock): open runs
   * are abandoned, the copy is cleared, entity state reset (revocations kept).
   * A batch/complete of an older run is then refused 409 RUN_GENERATION_CLOSED.
   */
  async rebaselineSource(tx: DatabaseClient, sourceId: number): Promise<{ generation: number; generationRef: string; abandonedRuns: string[] }> {
    const { rows: gen } = await tx.query(
      `UPDATE onec_sources SET generation = generation + 1, generation_ref = gen_random_uuid(), updated_at = now()
        WHERE source_id = $1 RETURNING generation, generation_ref`,
      [sourceId],
    );
    const { rows: runs } = await tx.query(
      `SELECT run_id FROM onec_etl_runs WHERE source_id = $1 AND status = 'receiving' ORDER BY run_id FOR UPDATE`,
      [sourceId],
    );
    const runIds = runs.map((row) => row.run_id as string);
    if (runIds.length > 0) {
      await tx.query(`SELECT 1 FROM onec_etl_batches WHERE run_id = ANY($1::uuid[]) ORDER BY batch_id FOR UPDATE`, [runIds]);
      await tx.query(`UPDATE onec_etl_runs SET status = 'abandoned', updated_at = now() WHERE run_id = ANY($1::uuid[])`, [runIds]);
      await tx.query(`DELETE FROM onec_etl_batches WHERE run_id = ANY($1::uuid[]) AND status = 'receiving' AND ack IS NULL`, [runIds]);
      await tx.query(`UPDATE onec_etl_batches SET status = 'discarded', updated_at = now() WHERE run_id = ANY($1::uuid[]) AND status NOT IN ('discarded','finalized')`, [runIds]);
      await tx.query(`DELETE FROM onec_etl_staging_rows WHERE run_id = ANY($1::uuid[])`, [runIds]);
    }
    await tx.query(`SELECT 1 FROM onec_etl_entity_state WHERE source_id = $1 ORDER BY entity_code FOR UPDATE`, [sourceId]);
    await tx.query(`DELETE FROM onec_etl_mirror_rows WHERE source_id = $1`, [sourceId]);
    await tx.query(
      `UPDATE onec_etl_entity_state SET last_run_id = NULL, last_run_at = NULL, last_status = NULL, last_read_scope = NULL,
              last_completeness = NULL, last_completeness_reason = NULL, last_snapshot_at = NULL, last_full_run_id = NULL,
              last_full_at = NULL, last_error_code = NULL, last_error_message = NULL, row_count = 0, deleted_count = 0,
              missing_count = 0, snapshot_version = NULL, snapshot_rejected_reason = NULL, updated_at = now()
        WHERE source_id = $1`,
      [sourceId],
    );
    return { generation: Number(gen[0].generation), generationRef: gen[0].generation_ref, abandonedRuns: runIds };
  }

  // ---------------------------------------------------------------- mirror browse («Данные 1С»)

  async listMirror(filter: { sourceId: number; entityCode: string; search: string | null; state: 'all' | 'missing' | 'deleted' | 'active'; offset: number; limit: number }) {
    const params = [filter.sourceId, filter.entityCode, filter.search ? `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, filter.state, filter.limit, filter.offset];
    const where = `m.source_id = $1 AND m.entity_code = $2
       AND ($3::text IS NULL OR m.source_key ILIKE $3 OR m.data->>'Description' ILIKE $3 OR m.data->>'Code' ILIKE $3
            OR m.data->>'Артикул' ILIKE $3 OR m.data->>'НаименованиеПолное' ILIKE $3 OR m.data->>'Представление' ILIKE $3)
       AND ($4 = 'all' OR ($4 = 'missing' AND m.missing_in_source_at IS NOT NULL) OR ($4 = 'deleted' AND m.deleted)
            OR ($4 = 'active' AND NOT m.deleted AND m.missing_in_source_at IS NULL))`;
    const { rows } = await this.database.query(
      `SELECT m.source_key, m.deleted, m.missing_in_source_at, m.source_updated_at, m.updated_at,
              m.data->>'Code' AS code, COALESCE(m.data->>'Description', m.data->>'Представление') AS description,
              count(*) OVER () AS total
         FROM onec_etl_mirror_rows m WHERE ${where}
        ORDER BY COALESCE(m.data->>'Description', m.source_key), m.source_key LIMIT $5 OFFSET $6`,
      params,
    );
    return rows;
  }

  async getMirrorRow(sourceId: number, entityCode: string, sourceKey: string): Promise<QueryResultRow | null> {
    const { rows } = await this.database.query(
      `SELECT * FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2 AND source_key = $3`,
      [sourceId, entityCode, sourceKey],
    );
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------- admin reads

  async listRuns(filter: { agentId?: string; limit: number }): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT r.*, (SELECT count(*)::int FROM onec_etl_batches b WHERE b.run_id = r.run_id) AS batch_count,
              (SELECT COALESCE(sum(b.row_count), 0)::bigint FROM onec_etl_batches b WHERE b.run_id = r.run_id) AS row_total
         FROM onec_etl_runs r WHERE ($1::text IS NULL OR r.agent_id = $1)
        ORDER BY r.created_at DESC, r.run_id DESC LIMIT $2`,
      [filter.agentId ?? null, filter.limit],
    );
    return rows;
  }

  async getRunView(runId: string): Promise<QueryResultRow | null> {
    const { rows } = await this.database.query(
      `SELECT r.*, (SELECT count(*)::int FROM onec_etl_batches b WHERE b.run_id = r.run_id) AS batch_count,
              (SELECT COALESCE(sum(b.row_count), 0)::bigint FROM onec_etl_batches b WHERE b.run_id = r.run_id) AS row_total
         FROM onec_etl_runs r WHERE r.run_id = $1`,
      [runId],
    );
    return rows[0] ?? null;
  }

  async listEntityStates(sourceId: number | null): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT * FROM onec_etl_entity_state WHERE ($1::bigint IS NULL OR source_id = $1) ORDER BY source_id, entity_code`,
      [sourceId],
    );
    return rows;
  }
}

/** Mirror upsert rule: the incoming row replaces the stored one only if it is not older. */
const newerWins = `(m.source_updated_at IS NULL OR (EXCLUDED.source_updated_at IS NOT NULL AND EXCLUDED.source_updated_at >= m.source_updated_at))`;
