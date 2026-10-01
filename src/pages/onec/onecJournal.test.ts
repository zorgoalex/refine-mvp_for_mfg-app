import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPlainJournal, formatBytes, type OnecDailyJournal } from './onecJournal';

const base = (): OnecDailyJournal => ({
  agentId: 'a', sourceId: 1, from: '2026-10-01T10:00:00.000Z', to: '2026-10-02T10:00:00.000Z',
  connection: {
    lastSeenAt: '2026-10-02T09:59:00.000Z',
    sessions: [{ accepted: true, agentVersion: '1.1.3', count: 2, firstAt: '2026-10-01T11:00:00.000Z', lastAt: '2026-10-02T08:00:00.000Z' }],
    heartbeats: 144, states: [{ state: 'healthy', count: 144 }], stateTime: [{ state: 'healthy', ms: 24 * 3600_000 }], stateChanges: [{ at: '2026-10-01T11:00:00.000Z', state: 'healthy', reason: null }],
  },
  configVersions: [],
  runs: [{ runId: 'r1', mode: 'incremental', status: 'completed', createdAt: '2026-10-02T08:53:00.000Z', completedAt: '2026-10-02T08:55:00.000Z', entitiesFailed: 0, batches: 20, rows: 1000, bytes: 2048 }],
  entities: [{ entity: 'doc_sales_shipments', runs: 1, batches: 5, rows: 700, bytes: 1024, invalidBatches: 0, pendingBatches: 0 }, { entity: 'items', runs: 1, batches: 2, rows: 300, bytes: 512, invalidBatches: 0, pendingBatches: 0 }],
  commands: [], incidents: [], alerts: [],
  documents: [{ event: 'onec.document.loaded', docKind: 'sales_shipment', count: 12 }, { event: 'onec.document.changed', docKind: 'sales_shipment', count: 3 }],
});

describe('1C daily journal — plain view', () => {
  it('a quiet day: success, plain sentences, no technical codes', () => {
    const plain = buildPlainJournal(base());
    expect(plain.tone).toBe('success');
    expect(plain.headline).toContain('без проблем');
    const text = plain.lines.join(' ');
    expect(text).toContain('стабильной');
    expect(text).toContain('Агент подключался 2 раза');
    expect(text).toContain('Выгрузок из 1С: 1, завершено 1');
    expect(text).toContain('расходные накладные (700)');
    expect(text).toContain('новых 12, изменённых 3');
    expect(text).not.toMatch(/doc_|onec\.|healthy|incremental/);
  });

  it('problems make a warning: degraded states, failed entities, rejected batches, open alerts, failed commands, conflicts', () => {
    const journal = base();
    journal.connection.states = [{ state: 'healthy', count: 100 }, { state: 'degraded', count: 44 }];
    journal.connection.stateTime = [{ state: 'healthy', ms: 20 * 3600_000 }, { state: 'degraded', ms: 3 * 3600_000 }, { state: 'no_contact', ms: 3600_000 }];
    journal.runs[0].entitiesFailed = 2;
    journal.entities[0].invalidBatches = 1;
    journal.alerts = [{ kind: 'agent_state', opened: 1, resolved: 0, open: 1 }];
    journal.commands = [{ commandType: 'integration_probe', status: 'dead_letter', count: 1 }];
    journal.documents.push({ event: 'onec.document.conflict', docKind: 'cash_outflow', count: 1 });
    const plain = buildPlainJournal(journal);
    expect(plain.tone).toBe('warning');
    const text = plain.lines.join(' ');
    expect(text).toContain('в норме 83% суток');
    expect(text).toContain('«Деградация» — 3 ч 0 мин');
    expect(text).toContain('не выходил на связь в сумме 1 ч 0 мин');
    expect(text).toContain('не прочитано 2 набора');
    expect(text).toContain('1 пакет данных отклонён');
    expect(text).toContain('Команд с ошибкой: 1');
    expect(text).toContain('не применено из-за распределений');
  });

  it('no contact and no runs is an error day', () => {
    const journal = base();
    journal.connection = { lastSeenAt: null, sessions: [], heartbeats: 0, states: [], stateTime: [{ state: 'no_contact', ms: 24 * 3600_000 }], stateChanges: [] };
    journal.runs = [];
    journal.entities = [];
    journal.documents = [];
    const plain = buildPlainJournal(journal);
    expect(plain.tone).toBe('error');
    expect(plain.lines).toEqual(expect.arrayContaining(['Агент 1С за сутки ни разу не выходил на связь.', 'Выгрузок из 1С за сутки не было.']));
  });

  it('a healthy day without runs is a warning, not "exchange did not work"', () => {
    const journal = base();
    journal.runs = [];
    journal.entities = [];
    journal.commands = [{ commandType: 'integration_probe', status: 'succeeded', count: 2 }];
    const plain = buildPlainJournal(journal);
    expect(plain.tone).toBe('warning');
    expect(plain.headline).toContain('есть замечания');
    expect(plain.lines).toEqual(expect.arrayContaining(['Связь с 1С была стабильной весь день.', 'Выгрузок из 1С за сутки не было.', 'Команд выполнено: 2.']));
  });

  it('pending batches are reported separately and not counted as received', () => {
    const journal = base();
    journal.entities[0].pendingBatches = 2;
    expect(buildPlainJournal(journal).lines).toContain('2 пакета данных ещё не дополучены.');
  });

  it('the tab drops stale responses and hides a journal of another agent', () => {
    const tab = readFileSync(new URL('./DailyJournalTab.tsx', import.meta.url), 'utf8');
    expect(tab).toContain('const current = ++generation.current;');
    expect(tab).toContain('if (current === generation.current) setJournal(result);');
    expect(tab).toContain("journal.agentId === agentId ? journal : null");
    expect(tab).toMatch(/setJournal\(null\);\s*void load\(\);/);
  });

  it('the last successful run is the latest completion, not the latest created', () => {
    const journal = base();
    journal.runs = [
      { ...journal.runs[0], runId: 'early', createdAt: '2026-10-02T07:00:00.000Z', completedAt: '2026-10-02T09:30:00.000Z' },
      { ...journal.runs[0], runId: 'late', createdAt: '2026-10-02T08:00:00.000Z', completedAt: '2026-10-02T08:10:00.000Z' },
    ];
    const expected = new Date('2026-10-02T09:30:00.000Z').toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    expect(buildPlainJournal(journal).lines).toContain(`Последняя успешная выгрузка — в ${expected}.`);
  });

  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 Б');
    expect(formatBytes(2048)).toBe('2.0 КБ');
    expect(formatBytes(3 * 1024 ** 2)).toBe('3.0 МБ');
  });

  it('the page has the journal tab with both views, read via the daily journal API', () => {
    const page = readFileSync(new URL('./OnecPage.tsx', import.meta.url), 'utf8');
    const tab = readFileSync(new URL('./DailyJournalTab.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('./onecApi.ts', import.meta.url), 'utf8');
    expect(page).toMatch(/key:\s*'journal'/);
    expect(page).toContain('<DailyJournalTab agents={agents} />');
    expect(tab).toContain("{ label: 'Простой', value: 'plain' }");
    expect(tab).toContain("{ label: 'Технический', value: 'technical' }");
    expect(api).toContain('/journal/daily');
  });
});
