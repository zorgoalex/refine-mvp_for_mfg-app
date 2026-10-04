import { describe, expect, it } from 'vitest';
import { buildClientScreenSnapshot, createClientScreenIdMap } from './buildClientScreenSnapshot';
import { CLIENT_SCREEN_CODES } from './clientScreenRegistry';
import { clientScreenSnapshotSchema } from './clientScreenSnapshotSchema';
import { buildOrderEditSource, DETAIL_COLUMN_FIELDS, GROUPING_FIELDS, type OrderEditSourceInput } from './orderEditSnapshotSource';

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
