import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BAZIS_COLUMN_LABELS,
  BAZIS_FIELD_CATALOG,
  buildRuntimeLabelFieldCatalog,
  COMPUTED_DETAIL_FIELD_CATALOG,
  DETAIL_FIELD_CATALOG,
  DYNAMIC_LABEL_FIELDS,
  ORDER_FIELD_CATALOG,
  isSupportedFieldBinding,
  LABEL_FIELD_CATALOG,
} from './bazis-field-catalog';

describe('Bazis label field catalog', () => {
  it('keeps the observed 121-column .xbir catalog snapshot', () => {
    expect(BAZIS_COLUMN_LABELS).toHaveLength(121);
    expect(BAZIS_COLUMN_LABELS).toMatchSnapshot();
  });

  it('keeps stable semantic ids for primary mapped fields', () => {
    expect(BAZIS_FIELD_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'bazis.order_number', sourceColumn: 'Номер заказа' }),
        expect.objectContaining({ id: 'bazis.position', sourceColumn: 'Позиция' }),
        expect.objectContaining({ id: 'bazis.material', sourceColumn: 'Материал' }),
        expect.objectContaining({ id: 'bazis.edge_l1_name', sourceColumn: 'Кромка L1 наим.' }),
      ]),
    );
  });

  it('includes dynamic label fields used by renderer and validators', () => {
    expect(DYNAMIC_LABEL_FIELDS.map((field) => field.id)).toEqual([
      'date.today',
      'label.counter',
      'label.counter_total',
      'label.counter_text',
    ]);
  });

  it('includes generic order and detail view fields for template mappings', () => {
    expect(DETAIL_FIELD_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'detail.detail_name', source: 'detail', sourceColumn: 'detail_name' }),
        expect.objectContaining({ id: 'detail.material_name', source: 'detail', sourceColumn: 'material_name' }),
      ]),
    );
    expect(ORDER_FIELD_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'order.order_name', source: 'order', sourceColumn: 'order_name' }),
        expect.objectContaining({ id: 'order.client_name', source: 'order', sourceColumn: 'client_name' }),
      ]),
    );
  });

  it('adds computed detail cut job number fields to static and runtime catalogs', () => {
    expect(COMPUTED_DETAIL_FIELD_CATALOG).toEqual([
      expect.objectContaining({
        id: 'detail.cut_result_version_no',
        source: 'dynamic',
        sourceColumn: null,
        label: '№ задания раскроя (обычные профили)',
        type: 'string',
        category: 'Деталь',
      }),
      expect.objectContaining({
        id: 'detail.bath_cut_result_version_no',
        source: 'dynamic',
        sourceColumn: null,
        label: '№ задания раскроя (вакуумный стол)',
        type: 'string',
        category: 'Деталь',
      }),
    ]);

    const catalog = buildRuntimeLabelFieldCatalog([
      { columnName: 'future_detail_code', dataType: 'text' },
      { columnName: 'cut_result_version_no', dataType: 'integer' },
    ]);
    const ids = catalog.map((field) => field.id);
    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'detail.future_detail_code', label: 'Future detail code' }),
      expect.objectContaining({ id: 'detail.cut_result_version_no', type: 'string' }),
      expect.objectContaining({ id: 'detail.bath_cut_result_version_no', type: 'string' }),
    ]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(isSupportedFieldBinding('detail.cut_result_version_no')).toBe(true);
    expect(isSupportedFieldBinding('detail.bath_cut_result_version_no')).toBe(true);
  });

  it('builds detail fields from the live view schema without a hardcoded column entry', () => {
    const catalog = buildRuntimeLabelFieldCatalog([
      { columnName: 'detail_id', dataType: 'bigint' },
      { columnName: 'future_machine_code', dataType: 'text' },
      { columnName: 'future_metric', dataType: 'numeric' },
    ]);

    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'detail.detail_id', label: 'ID детали', type: 'number' }),
      expect.objectContaining({ id: 'detail.future_machine_code', label: 'Future machine code', type: 'string' }),
      expect.objectContaining({ id: 'detail.future_metric', label: 'Future metric', type: 'number' }),
    ]));
    expect(catalog.some((field) => field.id === 'detail.width')).toBe(false);
  });

  it('distinguishes reference ids from their display names', () => {
    const catalog = buildRuntimeLabelFieldCatalog([
      { columnName: 'milling_type_id', dataType: 'smallint' },
      { columnName: 'milling_type_name', dataType: 'text' },
      { columnName: 'film_id', dataType: 'bigint' },
      { columnName: 'film_name', dataType: 'text' },
    ]);
    const byId = new Map(catalog.map((field) => [field.id, field]));

    expect(byId.get('detail.milling_type_id')).toMatchObject({
      label: 'ID фрезеровки',
      type: 'number',
      sourceColumn: 'milling_type_id',
    });
    expect(byId.get('detail.milling_type_name')).toMatchObject({
      label: 'Фрезеровка',
      type: 'string',
      sourceColumn: 'milling_type_name',
    });
    expect(byId.get('detail.film_id')).toMatchObject({
      label: 'ID пленки',
      type: 'number',
      sourceColumn: 'film_id',
    });
    expect(byId.get('detail.film_name')).toMatchObject({
      label: 'Пленка',
      type: 'string',
      sourceColumn: 'film_name',
    });
  });

  it('uses order-card labels for separate Basis detail and product designations', () => {
    const orderDetailTableSource = readFileSync(
      new URL('../../../../../src/pages/orders/components/tables/OrderDetailTable.tsx', import.meta.url),
      'utf8',
    );
    const definitionsBlock = orderDetailTableSource.match(
      /const ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS[^=]*= \[([\s\S]*?)\n\];/,
    )?.[1] ?? '';
    expect(definitionsBlock).toMatch(/key: 'actions'.*lockPosition: 'end'/);
    const cardFields = [...definitionsBlock.matchAll(/\{ key: '([^']+)', label: '([^']+)'/g)]
      .map((match) => ({ key: match[1], label: match[2] }))
      .filter(({ key }) => key !== 'actions');
    const catalog = buildRuntimeLabelFieldCatalog([
      ...cardFields.map(({ key }) => ({ columnName: key, dataType: 'text' })),
      { columnName: 'basis_product', dataType: 'text' },
      { columnName: 'milling_type_name', dataType: 'text' },
      { columnName: 'film_name', dataType: 'text' },
    ]);
    const detailFields = new Map(
      catalog.filter((field) => field.source === 'detail').map((field) => [field.sourceColumn, field.label]),
    );

    expect(cardFields.length).toBeGreaterThan(0);
    for (const { key, label } of cardFields) {
      const expectedLabel = key === 'milling_type_id'
        ? 'ID фрезеровки'
        : key === 'film_id'
          ? 'ID пленки'
          : label;
      expect(detailFields.get(key), key).toBe(expectedLabel);
    }
    expect(detailFields.get('milling_type_name')).toBe('Фрезеровка');
    expect(detailFields.get('film_name')).toBe('Пленка');
    expect(detailFields.get('basis_designation')).toBe('Базис обозн. детали');
    expect(detailFields.get('basis_product')).toBe('Базис обозн. изделия');
  });

  it('uses one catalog source for field binding validation', () => {
    const ids = LABEL_FIELD_CATALOG.map((field) => field.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      expect(isSupportedFieldBinding(id)).toBe(true);
    }

    expect(isSupportedFieldBinding('custom.operator_note', { 'custom.operator_note': { type: 'string' } })).toBe(true);
    expect(isSupportedFieldBinding('custom bad key', { 'custom bad key': { type: 'string' } })).toBe(false);
    expect(isSupportedFieldBinding('bazis.missing')).toBe(false);
  });
});
