import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';

/**
 * Сводка связи с агентом 1С за окно (журнал за сутки): только агрегаты по уже хранимым таблицам
 * (сессии, история состояний, выгрузки, пакеты, команды, инциденты, алерты, аудит загрузчика документов).
 * Ничего не пишет: отдельного журнала нет, старые записи удаляет retention монитора.
 */
@Injectable()
export class PgOnecJournalRepository {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async sessions(agentId: string, since: Date) {
    return (await this.db.query<{ accepted: boolean; agent_version: string | null; count: string; first_at: Date; last_at: Date }>(
      `SELECT accepted, agent_version, count(*)::text AS count, min(started_at) AS first_at, max(started_at) AS last_at
         FROM onec_agent_sessions WHERE agent_id = $1 AND started_at >= $2
        GROUP BY accepted, agent_version ORDER BY min(started_at)`,
      [agentId, since],
    )).rows;
  }

  async lastSeen(agentId: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ at: Date | null }>(
      'SELECT max(last_seen_at) AS at FROM onec_agent_sessions WHERE agent_id = $1', [agentId]);
    return rows[0]?.at ?? null;
  }

  /** История состояний за окно (одна запись на heartbeat с записью истории), по времени. */
  async statusHistory(agentId: string, since: Date) {
    return (await this.db.query<{ at: Date; state: string; state_reason: string | null }>(
      `SELECT at, state, state_reason FROM onec_agent_status_history WHERE agent_id = $1 AND at >= $2 ORDER BY at, history_id`,
      [agentId, since],
    )).rows;
  }

  /** Последняя запись истории до начала окна — покрывает его начало при расчёте времени в состояниях. */
  async statusBefore(agentId: string, since: Date) {
    return (await this.db.query<{ at: Date; state: string; state_reason: string | null }>(
      `SELECT at, state, state_reason FROM onec_agent_status_history WHERE agent_id = $1 AND at < $2 ORDER BY at DESC, history_id DESC LIMIT 1`,
      [agentId, since],
    )).rows[0] ?? null;
  }

  async configVersions(agentId: string, since: Date) {
    return (await this.db.query<{ config_version: string; published_at: Date; status: string }>(
      `SELECT config_version::text, published_at, status FROM onec_agent_config_versions
        WHERE agent_id = $1 AND published_at >= $2 ORDER BY published_at`,
      [agentId, since],
    )).rows;
  }

  /** Выгрузки, начатые или завершённые в окне, с итогами пакетов. */
  async runs(agentId: string, since: Date) {
    return (await this.db.query<{
      run_id: string; mode: string | null; status: string; created_at: Date; completed_at: Date | null; entities_failed: number | null;
      batches: string; rows: string; bytes: string;
    }>(
      `SELECT r.run_id::text, r.mode, r.status, r.created_at, r.completed_at, r.entities_failed,
              count(b.batch_id) FILTER (WHERE b.stored_at IS NOT NULL)::text AS batches,
              COALESCE(sum(b.row_count) FILTER (WHERE b.stored_at IS NOT NULL), 0)::text AS rows,
              COALESCE(sum(b.uncompressed_bytes) FILTER (WHERE b.stored_at IS NOT NULL), 0)::text AS bytes
         FROM onec_etl_runs r LEFT JOIN onec_etl_batches b ON b.run_id = r.run_id
        WHERE r.agent_id = $1 AND (r.created_at >= $2 OR r.completed_at >= $2)
        GROUP BY r.run_id ORDER BY r.created_at`,
      [agentId, since],
    )).rows;
  }

  /** Пакеты по сущностям: сохранённые в окне (stored_at) и незавершённые, начатые в окне. */
  async batchesByEntity(agentId: string, since: Date) {
    // Получено = сохранено и подтверждено агенту (stored_at); незавершённые и отклонённые — отдельно.
    return (await this.db.query<{ entity_code: string; batches: string; rows: string; bytes: string; invalid: string; pending: string; runs: string }>(
      `SELECT entity_code, count(*) FILTER (WHERE stored_at IS NOT NULL)::text AS batches,
              COALESCE(sum(row_count) FILTER (WHERE stored_at IS NOT NULL), 0)::text AS rows,
              COALESCE(sum(uncompressed_bytes) FILTER (WHERE stored_at IS NOT NULL), 0)::text AS bytes,
              count(*) FILTER (WHERE status IN ('invalid', 'discarded'))::text AS invalid,
              count(*) FILTER (WHERE stored_at IS NULL AND status NOT IN ('invalid', 'discarded'))::text AS pending,
              count(DISTINCT run_id)::text AS runs
         FROM onec_etl_batches
        WHERE agent_id = $1 AND (stored_at >= $2 OR (stored_at IS NULL AND received_at >= $2))
        GROUP BY entity_code ORDER BY entity_code`,
      [agentId, since],
    )).rows;
  }

  async commands(agentId: string, since: Date) {
    return (await this.db.query<{ command_type: string; status: string; count: string }>(
      `SELECT command_type, status, count(*)::text AS count FROM onec_agent_commands
        WHERE agent_id = $1 AND (created_at >= $2 OR result_received_at >= $2) GROUP BY command_type, status ORDER BY command_type, status`,
      [agentId, since],
    )).rows;
  }

  async incidents(agentId: string, since: Date) {
    return (await this.db.query<{ kind: string; count: string; occurrences: string; open: string }>(
      `SELECT kind, count(*)::text AS count, COALESCE(sum(occurrences), 0)::text AS occurrences,
              count(*) FILTER (WHERE resolved_at IS NULL)::text AS open
         FROM onec_agent_incidents WHERE agent_id = $1 AND last_at >= $2 GROUP BY kind ORDER BY kind`,
      [agentId, since],
    )).rows;
  }

  async alerts(agentId: string, sourceId: number, since: Date) {
    return (await this.db.query<{ kind: string; opened: string; resolved: string; open: string }>(
      `SELECT kind, count(*) FILTER (WHERE opened_at >= $3)::text AS opened, count(*) FILTER (WHERE resolved_at >= $3)::text AS resolved,
              count(*) FILTER (WHERE resolved_at IS NULL)::text AS open
         FROM onec_alerts WHERE (agent_id = $1 OR source_id = $2) AND (opened_at >= $3 OR resolved_at >= $3 OR resolved_at IS NULL)
        GROUP BY kind ORDER BY kind`,
      [agentId, sourceId, since],
    )).rows;
  }

  /** События загрузчика документов источника за окно (аудит onec.document.*), по видам событий и документов. */
  async documentEvents(sourceId: number, since: Date) {
    return (await this.db.query<{ event: string; doc_kind: string | null; count: string }>(
      `SELECT event, metadata_json->>'docKind' AS doc_kind, count(*)::text AS count FROM audit_log
        WHERE entity_type = 'onec_document' AND created_at >= $2 AND (metadata_json->>'sourceId')::bigint = $1
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [sourceId, since],
    )).rows;
  }
}
