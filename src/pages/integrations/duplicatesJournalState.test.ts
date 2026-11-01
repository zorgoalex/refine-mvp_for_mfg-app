import { describe, expect, it } from 'vitest';
import { DEFAULT_JOURNAL_STATE, journalStateKey, parseJournalState, readJournalState } from './duplicatesJournalState';

describe('duplicates journal state', () => {
  it('restores what was saved', () => {
    const state = {
      status: 'dismissed', entityKind: 'onec_counterparty', ruleCode: 'onec_counterparty.name', system: 'onec',
      from: '2026-10-01', to: '2026-10-31', search: 'Айдар', page: 3, openCaseId: 209,
    };
    expect(parseJournalState(JSON.stringify(state))).toEqual(state);
  });

  it('nothing stored, broken JSON or a non-object — the default journal', () => {
    expect(parseJournalState(null)).toEqual(DEFAULT_JOURNAL_STATE);
    expect(parseJournalState('{oops')).toEqual(DEFAULT_JOURNAL_STATE);
    expect(parseJournalState('42')).toEqual(DEFAULT_JOURNAL_STATE);
  });

  it('drops every value of a wrong shape, keeping the valid ones', () => {
    const parsed = parseJournalState(JSON.stringify({
      status: 'deleted', entityKind: 'Client; DROP', ruleCode: 7, system: 'sap', from: '01.10.2026', to: '2026-10-31',
      search: '  Тест  ', page: -2, openCaseId: 1.5,
    }));
    expect(parsed).toEqual({ ...DEFAULT_JOURNAL_STATE, to: '2026-10-31', search: 'Тест' });
    expect(parseJournalState(JSON.stringify({ search: 'x'.repeat(201), page: 20_000 }))).toEqual(DEFAULT_JOURNAL_STATE);
  });

  it('is kept per workspace namespace and never throws without storage', () => {
    expect(journalStateKey('actor:1|session:2|scope:a')).not.toBe(journalStateKey('actor:2|session:2|scope:a'));
    expect(readJournalState('actor:1|session:2|scope:a')).toEqual(DEFAULT_JOURNAL_STATE);
  });
});
