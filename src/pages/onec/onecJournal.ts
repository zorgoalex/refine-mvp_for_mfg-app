// Журнал связи с агентом 1С за сутки: типы ответа API и простой (понятный пользователю) вид.
// Технический вид показывает те же данные таблицами (DailyJournalTab).
import { ONEC_STATE_LABELS, onecAlertKindLabel, onecEtlEntityLabel, onecIncidentKindLabel } from './onecFormat';

export interface OnecDailyJournal {
  agentId: string;
  sourceId: number;
  from: string;
  to: string;
  connection: {
    lastSeenAt: string | null;
    sessions: Array<{ accepted: boolean; agentVersion: string | null; count: number; firstAt: string | null; lastAt: string | null }>;
    heartbeats: number;
    states: Array<{ state: string; count: number }>;
    /** Время в состояниях за окно, мс; `no_contact` — агент не выходил на связь. */
    stateTime: Array<{ state: string; ms: number }>;
    stateChanges: Array<{ at: string; state: string; reason: string | null }>;
  };
  configVersions: Array<{ configVersion: string; publishedAt: string | null; status: string }>;
  runs: Array<{
    runId: string; mode: string | null; status: string; createdAt: string | null; completedAt: string | null;
    entitiesFailed: number | null; batches: number; rows: number; bytes: number;
  }>;
  entities: Array<{ entity: string; runs: number; batches: number; rows: number; bytes: number; invalidBatches: number; pendingBatches: number }>;
  commands: Array<{ commandType: string; status: string; count: number }>;
  incidents: Array<{ kind: string; count: number; occurrences: number; open: number }>;
  alerts: Array<{ kind: string; opened: number; resolved: number; open: number }>;
  documents: Array<{ event: string; docKind: string | null; count: number }>;
}

export type JournalTone = 'success' | 'warning' | 'error';

export interface PlainJournal {
  tone: JournalTone;
  headline: string;
  lines: string[];
}

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};
const num = (n: number) => n.toLocaleString('ru-RU');
const HOUR_MS = 60 * 60_000;
const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
};
const time = (value: string) => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Простой вид журнала: короткие фразы на русском без технических кодов. */
export function buildPlainJournal(journal: OnecDailyJournal): PlainJournal {
  const lines: string[] = [];
  const problems: string[] = [];

  // Связь
  const accepted = journal.connection.sessions.filter((s) => s.accepted).reduce((sum, s) => sum + s.count, 0);
  const rejected = journal.connection.sessions.filter((s) => !s.accepted).reduce((sum, s) => sum + s.count, 0);
  const windowMs = new Date(journal.to).getTime() - new Date(journal.from).getTime();
  const msOf = (state: string) => journal.connection.stateTime.find((s) => s.state === state)?.ms ?? 0;
  const pct = (ms: number) => Math.round((100 * ms) / Math.max(windowMs, 1));
  const healthyMs = msOf('healthy');
  const noContactMs = msOf('no_contact');
  if (accepted === 0 && healthyMs === 0 && journal.connection.stateTime.every((s) => s.state === 'no_contact')) {
    problems.push('Агент 1С за сутки ни разу не выходил на связь.');
  } else {
    lines.push(pct(healthyMs) >= 99
      ? 'Связь с 1С была стабильной весь день.'
      : `Связь с 1С в норме ${pct(healthyMs)}% суток.`);
    if (noContactMs >= HOUR_MS / 2) problems.push(`Агент не выходил на связь в сумме ${duration(noContactMs)}.`);
    for (const state of journal.connection.stateTime.filter((s) => s.state !== 'healthy' && s.state !== 'no_contact' && s.ms >= 60_000)) {
      problems.push(`Состояние «${ONEC_STATE_LABELS[state.state as keyof typeof ONEC_STATE_LABELS] ?? state.state}» — ${duration(state.ms)}.`);
    }
    if (accepted > 0) lines.push(`Агент подключался ${num(accepted)} ${plural(accepted, 'раз', 'раза', 'раз')}.`);
  }
  if (rejected > 0) problems.push(`ERP ${num(rejected)} ${plural(rejected, 'раз', 'раза', 'раз')} отказал агенту в подключении.`);

  // Выгрузки
  const completed = journal.runs.filter((r) => r.status === 'completed');
  const failedEntities = journal.runs.reduce((sum, r) => sum + (r.entitiesFailed ?? 0), 0);
  const abandoned = journal.runs.filter((r) => r.status === 'abandoned').length;
  const hanging = journal.runs.filter((r) => r.status === 'receiving').length;
  if (journal.runs.length === 0) {
    problems.push('Выгрузок из 1С за сутки не было.');
  } else {
    lines.push(`Выгрузок из 1С: ${num(journal.runs.length)}, завершено ${num(completed.length)}.`);
    const lastAt = completed.map((r) => r.completedAt).filter((v): v is string => Boolean(v)).sort().at(-1);
    if (lastAt) lines.push(`Последняя успешная выгрузка — в ${time(lastAt)}.`);
    if (failedEntities > 0) problems.push(`В выгрузках не прочитано ${num(failedEntities)} ${plural(failedEntities, 'набор', 'набора', 'наборов')} данных.`);
    if (abandoned > 0) problems.push(`${num(abandoned)} ${plural(abandoned, 'выгрузка брошена', 'выгрузки брошены', 'выгрузок брошено')} без завершения.`);
    if (hanging > 0) lines.push(`${num(hanging)} ${plural(hanging, 'выгрузка ещё идёт', 'выгрузки ещё идут', 'выгрузок ещё идут')}.`);
  }

  // Что получено
  const received = journal.entities.filter((e) => e.rows > 0).sort((a, b) => b.rows - a.rows);
  if (received.length > 0) {
    const total = received.reduce((sum, e) => sum + e.rows, 0);
    lines.push(`Получено записей: ${num(total)}. Больше всего — ${received.slice(0, 3)
      .map((e) => `${onecEtlEntityLabel(e.entity).toLowerCase()} (${num(e.rows)})`).join(', ')}.`);
  }
  const invalid = journal.entities.reduce((sum, e) => sum + e.invalidBatches, 0);
  const pending = journal.entities.reduce((sum, e) => sum + e.pendingBatches, 0);
  if (pending > 0) lines.push(`${num(pending)} ${plural(pending, 'пакет данных ещё не дополучен', 'пакета данных ещё не дополучены', 'пакетов данных ещё не дополучено')}.`);
  if (invalid > 0) problems.push(`${num(invalid)} ${plural(invalid, 'пакет данных отклонён', 'пакета данных отклонены', 'пакетов данных отклонено')}.`);

  // Документы
  const loaded = journal.documents.filter((d) => d.event === 'onec.document.loaded').reduce((sum, d) => sum + d.count, 0);
  const changed = journal.documents.filter((d) => d.event === 'onec.document.changed').reduce((sum, d) => sum + d.count, 0);
  const conflicts = journal.documents.filter((d) => d.event === 'onec.document.conflict').reduce((sum, d) => sum + d.count, 0);
  if (loaded + changed > 0) lines.push(`Документов 1С: новых ${num(loaded)}, изменённых ${num(changed)}.`);
  if (conflicts > 0) problems.push(`${num(conflicts)} ${plural(conflicts, 'изменение документа', 'изменения документов', 'изменений документов')} 1С не применено из-за распределений в ERP.`);

  // Команды, конфигурация
  const commandsDone = journal.commands.filter((c) => c.status === 'succeeded').reduce((sum, c) => sum + c.count, 0);
  const commandsFailed = journal.commands.filter((c) => ['business_error', 'dead_letter', 'expired', 'expired_undelivered'].includes(c.status)).reduce((sum, c) => sum + c.count, 0);
  if (commandsDone > 0) lines.push(`Команд выполнено: ${num(commandsDone)}.`);
  if (commandsFailed > 0) problems.push(`Команд с ошибкой: ${num(commandsFailed)}.`);
  if (journal.configVersions.length > 0) lines.push(`Настройки обмена менялись ${num(journal.configVersions.length)} ${plural(journal.configVersions.length, 'раз', 'раза', 'раз')}.`);

  // Предупреждения
  const openAlerts = journal.alerts.filter((a) => a.open > 0);
  for (const alert of openAlerts) problems.push(`Открыто предупреждение: ${onecAlertKindLabel(alert.kind)}.`);
  const openIncidents = journal.incidents.filter((i) => i.open > 0 && i.kind !== 'unknown_certificate');
  for (const incident of openIncidents) problems.push(`Открыт инцидент: ${onecIncidentKindLabel(incident.kind)}.`);

  // Итог — по структурным признакам: «не работал» только без связи; отсутствие выгрузок при живой связи — замечание.
  const noContact = accepted === 0 && healthyMs === 0 && journal.connection.stateTime.every((s) => s.state === 'no_contact');
  const tone: JournalTone = noContact ? 'error' : problems.length > 0 ? 'warning' : 'success';
  const headline = tone === 'success' ? 'За сутки обмен с 1С прошёл без проблем.' : tone === 'warning' ? 'Обмен с 1С работал, но есть замечания.' : 'Обмен с 1С за сутки не работал.';
  return { tone, headline, lines: [...lines, ...problems] };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}
