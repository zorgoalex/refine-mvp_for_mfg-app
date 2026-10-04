import { describe, expect, it } from 'vitest';
import {
  buildClientScreenSnapshot, createClientScreenIdMap, filterClientScreenUi, resolveClientScreenTab, type ClientScreenOrderSource, type DetailField,
} from './buildClientScreenSnapshot';
import { CLIENT_SCREEN_CODES, CLIENT_SCREEN_DEFAULT_VISIBLE_CODES, isClientScreenCodeVisible } from './clientScreenRegistry';
import { clientScreenSnapshotSchema, clientScreenUiSchema, type ClientScreenUi } from './clientScreenSnapshotSchema';

/** Every value is a sentinel naming its code, so a leak is visible in the serialized snapshot. */
const S = (code: string, row = '') => `<<${code}${row}>>`;
const DETAIL_FIELDS: DetailField[] = ['n', 'name', 'height', 'width', 'quantity', 'area', 'material', 'milling_type', 'edge_type', 'film', 'price_per_sqm', 'cost', 'note', 'production_status'];
const group = <F extends string>(prefix: string, keys: readonly F[], row = '') => Object.fromEntries(keys.map((key) => [key, S(`${prefix}.${key}`, row)])) as Record<F, string>;

function source(over: Partial<ClientScreenOrderSource> = {}): ClientScreenOrderSource {
  return {
    tabs: [
      { key: 'basic', label: 'Обзор' }, { key: 'details', label: 'Состав' }, { key: 'dates', label: 'Логистика' },
      { key: 'finance', label: 'Финансы' }, { key: 'services', label: 'Услуги/товары' },
    ],
    summary: group('summary', ['number', 'client', 'parts', 'area', 'final', 'debt']),
    basic: group('basic', ['client', 'order_name', 'order_date', 'order_status', 'payment_status', 'production_status', 'manager', 'priority', 'doweling', 'notes']),
    dates: group('dates', ['planned', 'completion', 'issue']),
    finance: group('finance', ['total', 'discount', 'surcharge', 'final', 'paid', 'debt']),
    payments: [1, 2].map((n) => ({
      key: `PAYKEY-${n}`,
      values: { date: S('finance.payments', `#d${n}`), type: S('finance.payments', `#t${n}`), amount: S('finance.payments', `#a${n}`), note: S('finance.payments_note', `#${n}`) },
    })),
    details: {
      columnOrder: DETAIL_FIELDS,
      rows: [1, 2, 3].map((n) => ({ key: `DETAILKEY-${n}`, values: group('details', DETAIL_FIELDS, `#${n}`) })),
      grouping: null,
    },
    services: [1, 2].map((n) => ({ key: `SERVICEKEY-${n}`, values: group('services', ['name', 'quantity', 'price', 'sum'], `#${n}`) })),
    ...over,
  };
}
let counter = 0;
const ids = () => createClientScreenIdMap(() => `id${String(++counter).padStart(8, '0')}`);
const sentinelCodes = (json: string) => new Set([...json.matchAll(/<<([a-z_.]+)[^>]*>>/g)].map((match) => match[1]));

/** Deterministic pseudo-random subsets of the registry. */
function subsets(count: number): string[][] {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, () => CLIENT_SCREEN_CODES.filter(() => next() < 0.5));
}

describe('buildClientScreenSnapshot', () => {
  it('with nothing ticked sends no value at all', () => {
    const snapshot = buildClientScreenSnapshot(source(), [], ids());
    expect(snapshot).toEqual({ title: 'Ваш заказ', summary: [], tabs: [] });
    expect(sentinelCodes(JSON.stringify(snapshot)).size).toBe(0);
  });

  it('each code alone exposes exactly its own values, and a field needs its tab', () => {
    for (const code of CLIENT_SCREEN_CODES) {
      const alone = sentinelCodes(JSON.stringify(buildClientScreenSnapshot(source(), [code], ids())));
      const groupKey = code.split('.')[0];
      if (groupKey === 'summary') expect([...alone]).toEqual([code]);
      else expect([...alone]).toEqual([]); // a tab alone has no values; a field alone lacks its tab
      if (groupKey !== 'summary' && groupKey !== 'tab') {
        const withTab = sentinelCodes(JSON.stringify(buildClientScreenSnapshot(source(), [code, `tab.${groupKey}`], ids())));
        expect([...withTab]).toEqual(code === 'finance.payments_note' ? [] : [code]); // the note column needs the payments list
      }
    }
  });

  it('for random sets of codes the serialized snapshot holds values of visible codes only, never a private key, and passes the wire schema', () => {
    for (const codes of [...subsets(60), [...CLIENT_SCREEN_CODES], [...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES]]) {
      const visible = new Set<string>(codes);
      const grouped = source({
        details: { ...source().details, grouping: { field: 'note', groups: [{ key: 'GROUPKEY-note-secret', title: S('details.note', '#g'), rowKeys: ['DETAILKEY-1', 'DETAILKEY-2'] }] } },
      });
      const snapshot = buildClientScreenSnapshot(grouped, codes, ids());
      const json = JSON.stringify(snapshot);
      expect(json).not.toMatch(/DETAILKEY|PAYKEY|SERVICEKEY|GROUPKEY/);
      for (const code of sentinelCodes(json)) {
        expect(isClientScreenCodeVisible(code, visible), `${code} leaked with [${codes.join(',')}]`).toBe(true);
      }
      const expected = CLIENT_SCREEN_CODES.filter((code) => !code.startsWith('tab.') && isClientScreenCodeVisible(code, visible)
        && (code !== 'finance.payments_note' || isClientScreenCodeVisible('finance.payments', visible)));
      expect([...sentinelCodes(json)].sort()).toEqual([...expected].sort());
      expect(clientScreenSnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
  });

  it('group headers go only when the grouping field may be seen; otherwise the same rows go without headers', () => {
    const grouping = { field: 'price_per_sqm' as const, groups: [{ key: 'price:14500', title: S('details.price_per_sqm', '#g'), rowKeys: ['DETAILKEY-2', 'DETAILKEY-1'] }] };
    const src = source({ details: { ...source().details, grouping } });
    const hidden = buildClientScreenSnapshot(src, ['tab.details', 'details.name'], ids());
    expect(hidden.details?.groups).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain('price');
    expect(hidden.details?.rows).toHaveLength(3);
    const shown = buildClientScreenSnapshot(src, ['tab.details', 'details.name', 'details.price_per_sqm'], ids());
    expect(shown.details?.groups).toHaveLength(1);
    expect(shown.details?.groups?.[0].rowIds).toEqual([shown.details!.rows[1].id, shown.details!.rows[0].id]);
    expect(JSON.stringify(shown)).not.toContain('price:14500');
  });

  it('keeps the manager column order, drops repeats and columns the customer may not see', () => {
    const src = source({ details: { ...source().details, columnOrder: ['film', 'cost', 'name', 'film', 'n'] } });
    const snapshot = buildClientScreenSnapshot(src, ['tab.details', 'details.n', 'details.name', 'details.film'], ids());
    expect(snapshot.details?.columns.map((column) => column.code)).toEqual(['details.film', 'details.name', 'details.n']);
    expect(snapshot.details?.rows[0].cells).toEqual([S('details.film', '#1'), S('details.name', '#1'), S('details.n', '#1')]);
    expect(snapshot.tabs).toEqual([{ key: 'details', label: 'Состав', counter: '3' }]);
  });

  it('a value the manager does not have is not sent; an empty value is a dash', () => {
    const src = source({ finance: { total: undefined, discount: null, final: '' }, summary: { number: '2418', final: undefined, client: null } });
    const snapshot = buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES, ids());
    expect(snapshot.finance?.fields).toEqual([
      { code: 'finance.discount', label: 'Скидка', value: '—' }, { code: 'finance.final', label: 'Финальная сумма', value: '—' },
    ]);
    expect(snapshot.summary).toEqual([{ code: 'summary.client', label: 'Клиент', value: '—' }]);
    expect(snapshot.title).toBe('Заказ № 2418');
  });

  it('shows only tabs the manager has, with the manager labels and order; the number goes to the title only when ticked', () => {
    const src = source({ tabs: [{ key: 'finance', label: 'Финансы' }, { key: 'basic', label: 'Обзор' }] });
    const snapshot = buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES.filter((code) => code !== 'summary.number'), ids());
    expect(snapshot.tabs).toEqual([{ key: 'finance', label: 'Финансы' }, { key: 'basic', label: 'Обзор' }]);
    expect(snapshot.details).toBeUndefined();
    expect(snapshot.title).toBe('Ваш заказ');
    expect(JSON.stringify(snapshot)).not.toContain(S('summary.number'));
  });

  it('a column the manager has for no row at all is not sent, not even as dashes', () => {
    const noMoney = source({ services: [1, 2].map((n) => ({ key: `SERVICEKEY-${n}`, values: { name: `S${n}`, quantity: '1', price: undefined, sum: undefined } })) });
    const snapshot = buildClientScreenSnapshot(noMoney, CLIENT_SCREEN_CODES, ids());
    expect(snapshot.services?.columns.map((column) => column.code)).toEqual(['services.name', 'services.quantity']);
    expect(snapshot.services?.rows[0].cells).toEqual(['S1', '1']);
  });

  it('the interface state goes through the same policy: hidden codes, unknown rows and hidden tabs are dropped', () => {
    const codes = ['tab.details', 'details.name', 'details.quantity', 'tab.basic', 'basic.client'];
    const snapshot = buildClientScreenSnapshot(source(), codes, ids());
    const rowId = snapshot.details!.rows[0].id;
    const ui: ClientScreenUi = {
      tab: 'finance',
      focus: { code: 'details.cost', rowId },
      editing: { rowId, values: [{ code: 'details.name', value: 'видно' }, { code: 'details.cost', value: 'SECRET-COST' }, { code: 'basic.notes', value: 'SECRET-NOTE' }] },
      scroll: { ratio: 0.3, anchorRowId: 'notarowid0' },
      page: { current: 2, size: 50 },
    };
    const filtered = filterClientScreenUi(ui, snapshot, codes);
    expect(filtered).toEqual({
      tab: null, focus: null, editing: { rowId, values: [{ code: 'details.name', value: 'видно' }] }, scroll: { ratio: 0.3 }, page: { current: 2, size: 50 },
    });
    expect(JSON.stringify(filtered)).not.toMatch(/SECRET/);
    expect(clientScreenUiSchema.safeParse(filtered).success).toBe(true);
    // A row that is not in the snapshot, or only hidden values: no editing overlay at all.
    expect(filterClientScreenUi({ ...ui, editing: { rowId: 'unknownrow1', values: ui.editing!.values } }, snapshot, codes).editing).toBeNull();
    expect(filterClientScreenUi({ ...ui, editing: { rowId, values: [{ code: 'details.cost', value: 'SECRET-COST' }] } }, snapshot, codes).editing).toBeNull();
    // A visible focus and tab pass; a focus on a field of a hidden tab does not.
    expect(filterClientScreenUi({ ...ui, tab: 'details', focus: { code: 'details.name', rowId } }, snapshot, codes)).toMatchObject({ tab: 'details', focus: { code: 'details.name', rowId } });
    expect(filterClientScreenUi({ ...ui, focus: { code: 'dates.planned' } }, snapshot, [...codes, 'dates.planned']).focus).toBeNull();
    // With the details tab hidden nothing about its rows or its page goes.
    const noDetails = buildClientScreenSnapshot(source(), ['tab.basic', 'basic.client'], ids());
    expect(filterClientScreenUi(ui, noDetails, ['tab.basic', 'basic.client'])).toEqual({ tab: null, focus: null, editing: null, scroll: { ratio: 0.3 }, page: null });
  });

  it('ids are stable for a key within a presentation, differ between keys and scopes', () => {
    const idFor = ids();
    const first = buildClientScreenSnapshot(source(), CLIENT_SCREEN_CODES, idFor);
    const reordered = source();
    reordered.details = { ...reordered.details, rows: [...reordered.details.rows].reverse() };
    const second = buildClientScreenSnapshot(reordered, CLIENT_SCREEN_CODES, idFor);
    expect(second.details!.rows.map((row) => row.id)).toEqual([...first.details!.rows.map((row) => row.id)].reverse());
    expect(idFor('detail', 'x')).toBe(idFor('detail', 'x'));
    expect(idFor('detail', 'x')).not.toBe(idFor('payment', 'x'));
  });

  it('resolves the customer tab: the manager tab when visible, else the last visible one, else the first', () => {
    const tabs = { tabs: [{ key: 'basic' as const, label: 'a' }, { key: 'details' as const, label: 'b' }] };
    expect(resolveClientScreenTab('details', 'basic', tabs)).toBe('details');
    expect(resolveClientScreenTab('cut', 'details', tabs)).toBe('details');
    expect(resolveClientScreenTab('cut', 'finance', tabs)).toBe('basic');
    expect(resolveClientScreenTab(null, null, { tabs: [] })).toBeNull();
  });
});
