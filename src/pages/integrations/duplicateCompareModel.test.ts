import { describe, expect, it } from 'vitest';
import type { DuplicateMemberDetail } from '../../api/integrationDuplicatesApiTypes';
import { buildCompareRows, compareMembers } from './duplicateCompareModel';

const member = (over: Partial<DuplicateMemberDetail>): DuplicateMemberDetail => ({
  system: 'erp', entityKind: 'client', recordKey: '1', erpEntityId: 1, name: 'А', joinedAt: '2026-10-01T00:00:00Z',
  leftAt: null, recordCreatedAt: null, author: null, authorExternal: null, via: 'erp_manual',
  facts: [], matchedValues: [], ...over,
});

const row = (rows: ReturnType<typeof buildCompareRows>, label: string) => rows.find((r) => r.label === label)!;

describe('duplicate compare model', () => {
  it('lines members up by field and marks only real differences', () => {
    const rows = buildCompareRows([
      member({ recordKey: '1', erpEntityId: 1, matchedValues: ['87071112233'],
        facts: [{ label: 'Заказов', value: 3 }, { label: 'Активен', value: 'да' }] }),
      member({ recordKey: '2', erpEntityId: 2, matchedValues: ['87071112233'],
        facts: [{ label: 'Заказов', value: 0 }, { label: 'Активен', value: 'да' }] }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(
      ['ID в ERP', 'Ключ записи', 'Создана', 'Автор', 'Как попала', 'Совпавшие значения', 'Заказов', 'Активен'],
    );
    expect(row(rows, 'Заказов')).toMatchObject({ cells: [{ text: '3' }, { text: '0' }], differs: true });
    expect(row(rows, 'Активен').differs).toBe(false);
    expect(row(rows, 'Совпавшие значения').differs).toBe(false);
    // The record's own identity always differs: shown, never marked.
    expect(row(rows, 'Ключ записи')).toMatchObject({ cells: [{ text: '1' }, { text: '2' }], differs: false });
    expect(row(rows, 'ID в ERP').differs).toBe(false);
  });

  it('a fact one member lacks is «—»; a hidden value is «нет доступа» and is not a difference', () => {
    const rows = buildCompareRows([
      member({ system: 'onec', entityKind: 'onec_counterparty', erpEntityId: null, matchedValues: null,
        facts: [{ label: 'ИИН/БИН', value: null, hidden: true }, { label: 'Код 1С', value: '000123' }] }),
      member({ system: 'onec', entityKind: 'onec_counterparty', erpEntityId: null, matchedValues: null,
        facts: [{ label: 'ИИН/БИН', value: null, hidden: true }] }),
    ]);
    expect(row(rows, 'ИИН/БИН')).toMatchObject({ cells: [{ hidden: true }, { hidden: true }], differs: false });
    expect(row(rows, 'Совпавшие значения').cells.every((c) => c.hidden)).toBe(true);
    expect(row(rows, 'Код 1С')).toMatchObject({ cells: [{ text: '000123' }, { text: '—' }], differs: true });
    expect(row(rows, 'ID в ERP').cells.map((c) => c.text)).toEqual(['—', '—']);
  });

  it('a hidden value next to a visible one does not make the row differ', () => {
    const rows = buildCompareRows([
      member({ facts: [{ label: 'Оплачено', value: null, hidden: true }] }),
      member({ facts: [{ label: 'Оплачено', value: '1000' }] }),
    ]);
    expect(row(rows, 'Оплачено').differs).toBe(false);
  });

  it('members that left the case are shown only on request', () => {
    const members = [member({ recordKey: '1' }), member({ recordKey: '2', leftAt: '2026-10-20T00:00:00Z' })];
    expect(compareMembers(members, false).map((m) => m.recordKey)).toEqual(['1']);
    expect(compareMembers(members, true).map((m) => m.recordKey)).toEqual(['1', '2']);
  });
});
