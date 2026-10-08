import { describe, expect, it } from 'vitest';
import { buildClientScreenSnapshot, createClientScreenIdMap, filterClientScreenUi } from './buildClientScreenSnapshot';
import { buildMirrorView } from './mirrorView';
import { CLIENT_SCREEN_CODES, CLIENT_SCREEN_DEFAULT_VISIBLE_CODES } from './clientScreenRegistry';
import { DEFAULT_DETAIL_COLUMNS } from './useClientScreenOrderBridge';
import { clientScreenSnapshotSchema } from './clientScreenSnapshotSchema';
import {
  buildOrderEditSource, clientScreenClientContacts, clientScreenHeaderPeople, clientScreenPhone, clientScreenPhonesOf, DETAIL_COLUMN_FIELDS, GROUPING_FIELDS, orderEditEditingValues,
  type OrderEditSourceInput,
} from './orderEditSnapshotSource';

const map = (entries: Record<number, string>) => (id: number | null | undefined) => (id === null || id === undefined ? undefined : entries[id]);

function input(over: Partial<OrderEditSourceInput> = {}): OrderEditSourceInput {
  return {
    header: {
      order_name: 'Кухня — фасады', client_id: 5, order_date: '2026-10-02', order_status_id: 2, payment_status_id: 3, production_status_id: 4,
      manager_id: 9, priority: 100, notes: 'Позвонить за день', planned_completion_date: '2026-10-16', completion_date: null, issue_date: undefined,
      total_amount: 120000, discount: 5000, surcharge: 0, final_amount: 115000, paid_amount: 40000,
    },
    details: [
      { detail_id: 71, detail_number: 1, detail_name: 'Фасад верхний', height: 716, width: 396.5, quantity: 4, area: 1.13, material_id: null,
        sheet_material_type_id: 3, milling_type_id: 1, edge_type_id: 2, film_id: 8, milling_cost_per_sqm: 14500, detail_cost: 16385, note: 'ручка сверху',
        priority: 100, production_status_id: 4 },
      { temp_id: -5, detail_number: 2, detail_name: null, height: 100, width: 2400, quantity: 2, area: 0.48, material_id: null,
        sheet_material_type_id: 99, milling_type_id: 1, edge_type_id: 2, film_id: null, milling_cost_per_sqm: null, detail_cost: null, note: null, priority: 100 },
    ] as OrderEditSourceInput['details'],
    payments: [{ payment_id: 31, type_paid_id: 2, amount: 40000, payment_date: '2026-10-02', notes: 'предоплата' }],
    catalogLines: [{ id: 12, catalogItemId: 1, name: 'Доставка', sku: null, kind: 'service', unitId: 1, unitName: 'шт', refKey1c: null,
      quantity: '2', unitPrice: '3000', catalogActive: true }] as OrderEditSourceInput['catalogLines'],
    dowelingLinks: [{ order_id: 1, doweling_order_id: 2, doweling_order: { doweling_order_id: 2, doweling_order_name: 'П-17' } }],
    orderNumber: '2418',
    tabs: [{ key: 'basic', label: 'Основная информация' }, { key: 'details', label: 'Детали заказа' }, { key: 'hdf', label: 'ХДФ' },
      { key: 'dates', label: 'Даты' }, { key: 'finance', label: 'Финансы' }, { key: 'cut', label: 'Раскрой' }, { key: 'services', label: 'Услуги/товары' }],
    names: {
      client: map({ 5: 'Садыков Арман' }), orderStatus: map({ 2: 'В работе' }), paymentStatus: map({ 3: 'Частично оплачен' }),
      productionStatus: map({ 4: 'Фрезеровка' }), employee: map({ 9: 'Алия К.' }), sheetMaterial: map({ 3: 'МДФ 16 мм' }),
      millingType: map({ 1: 'Модерн' }), edgeType: map({ 2: 'R2' }), film: map({ 8: 'Белый софт' }), paymentType: map({ 2: 'Kaspi' }),
    },
    detailColumnOrder: ['detail_number', 'height', 'width', 'quantity', 'area', 'milling_type_id', 'hdf_parameter_override_mm', 'edge_type_id',
      'sheet_material_type_id', 'note', 'doweling', 'milling_cost_per_sqm', 'detail_cost', 'film_id', 'cut_job', 'production_status_id', 'detail_name', 'actions'],
    grouping: null,
    canViewServiceMoney: true,
    ...over,
  };
}

describe('buildOrderEditSource', () => {
  it('shows names instead of ids and the formats of the form', () => {
    const source = buildOrderEditSource(input());
    expect(source.summary).toMatchObject({ number: '2418', client: 'Садыков Арман', parts: '6' });
    expect(source.summary.area).toMatch(/ м²$/);
    expect(source.basic).toEqual({
      client: 'Садыков Арман', order_name: 'Кухня — фасады', order_date: '02.10.2026', order_status: 'В работе', payment_status: 'Частично оплачен',
      production_status: 'Фрезеровка', manager: 'Алия К.', priority: '100', doweling: 'П-17', notes: 'Позвонить за день',
    });
    expect(source.dates).toEqual({ planned: '16.10.2026', completion: null, issue: null });
    expect(source.payments[0]).toMatchObject({ key: '31', values: { date: '02.10.2026', type: 'Kaspi', note: 'предоплата' } });
    expect(source.payments[0].values.amount).toMatch(/^40\s000,00 /);
    expect(source.details.rows[0]).toMatchObject({
      key: '71',
      values: { n: '1', name: 'Фасад верхний', height: '716', width: '396,50', quantity: '4', material: 'МДФ 16 мм', milling_type: 'Модерн',
        edge_type: 'R2', film: 'Белый софт', note: 'ручка сверху', production_status: 'Фрезеровка' },
    });
    // New row (temp id), unknown material name, empty film/price/cost: empty values, never ids.
    expect(source.details.rows[1]).toMatchObject({ key: '-5', values: { material: null, film: null, price_per_sqm: null, cost: null, name: null } });
    expect(source.services[0]).toEqual({ key: 'id:12', values: { name: 'Доставка', quantity: '2 шт', price: '3 000,00'.replace(' ', ' '), sum: '6 000,00'.replace(' ', ' ') } });
  });

  it('maps only known tabs, columns and grouping fields; everything else is left out', () => {
    const source = buildOrderEditSource(input({ grouping: { field: 'unknown_grouping', groups: [{ key: '__sep__:x:8:0', label: 'Нечто 8', rowKeys: [71] }] } }));
    expect(source.tabs.map((tab) => tab.key)).toEqual(['basic', 'details', 'hdf', 'dates', 'finance', 'services']);
    // (The test input lists the form's tabs by hand; «Материалы» is covered with its own tests.)
    expect(source.tabs[1].label).toBe('Детали заказа');
    // Every column of the manager's table has a field; only «Действия» has none.
    expect(source.details.columnOrder).toEqual(['n', 'height', 'width', 'quantity', 'area', 'milling_type', 'hdf_parameter', 'edge_type', 'material', 'note',
      'doweling', 'price_per_sqm', 'cost', 'film', 'cut_job', 'production_status', 'name']);
    expect(source.details.grouping?.field).toBeNull();
    const byFilm = buildOrderEditSource(input({ grouping: { field: 'film', groups: [{ key: 'k', label: 'Белый софт', rowKeys: [71] }] } }));
    expect(byFilm.details.grouping).toEqual({ field: 'film', groups: [{ key: 'k', title: 'Белый софт', rowKeys: ['71'] }] });
    expect(new Set(Object.values(DETAIL_COLUMN_FIELDS)).size).toBe(Object.keys(DETAIL_COLUMN_FIELDS).length);
    for (const field of Object.values(GROUPING_FIELDS)) expect(Object.values(DETAIL_COLUMN_FIELDS)).toContain(field);
  });

  it('the row being edited is shown with the values of its editor, totals included', () => {
    const source = buildOrderEditSource(input({ editingRow: { rowKey: 71, values: { quantity: 10, film_id: null, note: 'без ручки' } } }));
    expect(source.details.rows[0].values).toMatchObject({ quantity: '10', film: null, note: 'без ручки' });
    expect(source.summary.parts).toBe('12');
  });

  it('without the order number the title is generic: the order name never stands in for it', () => {
    const src = buildOrderEditSource(input({ orderNumber: null, header: { ...input().header, order_name: 'PRIVATE-NAME' } }));
    expect(src.summary.number).toBeNull();
    const idFor = createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })());
    const onlyNumber = buildClientScreenSnapshot(src, ['summary.number', 'tab.basic', 'basic.client'], idFor);
    expect(onlyNumber.title).toBe('Ваш заказ');
    expect(JSON.stringify(onlyNumber)).not.toContain('PRIVATE-NAME');
    // The name goes only with its own tick.
    expect(JSON.stringify(buildClientScreenSnapshot(src, ['tab.basic', 'basic.order_name'], idFor))).toContain('PRIVATE-NAME');
  });

  it('every header value reaches the wire only under its own code (adapter → snapshot, sentinel values)', () => {
    const names = (prefix: string) => (id: number | null | undefined) => (id === null || id === undefined ? undefined : `<<${prefix}>>`);
    const src = buildOrderEditSource(input({
      orderNumber: '<<summary.number>>',
      header: { ...input().header, order_name: '<<basic.order_name>>', notes: '<<basic.notes>>' },
      names: { ...input().names, client: names('client'), orderStatus: names('basic.order_status'), paymentStatus: names('basic.payment_status'),
        productionStatus: names('production_status'), employee: names('basic.manager') },
    }));
    const idFor = createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })());
    for (const code of ['summary.number', 'basic.order_name', 'basic.notes', 'basic.order_status', 'basic.payment_status', 'basic.manager']) {
      // Some values are shown by two codes (the header and the «Основное» tab): both off hide them.
      const twins: Record<string, string> = { 'basic.order_name': 'summary.order_name', 'basic.order_status': 'summary.order_status', 'basic.payment_status': 'summary.payment_status' };
      const same = twins[code] ? [code, twins[code]] : [code];
      const others = CLIENT_SCREEN_CODES.filter((item) => !same.includes(item));
      expect(JSON.stringify(buildClientScreenSnapshot(src, others, idFor)), code).not.toContain(`<<${code}>>`);
      expect(JSON.stringify(buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES, idFor)), code).toContain(`<<${code}>>`);
    }
  });

  it('money the manager does not have stays unavailable and its columns are not sent', () => {
    const src = buildOrderEditSource(input({
      canViewServiceMoney: false,
      header: { ...input().header, total_amount: undefined, final_amount: undefined, paid_amount: undefined, discount: undefined as unknown as number, surcharge: undefined },
    }));
    expect(src.finance).toEqual({ total: undefined, discount: undefined, surcharge: undefined, final: undefined, paid: undefined, debt: undefined });
    const idFor = createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })());
    const snapshot = buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES, idFor);
    expect(snapshot.finance?.fields).toEqual([]);
    expect(snapshot.services?.columns.map((column) => column.code)).toEqual(['services.name', 'services.quantity']);
    // The details still carry their costs here, so the summary total is known.
    expect(src.summary.final).toMatch(/ /);

    // Nothing to build a total from, and no prices on the details: no summary amounts, no price columns.
    const bare = buildOrderEditSource(input({
      canViewServiceMoney: false,
      header: { ...input().header, total_amount: undefined, final_amount: undefined, paid_amount: undefined },
      details: input().details.map((detail) => ({ ...detail, milling_cost_per_sqm: undefined, detail_cost: undefined })),
    }));
    expect(bare.summary.final).toBeUndefined();
    expect(bare.summary.debt).toBeUndefined();
    const bareSnapshot = buildClientScreenSnapshot(bare, CLIENT_SCREEN_CODES, idFor);
    const bareCodes = bareSnapshot.summary.map((field) => field.code);
    expect(bareCodes).toEqual(expect.arrayContaining(['summary.client', 'summary.parts', 'summary.area']));
    for (const money of ['summary.final', 'summary.discount', 'summary.surcharge', 'summary.paid', 'summary.debt']) expect(bareCodes).not.toContain(money);
    expect(bareSnapshot.details?.columns.map((column) => column.code)).not.toContain('details.cost');
    expect(bareSnapshot.details?.columns.map((column) => column.code)).not.toContain('details.price_per_sqm');
    // An intentionally empty price (null) is an empty cell of a column the manager does see.
    const emptyPrice = buildClientScreenSnapshot(buildOrderEditSource(input({
      details: input().details.map((detail) => ({ ...detail, milling_cost_per_sqm: null, detail_cost: null })),
    })), CLIENT_SCREEN_CODES, idFor);
    const costAt = emptyPrice.details!.columns.findIndex((column) => column.code === 'details.cost');
    expect(costAt).toBeGreaterThanOrEqual(0);
    expect(emptyPrice.details!.rows[0].cells[costAt]).toBe('—');
    // A zero that the manager does see stays a value.
    expect(buildOrderEditSource(input({ header: { ...input().header, surcharge: 0 } })).finance.surcharge).toMatch(/^0,00 /);
  });

  it('service prices are absent without the right to see them', () => {
    const source = buildOrderEditSource(input({ canViewServiceMoney: false }));
    expect(source.services[0].values).toEqual({ name: 'Доставка', quantity: '2 шт', price: undefined, sum: undefined });
  });

  it('the result goes through the snapshot builder and the wire schema, and carries no ids of the order', () => {
    const snapshot = buildClientScreenSnapshot(buildOrderEditSource(input()), CLIENT_SCREEN_CODES, createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })()));
    expect(clientScreenSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.title).toBe('Заказ № 2418');
    expect(snapshot.details?.columns.map((column) => column.label)).toContain('Обкат');
    const json = JSON.stringify(snapshot);
    for (const leak of ['detail_id', 'client_id', '"71"', 'id:12', 'payment_id']) expect(json).not.toContain(leak);
  });
});

describe('the table of the manager: row order, the row being filled, live editor values', () => {
  const details = [
    { detail_id: 1, detail_number: 3, height: 300, width: 100, quantity: 1, area: 0.03 },
    { detail_id: 2, detail_number: 1, height: 100, width: 100, quantity: 1, area: 0.01 },
    { detail_id: 3, detail_number: 2, height: 200, width: 100, quantity: 1, area: 0.02 },
    { temp_id: -9, detail_number: 4, is_placeholder: true },
  ] as unknown as OrderEditSourceInput['details'];
  const keys = (over: Partial<OrderEditSourceInput>) => buildOrderEditSource(input({ details, ...over })).details.rows.map((row) => row.key);

  it('without a table order rows go by number, as the table shows them by default', () => {
    expect(keys({})).toEqual(['2', '3', '1']);
  });

  it('follows the order of the table of the manager; rows it does not name go after, by number', () => {
    expect(keys({ detailRowOrder: ['1', 3, '2'] })).toEqual(['1', '3', '2']);
    expect(keys({ detailRowOrder: ['3', 'unknown'] })).toEqual(['3', '2', '1']);
  });

  it('an empty grid row is not a detail — until the manager starts filling it', () => {
    expect(keys({ detailRowOrder: ['2', '3', '1', '-9'] })).toEqual(['2', '3', '1']);
    const source = buildOrderEditSource(input({ details, detailRowOrder: ['2', '3', '1', '-9'], editingRow: { rowKey: -9, values: {} } }));
    expect(source.details.rows.map((row) => row.key)).toEqual(['2', '3', '1', '-9']);
    expect(source.summary.parts).toBe('3');
  });

  it('editor values become display text, one item per visible known column', () => {
    const base = input();
    const detail = base.details[0];
    const values = orderEditEditingValues(
      detail,
      { height: 720, width: '400', quantity: null, film_id: null, milling_type_id: 1, note: 'новая', unknown_field: 'x', detail_number: 99 },
      base.names,
      ['detail_number', 'height', 'width', 'quantity', 'film_id', 'milling_type_id', 'note', 'cut_job', 'actions', 'height'],
    );
    expect(values).toEqual([
      { code: 'details.n', value: '1' },
      { code: 'details.height', value: '720' },
      { code: 'details.width', value: '400' },
      { code: 'details.quantity', value: '—' },
      { code: 'details.film', value: '—' },
      { code: 'details.milling_type', value: 'Модерн' },
      { code: 'details.note', value: 'новая' },
    ]);
  });

  it('money the manager does not have is not invented by the editor', () => {
    const base = input();
    const detail = { ...base.details[0], detail_cost: undefined, milling_cost_per_sqm: undefined } as unknown as OrderEditSourceInput['details'][number];
    const codes = orderEditEditingValues(detail, { height: 1 }, base.names, ['height', 'detail_cost', 'milling_cost_per_sqm']).map((item) => item.code);
    expect(codes).toEqual(['details.height']);
  });

  it('a reference id the form has no name for is shown empty, never as the id', () => {
    const base = input();
    const values = orderEditEditingValues(base.details[0], { film_id: 4242 }, base.names, ['film_id']);
    expect(values).toEqual([{ code: 'details.film', value: '—' }]);
  });

  it('a select cleared with its cross holds undefined: the customer sees it empty, not the saved name', () => {
    const base = input();
    const detail = { ...base.details[0], material_name_resolved: 'МДФ 16 мм' } as OrderEditSourceInput['details'][number];
    const cleared = orderEditEditingValues(
      detail, { film_id: undefined, sheet_material_type_id: undefined, milling_type_id: undefined, note: undefined },
      base.names, ['film_id', 'sheet_material_type_id', 'milling_type_id', 'note', 'height'],
    );
    expect(cleared).toEqual([
      { code: 'details.film', value: '—' }, { code: 'details.material', value: '—' }, { code: 'details.milling_type', value: '—' },
      { code: 'details.note', value: '—' }, { code: 'details.height', value: '716' },
    ]);
    // A field the editor does not have at all keeps what is saved.
    expect(orderEditEditingValues(detail, {}, base.names, ['film_id', 'sheet_material_type_id']))
      .toEqual([{ code: 'details.film', value: 'Белый софт' }, { code: 'details.material', value: 'МДФ 16 мм' }]);
  });

  it('money the manager has can be cleared; money the manager does not have stays unavailable', () => {
    const base = input();
    expect(orderEditEditingValues(base.details[0], { detail_cost: undefined }, base.names, ['detail_cost']))
      .toEqual([{ code: 'details.cost', value: '—' }]);
    const noMoney = { ...base.details[0], detail_cost: undefined } as unknown as OrderEditSourceInput['details'][number];
    expect(orderEditEditingValues(noMoney, { detail_cost: undefined }, base.names, ['detail_cost'])).toEqual([]);
  });

  it('a cleared film goes through the settings filter like any value and is gone when the edit is cancelled', () => {
    const base = input();
    const idFor = createClientScreenIdMap(() => `id${Math.random().toString(36).slice(2, 10)}`);
    const codes = ['tab.details', 'details.n', 'details.film'];
    const snapshot = buildClientScreenSnapshot(buildOrderEditSource(base), codes, idFor);
    const rowId = idFor('detail', '71');
    const values = orderEditEditingValues(base.details[0], { film_id: undefined, note: 'секрет' }, base.names, ['detail_number', 'film_id', 'note']);
    const ui = filterClientScreenUi({ tab: 'details', focus: null, editing: { rowId, values }, scroll: null, page: null }, snapshot, codes);
    expect(ui.editing).toEqual({ rowId, values: [{ code: 'details.n', value: '1' }, { code: 'details.film', value: '—' }] });
    expect(buildMirrorView(snapshot, ui).table!.rows[0].cells.map((cell) => cell.text)).toEqual(['1', '—']);
    // Escape: no editor any more, the saved film is back.
    expect(buildMirrorView(snapshot, { ...ui, editing: null }).table!.rows[0].cells.map((cell) => cell.text)).toEqual(['1', 'Белый софт']);
  });
});

describe('contact data of the client', () => {
  const phones = [
    { phone_number: '+7 (701) 111-22-33', is_primary: false },
    { phone_number: '87052223344', is_primary: true },
    { phone_number: '  ', is_primary: false },
    { phone_number: '7273334455', is_primary: false },
  ];

  it('formats phones as the order header does; the primary one first, the others together', () => {
    expect(clientScreenPhone('+7 (701) 111-22-33')).toBe('8 701 111 2233');
    expect(clientScreenPhone('7273334455')).toBe('8 727 333 4455');
    expect(clientScreenPhone('112')).toBe('112');
    expect(clientScreenClientContacts(phones)).toEqual({ phone: '8 705 222 3344', otherPhones: '8 701 111 2233, 8 727 333 4455' });
    expect(clientScreenClientContacts([{ phone_number: '87011112233' }])).toEqual({ phone: '8 701 111 2233', otherPhones: null });
    expect(clientScreenClientContacts([])).toEqual({ phone: null, otherPhones: null });
  });

  it('phones that are not loaded are not sent at all, not even as a dash', () => {
    expect(clientScreenClientContacts(undefined)).toEqual({ phone: undefined, otherPhones: undefined });
    const wire = (clientContacts: OrderEditSourceInput['clientContacts'], codes: readonly string[]) =>
      buildClientScreenSnapshot(buildOrderEditSource(input({ clientContacts })), codes, createClientScreenIdMap(() => 'idaaaaaa')).summary;
    expect(wire(clientScreenClientContacts(undefined), CLIENT_SCREEN_CODES).map((field) => field.code)).not.toContain('summary.client_phone');
    expect(wire(undefined, CLIENT_SCREEN_CODES).map((field) => field.code)).not.toContain('summary.client_phone');
    // Loaded and ticked: shown next to the client; a client without phones shows a dash.
    expect(wire(clientScreenClientContacts(phones), CLIENT_SCREEN_CODES).filter((field) => field.code.startsWith('summary.client'))).toEqual([
      { code: 'summary.client', label: 'Клиент', value: 'Садыков Арман' },
      { code: 'summary.client_phone', label: 'Телефон клиента', value: '8 705 222 3344' },
      { code: 'summary.client_phones', label: 'Доп. телефоны клиента', value: '8 701 111 2233, 8 727 333 4455' },
    ]);
    expect(wire(clientScreenClientContacts([]), CLIENT_SCREEN_CODES).find((field) => field.code === 'summary.client_phone')?.value).toBe('—');
  });

  it('an answer with phones of another client (the client was just changed) is not loaded data', () => {
    const ofA = [{ client_id: 5, phone_number: '87051111111', is_primary: true }];
    expect(clientScreenPhonesOf(5, ofA)).toBe(ofA);
    // The order now has client 6, the list on hand is still client 5's: nothing is sent.
    expect(clientScreenPhonesOf(6, ofA)).toBeUndefined();
    expect(clientScreenClientContacts(clientScreenPhonesOf(6, ofA))).toEqual({ phone: undefined, otherPhones: undefined });
    expect(clientScreenPhonesOf(6, [...ofA, { client_id: 6, phone_number: '87052222222', is_primary: true }])).toBeUndefined();
    // Client 6 really has no phones: an empty answer is loaded data.
    expect(clientScreenClientContacts(clientScreenPhonesOf(6, []))).toEqual({ phone: null, otherPhones: null });
    expect(clientScreenPhonesOf(null, ofA)).toBeUndefined();
    expect(clientScreenPhonesOf(5, undefined)).toBeUndefined();
    const wire = JSON.stringify(buildClientScreenSnapshot(
      buildOrderEditSource(input({ clientContacts: clientScreenClientContacts(clientScreenPhonesOf(6, ofA)) })), CLIENT_SCREEN_CODES, createClientScreenIdMap(() => 'idaaaaaa'),
    ));
    expect(wire).not.toContain('705 111');
  });

  it('phones are hidden until ticked: neither the default set nor a set without their codes sends them', () => {
    const contacts = clientScreenClientContacts(phones);
    const serialize = (codes: readonly string[]) =>
      JSON.stringify(buildClientScreenSnapshot(buildOrderEditSource(input({ clientContacts: contacts })), codes, createClientScreenIdMap(() => 'idaaaaaa')));
    expect(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES).not.toContain('summary.client_phone');
    expect(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES).not.toContain('summary.client_phones');
    for (const codes of [CLIENT_SCREEN_DEFAULT_VISIBLE_CODES, CLIENT_SCREEN_CODES.filter((code) => !code.startsWith('summary.client_phone'))]) {
      const wire = serialize(codes);
      for (const hidden of ['705 222', '701 111', '727 333']) expect(wire).not.toContain(hidden);
    }
    // Each phone code shows only its own value.
    const onlyPrimary = serialize(['summary.client_phone']);
    expect(onlyPrimary).toContain('8 705 222 3344');
    expect(onlyPrimary).not.toContain('701 111');
  });
});

describe('the order header for the customer', () => {
  it('has what the header of the manager has', () => {
    const summary = buildOrderEditSource(input()).summary;
    expect(summary).toMatchObject({
      number: '2418', order_name: 'Кухня — фасады', client: 'Садыков Арман', deadline: '16.10.2026', positions: '2', parts: '6',
      material: 'МДФ 16 мм', milling_type: 'Модерн', edge_type: 'R2',
      // The second detail has no film: one film in the order is still the common one, as in the manager's header.
      film: 'Белый софт',
    });
    expect(summary.discount).toMatch(/^5\s000,00 /);
    expect(summary.surcharge).toBeUndefined();
    expect(summary.paid).toMatch(/^40\s000,00 /);
    // Statuses, priority, basis project and designer are header lines as well — each with its own tick, off by default.
    for (const code of ['summary.order_status', 'summary.payment_status', 'summary.production_status', 'summary.priority', 'summary.project',
      'summary.basis_project', 'summary.designer', 'summary.created_by']) expect(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES).not.toContain(code);
  });

  it('different values across the details give a dash; no details — no material and no common parameters', () => {
    const base = input();
    const mixed = buildOrderEditSource(input({
      details: [base.details[0], { ...base.details[1], milling_type_id: 2, edge_type_id: 3, film_id: 9 }] as OrderEditSourceInput['details'],
      names: { ...base.names, millingType: (id) => ({ 1: 'Модерн', 2: 'Классика' } as Record<number, string>)[id as number],
        edgeType: (id) => ({ 2: 'R2', 3: 'R3' } as Record<number, string>)[id as number], film: (id) => ({ 8: 'Белый софт', 9: 'Дуб' } as Record<number, string>)[id as number] },
    })).summary;
    expect(mixed).toMatchObject({ milling_type: null, edge_type: null, film: null });
    const empty = buildOrderEditSource(input({ details: [] })).summary;
    expect(empty).toMatchObject({ positions: '0', material: null, milling_type: null, edge_type: null, film: null });
  });

  it('the header lines reach the customer only when ticked; the name is the title when the number is not shown', () => {
    const idFor = () => createClientScreenIdMap(() => 'idaaaaaa');
    const src = buildOrderEditSource(input());
    const none = buildClientScreenSnapshot(src, ['summary.client'], idFor());
    expect(none.title).toBe('Ваш заказ');
    expect(JSON.stringify(none)).not.toContain('Кухня');
    expect(JSON.stringify(none)).not.toContain('МДФ');
    const named = buildClientScreenSnapshot(src, ['summary.order_name', 'summary.material', 'summary.deadline'], idFor());
    expect(named.title).toBe('Заказ Кухня — фасады');
    expect(named.summary).toEqual([
      { code: 'summary.deadline', label: 'Срок выполнения', value: '16.10.2026' },
      { code: 'summary.material', label: 'Материал', value: 'МДФ 16 мм' },
    ]);
  });

  it('an order without details names its own material, as the header of the manager; hidden unless ticked', () => {
    const src = buildOrderEditSource(input({ details: [], header: { ...input().header, material_name: 'МДФ 19 мм (шапка)' } as OrderEditSourceInput['header'] }));
    expect(src.summary.material).toBe('МДФ 19 мм (шапка)');
    const idFor = () => createClientScreenIdMap(() => 'idaaaaaa');
    expect(JSON.stringify(buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES.filter((code) => code !== 'summary.material'), idFor()))).not.toContain('МДФ 19 мм');
    expect(buildClientScreenSnapshot(src, ['summary.material'], idFor()).summary).toEqual([{ code: 'summary.material', label: 'Материал', value: 'МДФ 19 мм (шапка)' }]);
    // Details that name a material win over the order's own.
    const withDetails = buildOrderEditSource(input({ header: { ...input().header, material_name: 'МДФ 19 мм (шапка)' } as OrderEditSourceInput['header'] }));
    expect(withDetails.summary.material).toBe('МДФ 16 мм');
  });

  it('a very long material line is cut visibly and the snapshot still passes the wire schema', () => {
    const base = input();
    const details = Array.from({ length: 45 }, (_, index) => ({ ...base.details[0], detail_id: 1000 + index, detail_number: index + 1, sheet_material_type_id: 500 + index }));
    const src = buildOrderEditSource(input({
      details: details as OrderEditSourceInput['details'],
      names: { ...base.names, sheetMaterial: (id) => `Материал с очень длинным названием для проверки границы ${id}` },
    }));
    expect((src.summary.material as string).length).toBeGreaterThan(2000);
    const snapshot = buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES, createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })()));
    const material = snapshot.summary.find((field) => field.code === 'summary.material')!.value;
    expect(material).toHaveLength(2000);
    expect(material.endsWith('…')).toBe(true);
    expect(clientScreenSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // Any other long text is bounded the same way (a note of a detail, a group title).
    const long = 'я'.repeat(5000);
    const noted = buildClientScreenSnapshot(
      buildOrderEditSource(input({ header: { ...base.header, notes: long }, details: [{ ...base.details[0], note: long }] as OrderEditSourceInput['details'] })),
      CLIENT_SCREEN_CODES, createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })()),
    );
    expect(clientScreenSnapshotSchema.safeParse(noted).success).toBe(true);
  });
});

describe('every element of the manager screen is available as a tick', () => {
  const idFor = () => createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })());
  const base = input();
  const rich = {
    ...base.details[0], hdf_parameter_override_mm: 3.2, doweling: true, priority: 80, basis_project: 'Проект-А', basis_product: 'Изделие-7',
    basis_data: 'ДАННЫЕ-Б', basis_designation: 'ОБОЗН-9', cut_job: { cutJobId: 12, name: 'Раскрой кухни', cutNumber: 'Р-12' },
    bath_cut_job: null, bazis_cut_sets: [{ bazisCutSetId: 5, name: 'x' }],
  } as unknown as OrderEditSourceInput['details'][number];

  it('the extra columns of the detail table: display text as the table shows it', () => {
    const src = buildOrderEditSource(input({
      details: [rich] as OrderEditSourceInput['details'],
      detailColumnOrder: ['detail_number', 'hdf_parameter_override_mm', 'doweling', 'cut_job', 'bath_cut_job', 'bazis_cut_sets', 'priority', 'basis_project',
        'basis_product', 'basis_data', 'basis_designation'],
    }));
    expect(src.details.rows[0].values).toMatchObject({
      hdf_parameter: '3,20 мм', doweling: 'Да', cut_job: 'Р-12: Раскрой кухни', bath_cut_job: null, bazis_cut_sets: 'БР-5', priority: '80',
      basis_project: 'Проект-А', basis_product: 'Изделие-7', basis_data: 'ДАННЫЕ-Б', basis_designation: 'ОБОЗН-9',
    });
    expect(src.details.columnOrder).toEqual(['n', 'hdf_parameter', 'doweling', 'cut_job', 'bath_cut_job', 'bazis_cut_sets', 'priority', 'basis_project',
      'basis_product', 'basis_data', 'basis_designation']);
  });

  it('cut jobs come from the table when it is on screen (it knows the last ready job), else from the detail', () => {
    const fromTable = buildOrderEditSource(input({
      details: [rich] as OrderEditSourceInput['details'],
      tableCellsOf: (rowKey) => (rowKey === '71' ? { cut_job: 'Р-15: Новый раскрой', bath_cut_job: 'В-3', hdf_parameter: '716×396,5' } : null),
    }));
    expect(fromTable.details.rows[0].values).toMatchObject({ cut_job: 'Р-15: Новый раскрой', bath_cut_job: 'В-3', hdf_parameter: '716×396,5' });
    // The table is the authority: a job that is no longer its last ready one is not shown, although the detail still carries it.
    const archived = buildOrderEditSource(input({
      details: [rich] as OrderEditSourceInput['details'],
      tableCellsOf: () => ({ cut_job: null, bath_cut_job: null, hdf_parameter: 'устар.' }),
    }));
    expect(archived.details.rows[0].values).toMatchObject({ cut_job: null, bath_cut_job: null, hdf_parameter: 'устар.' });
    const wire = JSON.stringify(buildClientScreenSnapshot(archived, CLIENT_SCREEN_CODES, idFor()));
    expect(wire).not.toContain('Раскрой кухни');
    expect(wire).not.toContain('Р-12');
  });

  it('none of the new values leaves without its own tick', () => {
    const src = buildOrderEditSource(input({
      details: [rich] as OrderEditSourceInput['details'],
      detailColumnOrder: Object.keys(DETAIL_COLUMN_FIELDS),
      dowelingLinks: [{ order_id: 1, doweling_order_id: 2, doweling_order: { doweling_order_id: 2, doweling_order_name: 'П-17', design_engineer_id: 9 } }] as never,
    }));
    const old = CLIENT_SCREEN_CODES.filter((code) => !/^(details\.(hdf_parameter|doweling|cut_job|bath_cut_job|bazis_cut_sets|priority|basis_)|summary\.(designer|basis_project|project|order_status|payment_status|production_status|priority|created_by))/.test(code));
    const wire = JSON.stringify(buildClientScreenSnapshot(src, old, idFor()));
    for (const hidden of ['3,20', 'Р-12', 'Раскрой кухни', 'БР-5', 'Проект-А', 'Изделие-7', 'ДАННЫЕ-Б', 'ОБОЗН-9']) expect(wire, hidden).not.toContain(hidden);
    const all = buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES, idFor());
    for (const shown of ['3,20 мм', 'Р-12: Раскрой кухни', 'БР-5', 'Проект-А', 'Изделие-7', 'ДАННЫЕ-Б', 'ОБОЗН-9']) expect(JSON.stringify(all), shown).toContain(shown);
    expect(clientScreenSnapshotSchema.safeParse(all).success).toBe(true);
    // Each new header line alone shows only itself.
    const only = (code: string) => buildClientScreenSnapshot(src, [code], idFor()).summary;
    expect(only('summary.order_status')).toEqual([{ code: 'summary.order_status', label: 'Статус заказа', value: 'В работе' }]);
    expect(only('summary.priority')).toEqual([{ code: 'summary.priority', label: 'Приоритет', value: '100' }]);
    expect(only('summary.basis_project')).toEqual([{ code: 'summary.basis_project', label: 'Базис-проект', value: 'Проект-А' }]);
  });

  it('the designer and the basis project follow the rule of the manager header', () => {
    const employee = (id: number) => ({ 9: 'Алия К.', 4: 'Тимур С.' } as Record<number, string>)[id];
    const link = (name: string, designer: number | null) => ({ doweling_order: { doweling_order_name: name, design_engineer_id: designer } });
    // Basis projects of the details: they are named, and no designer line.
    expect(clientScreenHeaderPeople({ details: [{ basis_project: 'Проект-А' }, { basis_project: 'Проект-Б' }, { basis_project: 'Проект-А' }],
      dowelingLinks: [link('П-17', 9)], header: { design_engineer_id: 4 }, employeeName: employee }))
      .toEqual({ basis_project: 'Проект-А, Проект-Б', designer: null });
    // No basis project: the latest doweling order gives the name and the designer.
    expect(clientScreenHeaderPeople({ details: [{}], dowelingLinks: [link('П-16', 4), link('П-17', 9)], header: { design_engineer_id: 4 }, employeeName: employee }))
      .toEqual({ basis_project: 'П-17', designer: 'Алия К.' });
    // A doweling order without a designer: no designer, even if the order has its own.
    expect(clientScreenHeaderPeople({ details: [], dowelingLinks: [link('П-17', null)], header: { design_engineer_id: 4 }, employeeName: employee }).designer).toBeNull();
    // No doweling order at all: the order's own designer.
    expect(clientScreenHeaderPeople({ details: [], dowelingLinks: [], header: { design_engineer_id: 4, doweling_order_name: 'П-9' }, employeeName: employee }))
      .toEqual({ basis_project: 'П-9', designer: 'Тимур С.' });
    // An employee the form has no name for is never shown as an id.
    expect(clientScreenHeaderPeople({ details: [], dowelingLinks: [], header: { design_engineer_id: 777 }, employeeName: employee }).designer).toBeNull();
  });

  it('the edit form header has no project and no «создал заказ» line: nothing is sent for them', () => {
    const summary = buildOrderEditSource(input()).summary;
    expect(summary.project).toBeUndefined();
    expect(summary.created_by).toBeUndefined();
    expect(summary).toMatchObject({ order_status: 'В работе', payment_status: 'Частично оплачен', production_status: 'Фрезеровка', priority: '100' });
  });

  it('before the detail table has been on screen only the plain columns go: nothing the table may gate by a right or a setting', () => {
    const restricted = ['hdf_parameter', 'doweling', 'cut_job', 'bath_cut_job', 'bazis_cut_sets', 'priority', 'basis_project', 'basis_product', 'basis_data',
      'basis_designation'];
    for (const key of DEFAULT_DETAIL_COLUMNS) {
      expect(DETAIL_COLUMN_FIELDS[key], key).toBeDefined();
      expect(restricted).not.toContain(DETAIL_COLUMN_FIELDS[key]);
    }
    // Presented from the first tab, the table never mounted: every code ticked, and still no cut job, HDF or basis data.
    const src = buildOrderEditSource(input({ details: [rich] as OrderEditSourceInput['details'], detailColumnOrder: DEFAULT_DETAIL_COLUMNS, tableCellsOf: null }));
    const snapshot = buildClientScreenSnapshot(src, CLIENT_SCREEN_CODES, idFor());
    const codes = snapshot.details!.columns.map((column) => column.code);
    for (const field of restricted) expect(codes).not.toContain(`details.${field}`);
    const wire = JSON.stringify(snapshot.details);
    for (const hidden of ['Р-12', 'Раскрой кухни', 'БР-5', 'Изделие-7', 'ДАННЫЕ-Б', 'ОБОЗН-9', '3,20']) expect(wire, hidden).not.toContain(hidden);
  });

  it('the editor overlay leaves table-owned cells alone; the HDF cell is the editor\'s only while its own editor is open', () => {
    const columns = ['detail_number', 'height', 'hdf_parameter_override_mm', 'cut_job', 'bath_cut_job'];
    const codesOf = (active: string | null) => orderEditEditingValues(rich, { height: 720, hdf_parameter_override_mm: 4 }, base.names, columns, active);
    expect(codesOf('height').map((item) => item.code)).toEqual(['details.n', 'details.height']);
    expect(codesOf(null).map((item) => item.code)).toEqual(['details.n', 'details.height']);
    expect(codesOf('hdf_parameter_override_mm')).toEqual([
      { code: 'details.n', value: '1' }, { code: 'details.height', value: '720' }, { code: 'details.hdf_parameter', value: '4 мм' },
    ]);
  });

  it('the designer of an order without a doweling order: the name the record has, else by id', () => {
    const employee = (id: number) => ({ 4: 'Тимур С.' } as Record<number, string>)[id];
    expect(clientScreenHeaderPeople({ details: [], dowelingLinks: [], header: { design_engineer: 'Алия К. (из записи)', design_engineer_id: 4 }, employeeName: () => undefined }).designer)
      .toBe('Алия К. (из записи)');
    expect(clientScreenHeaderPeople({ details: [], dowelingLinks: [], header: { design_engineer: '', design_engineer_id: 4 }, employeeName: employee }).designer).toBe('Тимур С.');
    // With a doweling order the record's own name is not used, as in the manager's header.
    expect(clientScreenHeaderPeople({ details: [], dowelingLinks: [{ doweling_order: { doweling_order_name: 'П-1', design_engineer_id: null } }],
      header: { design_engineer: 'Алия К. (из записи)' }, employeeName: employee }).designer).toBeNull();
  });

  it('a cut grouping never names a job the manager\'s table does not show: no column — no titles; a job that is gone — no name', () => {
    const second = { ...rich, detail_id: 72, detail_number: 2, cut_job: { cutJobId: 13, name: 'Раскрой шкафа', cutNumber: 'Р-13' } } as OrderEditSourceInput['details'][number];
    const grouping = { field: 'cut_job', groups: [
      { key: '0', label: 'Р-12: Раскрой кухни', rowKeys: [71] }, { key: '1', label: 'Р-13: Раскрой шкафа', rowKeys: [72] },
    ] };
    const details = [rich, second] as OrderEditSourceInput['details'];
    // The manager has no cut column (no right to see cut jobs, or the column is switched off): everything is ticked, nothing of the jobs goes.
    const noColumn = buildClientScreenSnapshot(
      buildOrderEditSource(input({ details, grouping, detailColumnOrder: ['detail_number', 'height'], tableCellsOf: () => ({ cut_job: null, bath_cut_job: null, hdf_parameter: null }) })),
      CLIENT_SCREEN_CODES, idFor(),
    );
    expect(noColumn.details!.groups).toBeUndefined();
    for (const hidden of ['Р-12', 'Р-13', 'Раскрой кухни', 'Раскрой шкафа']) expect(JSON.stringify(noColumn), hidden).not.toContain(hidden);
    // The column is on screen and the first job is archived (gone from the table's list): its group has no name any more.
    const archived = buildClientScreenSnapshot(
      buildOrderEditSource(input({
        details, grouping, detailColumnOrder: ['detail_number', 'cut_job'],
        tableCellsOf: (rowKey) => ({ cut_job: rowKey === '72' ? 'Р-13: Раскрой шкафа' : null, bath_cut_job: null, hdf_parameter: null }),
      })),
      CLIENT_SCREEN_CODES, idFor(),
    );
    expect(archived.details!.groups!.map((group) => group.title)).toEqual(['—', 'Р-13: Раскрой шкафа']);
    expect(JSON.stringify(archived)).not.toContain('Раскрой кухни');
    expect(JSON.stringify(archived)).not.toContain('Р-12');
    // Bath jobs take the same path.
    const bath = buildClientScreenSnapshot(
      buildOrderEditSource(input({
        details, grouping: { field: 'bath_cut_job', groups: [{ key: '0', label: 'В-7: Старая ванна', rowKeys: [71, 72] }] },
        detailColumnOrder: ['detail_number', 'bath_cut_job'], tableCellsOf: () => ({ cut_job: null, bath_cut_job: null, hdf_parameter: null }),
      })),
      CLIENT_SCREEN_CODES, idFor(),
    );
    expect(JSON.stringify(bath)).not.toContain('Старая ванна');
  });

  it('any grouping names its groups only when that column is on the customer table', () => {
    const grouping = { field: 'film', groups: [{ key: '0', label: 'Белый софт', rowKeys: [71] }] };
    const hiddenColumn = buildClientScreenSnapshot(
      buildOrderEditSource(input({ grouping, detailColumnOrder: ['detail_number', 'height'] })), CLIENT_SCREEN_CODES, idFor(),
    );
    expect(hiddenColumn.details!.groups).toBeUndefined();
    const shownColumn = buildClientScreenSnapshot(
      buildOrderEditSource(input({ grouping, detailColumnOrder: ['detail_number', 'film_id'] })), CLIENT_SCREEN_CODES, idFor(),
    );
    expect(shownColumn.details!.groups!.map((group) => group.title)).toEqual(['Белый софт']);
  });
});

describe('the HDF tab of the edit form', () => {
  const idFor = () => createClientScreenIdMap((() => { let n = 0; return () => `id${String(++n).padStart(6, '0')}`; })());
  const hdfDetails = [
    { order_hdf_detail_id: 501, source_order_detail_id_snapshot: 71, source_detail_number: 1, source_detail_name: 'Фасад верхний', source_height_mm: 716,
      source_width_mm: 396.5, source_quantity: 4, milling_type_id: 1, milling_type_name: 'Модерн', edge_mm: 3, hdf_height_mm: 709, hdf_width_mm: 389.5,
      quantity: 4, area_m2: 1.1046, status: 'ok', is_stale: false, production_status_id: 4, production_status_name: null, version: 1,
      cut_job: { cutJobId: 12, name: 'Раскрой ХДФ', cutNumber: 'Р-12' }, bazis_cut_sets: [{ bazisCutSetId: 5, name: 'x' }, { bazisCutSetId: 6, name: 'y' }] },
    { order_hdf_detail_id: 502, source_order_detail_id_snapshot: 72, source_detail_number: 2, source_detail_name: null, source_height_mm: 100, source_width_mm: 2400,
      source_quantity: 2, milling_type_id: 77, milling_type_name: null, edge_mm: null, hdf_height_mm: null, hdf_width_mm: null, quantity: null, area_m2: 0,
      status: 'config_missing', config_errors: ['unknown_code'], is_stale: true, version: 1 },
  ] as unknown as NonNullable<OrderEditSourceInput['hdfDetails']>;
  const src = () => buildOrderEditSource(input({ hdfDetails, header: { ...input().header, hdf_min_threshold_mm: 60 } as OrderEditSourceInput['header'] }));

  it('fields and rows as the tab shows them: names instead of ids, the state with its notes, totals of valid rows only', () => {
    const hdf = src().hdf!;
    expect(hdf.fields).toEqual({ min_threshold: '60,0', total: '1,10 м², деталей: 4' });
    expect(hdf.rows[0]).toEqual({ key: '501', values: {
      position: '1 · Фасад верхний', milling_type: 'Модерн', source_height: '716,0', source_width: '396,5', source_quantity: '4', parameter: '3,00',
      height: '709,0', width: '389,5', quantity: '4', area: '1,10', status: 'Рассчитано', production_status: 'Фрезеровка', cut_job: 'Р-12',
      bazis_cut_sets: 'БР-5, БР-6',
    } });
    // No milling name: empty, never «ID: 77». A stale failed row: its state says so and it is not in the total.
    expect(hdf.rows[1].values).toMatchObject({ position: '2', milling_type: null, parameter: null, height: null, quantity: null, area: '0,00', cut_job: null,
      bazis_cut_sets: null, production_status: null });
    expect(hdf.rows[1].values.status).toMatch(/^Нет настройки · устарело/);
    expect(JSON.stringify(hdf)).not.toContain('77');
  });

  it('a parameter changed in the detail but not yet recalculated is shown as the tab shows it', () => {
    const base = input();
    const changed = buildOrderEditSource(input({
      hdfDetails, details: [{ ...base.details[0], hdf_parameter_override_mm: 4.5 }, base.details[1]] as OrderEditSourceInput['details'],
    }));
    expect(changed.hdf!.rows[0].values.parameter).toBe('4,50 (изменено)');
  });

  it('the tab reaches the customer only when ticked, column by column; the row keys never do', () => {
    const off = buildClientScreenSnapshot(src(), CLIENT_SCREEN_CODES.filter((code) => code !== 'tab.hdf'), idFor());
    expect(off.hdf).toBeUndefined();
    expect(off.tabs.map((tab) => tab.key)).not.toContain('hdf');
    for (const hidden of ['709,0', 'Раскрой ХДФ', 'БР-6', 'Рассчитано', '1,10 м², деталей']) expect(JSON.stringify(off), hidden).not.toContain(hidden);
    const some = buildClientScreenSnapshot(src(), ['tab.hdf', 'hdf.position', 'hdf.height', 'hdf.width', 'hdf.quantity'], idFor());
    expect(some.hdf!.fields).toEqual([]);
    expect(some.hdf!.table!.columns.map((column) => column.label)).toEqual(['Позиция', 'ХДФ выс.', 'ХДФ шир.', 'ХДФ кол.']);
    expect(some.hdf!.table!.rows[0].cells).toEqual(['1 · Фасад верхний', '709,0', '389,5', '4']);
    expect(some.hdf!.table!.rows[1].cells).toEqual(['2', '—', '—', '—']);
    const wire = JSON.stringify(some);
    for (const hidden of ['501', '502', 'Р-12', 'БР-5', 'Рассчитано', 'Модерн', '716']) expect(wire, hidden).not.toContain(hidden);
    expect(clientScreenSnapshotSchema.safeParse(buildClientScreenSnapshot(src(), CLIENT_SCREEN_CODES, idFor())).success).toBe(true);
    // The HDF codes are off by default.
    expect(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES.some((code) => code === 'tab.hdf' || code.startsWith('hdf.'))).toBe(false);
  });

  it('an order without HDF: the tab is there with its total and an empty table', () => {
    const empty = buildClientScreenSnapshot(buildOrderEditSource(input()), CLIENT_SCREEN_CODES, idFor());
    expect(empty.hdf!.fields.find((field) => field.code === 'hdf.total')?.value).toBe('0,00 м², деталей: 0');
    expect(empty.hdf!.table!.rows).toEqual([]);
  });
});

