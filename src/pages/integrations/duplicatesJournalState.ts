import type { DuplicateStatusFilter, DuplicateSystem } from '../../api/integrationDuplicatesApiTypes';

/**
 * What the duplicates journal looked like when the user left it (filters, search, page, the open case), so going to a
 * client's card and back returns to the same place. Kept per browser tab in sessionStorage under the workspace state
 * namespace (user + session + rights), so another user or a new login starts clean.
 */
export interface DuplicatesJournalState {
  status: DuplicateStatusFilter;
  entityKind: string | null;
  ruleCode: string | null;
  system: DuplicateSystem | null;
  /** ISO dates (YYYY-MM-DD) of the period filter. */
  from: string | null;
  to: string | null;
  search: string;
  page: number;
  openCaseId: number | null;
}

export const DEFAULT_JOURNAL_STATE: DuplicatesJournalState = {
  status: 'open', entityKind: null, ruleCode: null, system: null, from: null, to: null, search: '', page: 1, openCaseId: null,
};

const STATUSES: readonly string[] = ['open', 'dismissed', 'external', 'merged', 'resolved', 'all'];
const SYSTEMS: readonly string[] = ['erp', 'bitrix', 'onec'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[a-z0-9_.]{1,64}$/;

export const journalStateKey = (namespace: string) => `erp:duplicates-journal:${namespace}`;

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null);

/** A stored state, or the default when nothing valid is stored; never throws. */
export function parseJournalState(raw: string | null): DuplicatesJournalState {
  if (!raw) return DEFAULT_JOURNAL_STATE;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_JOURNAL_STATE;
    value = parsed as Record<string, unknown>;
  } catch {
    return DEFAULT_JOURNAL_STATE;
  }
  const code = (v: unknown) => { const s = text(v, 64); return s && CODE.test(s) ? s : null; };
  const date = (v: unknown) => { const s = text(v, 10); return s && DATE.test(s) ? s : null; };
  const status = text(value.status, 16);
  const system = text(value.system, 16);
  const page = typeof value.page === 'number' && Number.isInteger(value.page) && value.page >= 1 && value.page <= 10_000 ? value.page : 1;
  const openCaseId = typeof value.openCaseId === 'number' && Number.isSafeInteger(value.openCaseId) && value.openCaseId > 0
    ? value.openCaseId : null;
  return {
    status: status && STATUSES.includes(status) ? (status as DuplicateStatusFilter) : DEFAULT_JOURNAL_STATE.status,
    entityKind: code(value.entityKind),
    ruleCode: code(value.ruleCode),
    system: system && SYSTEMS.includes(system) ? (system as DuplicateSystem) : null,
    from: date(value.from),
    to: date(value.to),
    search: (text(value.search, 200) ?? '').trim(),
    page,
    openCaseId,
  };
}

export function readJournalState(namespace: string): DuplicatesJournalState {
  try {
    return parseJournalState(window.sessionStorage.getItem(journalStateKey(namespace)));
  } catch {
    return DEFAULT_JOURNAL_STATE;
  }
}

export function writeJournalState(namespace: string, state: DuplicatesJournalState): void {
  try {
    window.sessionStorage.setItem(journalStateKey(namespace), JSON.stringify(state));
  } catch {
    // Storage blocked or full: the journal still works, it just opens fresh next time.
  }
}
