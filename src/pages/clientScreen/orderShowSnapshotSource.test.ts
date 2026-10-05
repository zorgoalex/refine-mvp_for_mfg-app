import { describe, expect, it } from 'vitest';
import { buildClientScreenSnapshot, createClientScreenIdMap } from './buildClientScreenSnapshot';
import { CLIENT_SCREEN_CODES } from './clientScreenRegistry';
import { clientScreenSnapshotSchema } from './clientScreenSnapshotSchema';
import {
  buildOrderShowSource, orderShowMirroredTab, SHOW_DETAIL_COLUMN_FIELDS, type OrderShowSourceInput,
} from './orderShowSnapshotSource';

function input(over: Partial<OrderShowSourceInput> = {}): OrderShowSourceInput {
  return {
    record: {
      order_id: 9001, order_name: 'ИМЯ-ЗАКАЗА-СЕКРЕТ', client_id: 5, client_name: 'Клиент из записи', total_amount: 120000, discount: 5000,
      surcharge: 0, final_amount: 115000, paid_amount: 40000, notes: 'ЗАМЕТКА-СЕКРЕТ', order_status_name: 'В работе',
    },
    clientName: 'Садыков Арман',
    details: [
      { detail_id: 71, detail_number: 1, detail_name: 'Фасад', height: 716, width: 396.5, quantity: 4, area: 1.13, milling_type_id: 1, edge_type_id: 2,
        film_id: 8, milling_cost_per_sqm: 14500, detail_cost: 16385, note: 'ручка сверху', production_status_id: 4, material_id: 3 },
      { detail_id: 72, detail_number: 2, height: 100, width: 2400, quantity: 2, area: 0.48, milling_type_id: 77, milling_type_name: 'Старая фрезеровка',
        edge_type_id: null, film_id: 99, film_name: 'Плёнка снята', milling_cost_per_sqm: null, detail_cost: null, note: null, material_id: 4 },
    ],
    groupedRows: null,
    groupField: null,
    columnKeys: ['detail_number', 'height', 'width', 'quantity', 'area', 'milling_type', 'hdf_parameter_override_mm', 'edge_type', 'material', 'note',
      'milling_cost_per_sqm', 'detail_cost', 'film', 'production_status_id', 'doweling', 'cut_job', 'basis_project'],
    payments: [{ payment_id: 31, type_paid_id: 2, amount: 40000, payment_date: '2026-10-02', notes: 'предоплата' }],
    names: {
      millingType: new Map([[1, 'Модерн']]), edgeType: new Map([[2, 'R2']]), film: new Map([[8, 'Белый софт']]), paymentType: new Map([[2, 'Kaspi']]),
      productionStatus: (id) => ({ 4: 'Фрезеровка' } as Record<number, string>)[id],
      materialOf: (detail) => ({ 3: 'МДФ 16 мм' } as Record<number, string>)[Number(detail.material_id)] ?? null,
    },
    canViewFinancials: true,
    ...over,
  };
}
const ALL = [...CLIENT_SCREEN_CODES];

describe('buildOrderShowSource', () => {
  it('gives the two tabs of the view page, names instead of ids, the page formats', () => {
    const source = buildOrderShowSource(input());
    expect(source.tabs.map((tab) => tab.key)).toEqual(['details', 'finance']);
    expect(source.summary).toMatchObject({ number: null, client: 'Садыков Арман', parts: '6' });
    expect(source.summary.final).toMatch(/^115\s000,00 /);
    expect(source.details.columnOrder).toEqual(['n', 'height', 'width', 'quantity', 'area', 'milling_type', 'edge_type', 'material', 'note',
      'price_per_sqm', 'cost', 'film', 'production_status']);
    expect(source.details.rows[0]).toMatchObject({
      key: '71',
      values: { n: '1', name: 'Фасад', height: '716', width: '396,50', quantity: '4', material: 'МДФ 16 мм', milling_type: 'Модерн', edge_type: 'R2',
        film: 'Белый софт', note: 'ручка сверху', production_status: 'Фрезеровка' },
    });
    // Names the reference lists no longer have come from the detail itself, as on the page; never an id.
    expect(source.details.rows[1].values).toMatchObject({ milling_type: 'Старая фрезеровка', film: 'Плёнка снята', edge_type: null, material: null });
    expect(source.payments[0]).toMatchObject({ key: '31', values: { date: '02.10.2026', type: 'Kaspi', note: 'предоплата' } });
    expect(source.finance.debt).toMatch(/^75\s000,00 /);
  });

  it('the client name falls back to the record; the order name never becomes the number', () => {
    const source = buildOrderShowSource(input({ clientName: null }));
    expect(source.summary.client).toBe('Клиент из записи');
    const snapshot = buildClientScreenSnapshot(source, ALL, createClientScreenIdMap(() => 'idaaaaaa'));
    expect(snapshot.title).toBe('Ваш заказ');
  });

  it('without the right to see money nothing of it is passed on: no finance tab, no money columns, no payments', () => {
    const source = buildOrderShowSource(input({ canViewFinancials: false }));
    expect(source.tabs.map((tab) => tab.key)).toEqual(['details']);
    expect(source.summary.final).toBeUndefined();
    expect(source.summary.debt).toBeUndefined();
    expect(Object.values(source.finance).every((value) => value === undefined)).toBe(true);
    expect(source.payments).toEqual([]);
    expect(source.details.rows.every((row) => row.values.cost === undefined && row.values.price_per_sqm === undefined)).toBe(true);
    let counter = 0;
    const snapshot = buildClientScreenSnapshot(source, ALL, createClientScreenIdMap(() => `id${String(counter += 1).padStart(6, '0')}`));
    const wire = JSON.stringify(snapshot);
    for (const money of ['16 385', '16385', '14 500', '14500', '115 000', '115000', '40 000', '40000', 'Kaspi', 'предоплата']) expect(wire).not.toContain(money);
    expect(snapshot.details!.columns.map((column) => column.code)).not.toContain('details.cost');
    expect(snapshot.finance).toBeUndefined();
  });

  it('groups of the page: titles of the separators, the first group from the page label', () => {
    const base = input();
    const groupedRows = [
      { kind: 'detail', detail: base.details[0], groupIndex: 0 },
      { kind: 'separator', groupIndex: 1, key: '__sep__:film:99:1', selectionKeys: [72], label: 'Плёнка снята' },
      { kind: 'detail', detail: base.details[1], groupIndex: 1 },
    ];
    const source = buildOrderShowSource(input({ groupedRows, groupField: 'film', groupLabelOf: () => 'Белый софт' }));
    expect(source.details.grouping).toEqual({
      field: 'film', groups: [{ key: '0', title: 'Белый софт', rowKeys: ['71'] }, { key: '1', title: 'Плёнка снята', rowKeys: ['72'] }],
    });
    // A grouping the customer screen has no field for sends no titles.
    const byCut = buildOrderShowSource(input({ groupedRows, groupField: 'cut_job', groupLabelOf: () => 'Раскрой 12' }));
    expect(byCut.details.grouping?.field).toBeNull();
    const snapshot = buildClientScreenSnapshot(byCut, ALL, createClientScreenIdMap(() => `id${Math.random().toString(36).slice(2, 10)}`));
    expect(snapshot.details!.groups).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('Раскрой 12');
  });

  it('only ticked codes reach the wire; values of the record that have no code never do', () => {
    let counter = 0;
    const idFor = createClientScreenIdMap(() => `id${String(counter += 1).padStart(6, '0')}`);
    const snapshot = buildClientScreenSnapshot(buildOrderShowSource(input()), ['tab.details', 'details.n', 'details.height', 'summary.client'], idFor);
    expect(clientScreenSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const wire = JSON.stringify(snapshot);
    for (const hidden of ['ИМЯ-ЗАКАЗА-СЕКРЕТ', 'ЗАМЕТКА-СЕКРЕТ', 'ручка сверху', 'Белый софт', 'Модерн', 'Kaspi', '9001', '"71"', 'В работе']) {
      expect(wire).not.toContain(hidden);
    }
    expect(snapshot.details!.columns.map((column) => column.code)).toEqual(['details.n', 'details.height']);
    expect(snapshot.tabs.map((tab) => tab.key)).toEqual(['details']);
  });

  it('client phones from the view page: sent only when loaded and ticked', () => {
    const contacts = { phone: '8 705 222 3344', otherPhones: null };
    const summaryOf = (over: Partial<OrderShowSourceInput>, codes: readonly string[]) =>
      buildClientScreenSnapshot(buildOrderShowSource(input(over)), codes, createClientScreenIdMap(() => 'idaaaaaa')).summary;
    expect(summaryOf({ clientContacts: contacts }, ALL).filter((field) => field.code.startsWith('summary.client_phone'))).toEqual([
      { code: 'summary.client_phone', label: 'Телефон клиента', value: '8 705 222 3344' },
      { code: 'summary.client_phones', label: 'Доп. телефоны клиента', value: '—' },
    ]);
    expect(JSON.stringify(summaryOf({ clientContacts: contacts }, ['summary.client']))).not.toContain('705 222');
    expect(summaryOf({}, ALL).some((field) => field.code.startsWith('summary.client_phone'))).toBe(false);
  });

  it('every view column key maps to a field of the registry', () => {
    const fields = new Set(CLIENT_SCREEN_CODES.filter((code) => code.startsWith('details.')).map((code) => code.slice('details.'.length)));
    for (const field of Object.values(SHOW_DETAIL_COLUMN_FIELDS)) expect(fields.has(field)).toBe(true);
  });
});

describe('view page: what the reviewer asked to pin down', () => {
  const wireOf = (source: ReturnType<typeof buildOrderShowSource>, codes: readonly string[] = ALL) =>
    JSON.stringify(buildClientScreenSnapshot(source, codes, createClientScreenIdMap(() => `id${Math.random().toString(36).slice(2, 10)}`)));

  it.each([['price', '14 500 ₸/м²'], ['detail_cost', '16 385 ₸']])('grouping by %s without the right to see money sends no group titles', (groupField, title) => {
    const base = input();
    const groupedRows = [
      { kind: 'detail', detail: base.details[0], groupIndex: 0 },
      { kind: 'separator', groupIndex: 1, key: 's1', selectionKeys: [72], label: `РАЗДЕЛИТЕЛЬ ${title}` },
      { kind: 'detail', detail: base.details[1], groupIndex: 1 },
    ];
    const source = buildOrderShowSource(input({ canViewFinancials: false, groupedRows, groupField, groupLabelOf: () => `ПЕРВАЯ ${title}` }));
    expect(source.details.grouping).toBeNull();
    const wire = wireOf(source);
    for (const hidden of ['РАЗДЕЛИТЕЛЬ', 'ПЕРВАЯ', '14 500', '16 385']) expect(wire).not.toContain(hidden);
    // With the right the same grouping is mirrored.
    expect(buildOrderShowSource(input({ groupedRows, groupField, groupLabelOf: () => 'x' })).details.grouping?.groups).toHaveLength(2);
  });

  it('the snapshot builder itself drops group titles of a field the manager has no values for', () => {
    const base = input();
    const source = buildOrderShowSource(input({ canViewFinancials: false }));
    const forged = { ...source, details: { ...source.details, grouping: { field: 'cost' as const, groups: [{ key: '0', title: 'ДЕНЬГИ-В-ЗАГОЛОВКЕ', rowKeys: ['71', '72'] }] } } };
    expect(wireOf(forged)).not.toContain('ДЕНЬГИ-В-ЗАГОЛОВКЕ');
    expect(base.canViewFinancials).toBe(true);
  });

  it('a live production status wins over the saved one; a cleared live status is empty', () => {
    const live = buildOrderShowSource(input({ liveProductionStatusByDetailId: new Map<number, unknown>([[71, 5], [72, 4]]),
      names: { ...input().names, productionStatus: (id) => ({ 4: 'Фрезеровка', 5: 'Шлифовка' } as Record<number, string>)[id] } }));
    expect(live.details.rows.map((row) => row.values.production_status)).toEqual(['Шлифовка', 'Фрезеровка']);
    const cleared = buildOrderShowSource(input({ liveProductionStatusByDetailId: new Map<number, unknown>([[71, null]]) }));
    expect(cleared.details.rows[0].values.production_status).toBeNull();
    expect(buildOrderShowSource(input()).details.rows[0].values.production_status).toBe('Фрезеровка');
  });

  it('rows follow the grouped order of the page even when the group titles may not be sent', () => {
    const third = { detail_id: 73, detail_number: 3, height: 1, width: 1, quantity: 1, area: 0, milling_type_id: 1, film_id: 8 };
    const base = input();
    const details = [base.details[0], base.details[1], third];
    // On screen: 71 and 73 in the first group, 72 in the second.
    const groupedRows = [
      { kind: 'detail', detail: details[0], groupIndex: 0 }, { kind: 'detail', detail: details[2], groupIndex: 0 },
      { kind: 'separator', groupIndex: 1, key: 's1', selectionKeys: [72], label: 'Раскрой 12' },
      { kind: 'detail', detail: details[1], groupIndex: 1 },
    ];
    const unsupported = buildOrderShowSource(input({ details, groupedRows, groupField: 'cut_job', groupLabelOf: () => 'Раскрой 7' }));
    expect(unsupported.details.rows.map((row) => row.key)).toEqual(['71', '73', '72']);
    const snapshot = buildClientScreenSnapshot(unsupported, ALL, createClientScreenIdMap(() => `id${Math.random().toString(36).slice(2, 10)}`));
    expect(snapshot.details!.groups).toBeUndefined();
    expect(snapshot.details!.rows.map((row) => row.cells[0])).toEqual(['1', '3', '2']);
    // Grouping by a field that is not ticked: same order, no titles.
    const unticked = buildOrderShowSource(input({ details, groupedRows, groupField: 'film', groupLabelOf: () => 'Белый софт' }));
    const hidden = buildClientScreenSnapshot(unticked, ['tab.details', 'details.n'], createClientScreenIdMap(() => `id${Math.random().toString(36).slice(2, 10)}`));
    expect(hidden.details!.groups).toBeUndefined();
    expect(hidden.details!.rows.map((row) => row.cells[0])).toEqual(['1', '3', '2']);
  });
});

describe('the panel of the view page as a customer tab', () => {
  it('finance panel → finance tab; everything else → the detail table', () => {
    expect(orderShowMirroredTab('finance', true)).toBe('finance');
    expect(orderShowMirroredTab('finance', false)).toBe('details');
    expect(orderShowMirroredTab('groups', true)).toBe('details');
    expect(orderShowMirroredTab(null, true)).toBe('details');
  });
});
