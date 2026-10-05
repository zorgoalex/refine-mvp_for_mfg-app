import { describe, expect, it } from 'vitest';
import { buildClientScreenSnapshot, createClientScreenIdMap, filterClientScreenUi } from './buildClientScreenSnapshot';
import { buildMirrorView } from './mirrorView';
import { CLIENT_SCREEN_CODES, CLIENT_SCREEN_DEFAULT_VISIBLE_CODES } from './clientScreenRegistry';
import { clientScreenSnapshotSchema } from './clientScreenSnapshotSchema';
import {
  buildOrderEditSource, clientScreenClientContacts, clientScreenPhone, clientScreenPhonesOf, DETAIL_COLUMN_FIELDS, GROUPING_FIELDS, orderEditEditingValues,
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
    const source = buildOrderEditSource(input({ grouping: { field: 'hdf_parameter', groups: [{ key: '__sep__:hdf:8:0', label: 'ХДФ 8', rowKeys: [71] }] } }));
    expect(source.tabs.map((tab) => tab.key)).toEqual(['basic', 'details', 'dates', 'finance', 'services']);
    expect(source.tabs[1].label).toBe('Детали заказа');
    expect(source.details.columnOrder).toEqual(['n', 'height', 'width', 'quantity', 'area', 'milling_type', 'edge_type', 'material', 'note', 'price_per_sqm', 'cost', 'film', 'production_status', 'name']);
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
      const others = CLIENT_SCREEN_CODES.filter((item) => item !== code);
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
    expect(bareSnapshot.summary.map((field) => field.code)).toEqual(['summary.client', 'summary.parts', 'summary.area']);
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
    expect(wire(clientScreenClientContacts(phones), CLIENT_SCREEN_CODES).slice(0, 3)).toEqual([
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

