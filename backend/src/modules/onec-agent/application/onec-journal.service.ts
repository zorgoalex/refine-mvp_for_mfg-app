import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { PgOnecJournalRepository } from '../adapters/pg-onec-journal-repository';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { HISTORY_SAMPLE_MS } from './onec-agent-protocol.service';

export const JOURNAL_WINDOW_MS = 24 * 60 * 60_000;

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
const n = (value: string | number | null | undefined) => Number(value ?? 0);

export interface StateChange { at: string; state: string; reason: string | null }

/** Переходы состояний агента: только смены state/reason (подряд одинаковые записи истории схлопываются). */
export function stateTransitions(rows: ReadonlyArray<{ at: Date | string; state: string; state_reason: string | null }>): StateChange[] {
  const out: StateChange[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && last.state === row.state && last.reason === (row.state_reason ?? null)) continue;
    out.push({ at: iso(row.at)!, state: row.state, reason: row.state_reason ?? null });
  }
  return out;
}

/** Запись истории «покрывает» время до следующей, но не дольше двух интервалов выборки — дальше связи не было. */
const COVER_MAX_MS = 2 * HISTORY_SAMPLE_MS;

/**
 * Время в состояниях за окно (мс): каждая запись истории действует до следующей (не дольше COVER_MAX_MS);
 * непокрытое время — `no_contact` (агент не выходил на связь или данных нет).
 */
export function stateDurations(
  rows: ReadonlyArray<{ at: Date | string; state: string }>,
  from: Date,
  to: Date,
): Array<{ state: string; ms: number }> {
  const totals = new Map<string, number>();
  const add = (state: string, ms: number) => { if (ms > 0) totals.set(state, (totals.get(state) ?? 0) + ms); };
  let covered = 0;
  const points = rows.map((row) => ({ at: new Date(row.at).getTime(), state: row.state })).filter((p) => p.at <= to.getTime());
  for (let i = 0; i < points.length; i += 1) {
    const start = Math.max(points[i].at, from.getTime());
    const next = i + 1 < points.length ? points[i + 1].at : to.getTime();
    const end = Math.min(next, points[i].at + COVER_MAX_MS, to.getTime());
    if (end > start) { add(points[i].state, end - start); covered += end - start; }
  }
  add('no_contact', to.getTime() - from.getTime() - covered);
  return [...totals].map(([state, ms]) => ({ state, ms })).sort((a, b) => b.ms - a.ms);
}

/**
 * Журнал связи с агентом 1С за последние сутки: сводка по уже хранимым данным, считается при запросе.
 * Отдельного журнала нет — история старше окна удаляется retention монитора (сессии и состояния — сутки).
 */
@Injectable()
export class OnecJournalService {
  constructor(
    @Inject(PgOnecJournalRepository) private readonly journal: PgOnecJournalRepository,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  async daily(agentId: string, now = new Date()) {
    this.runtime.requireEnabled();
    const agent = await this.repository.getAgent(this.repository.db, agentId);
    if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
    const sourceId = agent.sourceId;
    const since = new Date(now.getTime() - JOURNAL_WINDOW_MS);
    const [sessions, lastSeen, history, before, configs, runs, entities, commands, incidents, alerts, documents] = await Promise.all([
      this.journal.sessions(agentId, since),
      this.journal.lastSeen(agentId),
      this.journal.statusHistory(agentId, since),
      this.journal.statusBefore(agentId, since),
      this.journal.configVersions(agentId, since),
      this.journal.runs(agentId, since),
      this.journal.batchesByEntity(agentId, since),
      this.journal.commands(agentId, since),
      this.journal.incidents(agentId, since),
      this.journal.alerts(agentId, sourceId, since),
      this.journal.documentEvents(sourceId, since),
    ]);
    const stateCounts = new Map<string, number>();
    for (const row of history) stateCounts.set(row.state, (stateCounts.get(row.state) ?? 0) + 1);
    return {
      agentId,
      sourceId,
      from: since.toISOString(),
      to: now.toISOString(),
      connection: {
        lastSeenAt: iso(lastSeen),
        sessions: sessions.map((row) => ({
          accepted: row.accepted, agentVersion: row.agent_version, count: n(row.count), firstAt: iso(row.first_at), lastAt: iso(row.last_at),
        })),
        heartbeats: history.length,
        states: [...stateCounts].map(([state, count]) => ({ state, count })),
        stateTime: stateDurations(before ? [before, ...history] : history, since, now),
        stateChanges: stateTransitions(history),
      },
      configVersions: configs.map((row) => ({ configVersion: row.config_version, publishedAt: iso(row.published_at), status: row.status })),
      runs: runs.map((row) => ({
        runId: row.run_id, mode: row.mode, status: row.status, createdAt: iso(row.created_at), completedAt: iso(row.completed_at),
        entitiesFailed: row.entities_failed, batches: n(row.batches), rows: n(row.rows), bytes: n(row.bytes),
      })),
      entities: entities.map((row) => ({
        entity: row.entity_code, runs: n(row.runs), batches: n(row.batches), rows: n(row.rows), bytes: n(row.bytes), invalidBatches: n(row.invalid),
        pendingBatches: n(row.pending),
      })),
      commands: commands.map((row) => ({ commandType: row.command_type, status: row.status, count: n(row.count) })),
      incidents: incidents.map((row) => ({ kind: row.kind, count: n(row.count), occurrences: n(row.occurrences), open: n(row.open) })),
      alerts: alerts.map((row) => ({ kind: row.kind, opened: n(row.opened), resolved: n(row.resolved), open: n(row.open) })),
      documents: documents.map((row) => ({ event: row.event, docKind: row.doc_kind, count: n(row.count) })),
    };
  }
}
