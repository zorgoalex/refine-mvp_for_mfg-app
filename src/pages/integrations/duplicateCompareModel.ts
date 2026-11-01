import type { DuplicateMemberDetail } from '../../api/integrationDuplicatesApiTypes';
import { formatDateTime, userText, viaLabel } from './duplicatesModel';

/** One value of a member in the comparison; `hidden` — the reader has no right to see it. */
export interface CompareCell { text: string; hidden: boolean }

export interface CompareRow {
  label: string;
  cells: CompareCell[];
  /** Visible values are not all the same. Identity rows (key, ERP id) always differ and are never marked. */
  differs: boolean;
}

const EMPTY = '—';

// Values that identify the record itself: they differ by definition, so they are shown but not marked.
const IDENTITY_LABELS = new Set(['ID в ERP', 'Ключ записи']);

const cell = (value: string | number | null | undefined): CompareCell => ({
  text: value === null || value === undefined || value === '' ? EMPTY : String(value),
  hidden: false,
});

const HIDDEN: CompareCell = { text: 'нет доступа', hidden: true };

/**
 * Members shown side by side: by default only the current ones (a member that left the case is history), all of them
 * when asked.
 */
export function compareMembers(members: DuplicateMemberDetail[], includeLeft: boolean): DuplicateMemberDetail[] {
  return includeLeft ? members : members.filter((member) => !member.leftAt);
}

/**
 * Rows of the comparison: the common fields of every member, then the facts of its kind in the order they first
 * appear. A fact a member does not have is «—»; a fact hidden from the reader stays «нет доступа» and does not count
 * as a difference.
 */
export function buildCompareRows(members: DuplicateMemberDetail[]): CompareRow[] {
  const rows: Array<{ label: string; cells: CompareCell[] }> = [
    { label: 'ID в ERP', cells: members.map((m) => cell(m.erpEntityId)) },
    { label: 'Ключ записи', cells: members.map((m) => cell(m.recordKey)) },
    { label: 'Создана', cells: members.map((m) => cell(m.recordCreatedAt ? formatDateTime(m.recordCreatedAt) : null)) },
    { label: 'Автор', cells: members.map((m) => cell(m.author ? userText(m.author) : m.authorExternal)) },
    { label: 'Как попала', cells: members.map((m) => cell(viaLabel(m.via))) },
    {
      label: 'Совпавшие значения',
      cells: members.map((m) => (m.matchedValues === null ? HIDDEN : cell(m.matchedValues.join(', ')))),
    },
  ];

  const factLabels: string[] = [];
  for (const member of members) {
    for (const fact of member.facts) if (!factLabels.includes(fact.label)) factLabels.push(fact.label);
  }
  for (const label of factLabels) {
    rows.push({
      label,
      cells: members.map((member) => {
        const facts = member.facts.filter((fact) => fact.label === label);
        if (!facts.length) return cell(null);
        if (facts.some((fact) => fact.hidden)) return HIDDEN;
        return cell(facts.map((fact) => (fact.value === null ? EMPTY : String(fact.value))).join(', '));
      }),
    });
  }

  return rows.map((row) => {
    const visible = row.cells.filter((c) => !c.hidden).map((c) => c.text);
    return { ...row, differs: !IDENTITY_LABELS.has(row.label) && new Set(visible).size > 1 };
  });
}
