import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BAZIS_COLUMN_LABELS,
  BAZIS_FIELD_CATALOG,
  buildRuntimeLabelFieldCatalog,
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

  it('uses order-card labels and hides internal detail columns', () => {
    const orderDetailTableSource = readFileSync(
      new URL('../../../../../src/pages/orders/components/tables/OrderDetailTable.tsx', import.meta.url),
      'utf8',
    );
    const definitionsBlock = orderDetailTableSource.match(
      /const ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS[^=]*= \[([\s\S]*?)\n\];/,
    )?.[1] ?? '';
    const cardFields = [...definitionsBlock.matchAll(/\{ key: '([^']+)', label: '([^']+)'/g)]
      .map((match) => ({ key: match[1], label: match[2] }))
      .filter(({ key }) => key !== 'actions');
    const catalog = buildRuntimeLabelFieldCatalog([
      ...cardFields.map(({ key }) => ({ columnName: key, dataType: 'text' })),
      { columnName: 'basis_product', dataType: 'text' },
    ]);
    const detailFields = new Map(
      catalog.filter((field) => field.source === 'detail').map((field) => [field.sourceColumn, field.label]),
    );

    expect(cardFields.length).toBeGreaterThan(0);
    for (const { key, label } of cardFields) {
      expect(detailFields.get(key), key).toBe(label);
    }
    expect(catalog.some((field) => field.id === 'detail.basis_product')).toBe(false);
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
