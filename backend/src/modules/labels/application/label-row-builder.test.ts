import { describe, expect, it } from 'vitest';
import { buildLabelRows, hashLabelRows } from './label-row-builder';
import type { OrderLabelDataDetailDto } from './labels.types';

describe('label row builder', () => {
  it('expands quantity into physical label rows and dynamic counters', () => {
    const rows = buildLabelRows({
      orderName: '8602',
      today: '2026-06-24',
      template: { customFieldSchema: {} },
      details: [detail({ quantity: 3 })],
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.copyIndex)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.values['label.counter_text'])).toEqual([
      'Бир. № 1 / 3',
      'Бир. № 2 / 3',
      'Бир. № 3 / 3',
    ]);
  });

  it('maps ERP and Basis fields with manual Bazis overrides winning', () => {
    const [row] = buildLabelRows({
      orderName: '548',
      today: '2026-06-24',
      template: { customFieldSchema: {} },
      details: [
        detail({
          basisProject: 'Project A',
          basisData: '7/D-01/Фасад/левая створка',
          detailName: 'ERP name',
          bazisFields: { 'bazis.comment': 'manual comment' },
          customFields: { 'custom.operator_note': 'ok' },
        }),
      ],
    });

    expect(row.values).toMatchObject({
      'bazis.order_number': 'Project A',
      'bazis.position': '7',
      'bazis.designation': 'D-01',
      'bazis.name': 'ERP name',
      'bazis.project': 'Project A',
      'bazis.comment': 'manual comment',
      'custom.operator_note': 'ok',
    });
    expect(hashLabelRows([row])).toMatch(/^[a-f0-9]{64}$/);
  });

  it('extracts Bazis designation and name from the frozen slash basis_data sample', () => {
    const [row] = buildLabelRows({
      orderName: '548',
      today: '2026-06-24',
      template: { customFieldSchema: {} },
      details: [
        detail({
          basisProject: 'Project A',
          detailName: null,
          basisData: '7/D-01/Фасад/левая створка',
        }),
      ],
    });

    expect(row.values).toMatchObject({
      'bazis.position': '7',
      'bazis.designation': 'D-01',
      'bazis.name': 'Фасад/левая створка',
    });
  });

  it('can ignore Basis project/data columns and use ordinary order detail fields', () => {
    const [row] = buildLabelRows({
      orderName: 'ERP-548',
      today: '2026-06-24',
      template: { customFieldSchema: {} },
      useBasisFields: false,
      details: [
        detail({
          detailNumber: 'ERP-7',
          detailName: 'ERP фасад',
          basisProject: 'BASIS-548',
          basisData: '9 B-01 - Basis фасад',
          customFields: { 'custom.operator_note': 'ok' },
        }),
      ],
    });

    expect(row.values).toMatchObject({
      'bazis.order_number': 'ERP-548',
      'bazis.position': 'ERP-7',
      'bazis.designation': '',
      'bazis.name': 'ERP фасад',
      'bazis.project': '',
      'custom.operator_note': 'ok',
    });
  });

  it('exposes generic detail and order fields for template bindings', () => {
    const [row] = buildLabelRows({
      orderName: 'ERP-548',
      orderFields: { order_name: 'ERP-548', client_name: 'Client A', final_amount: 12345 },
      today: '2026-06-24',
      template: { customFieldSchema: {} },
      details: [
        detail({
          detailFields: { detail_name: 'ERP фасад', priority: 8, material_name: 'ЛДСП' },
        }),
      ],
    });

    expect(row.values).toMatchObject({
      'detail.detail_name': 'ERP фасад',
      'detail.priority': 8,
      'detail.material_name': 'ЛДСП',
      'order.order_name': 'ERP-548',
      'order.client_name': 'Client A',
      'order.final_amount': 12345,
    });
  });

  it('uses per-detail order fields when one label batch contains details from multiple orders', () => {
    const rows = buildLabelRows({
      orderName: null,
      today: '2026-06-24',
      template: { customFieldSchema: {} },
      details: [
        detail({
          detailId: 101,
          orderId: 42,
          detailNumber: '1',
          orderFields: { order_id: 42, order_name: 'ORDER-42', client_name: 'Client A' },
        }),
        detail({
          detailId: 202,
          orderId: 77,
          detailNumber: '2',
          orderFields: { order_id: 77, order_name: 'ORDER-77', client_name: 'Client B' },
        }),
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.orderId)).toEqual([42, 77]);
    expect(rows.map((row) => row.values['order.order_name'])).toEqual(['ORDER-42', 'ORDER-77']);
    expect(rows.map((row) => row.values['order.client_name'])).toEqual(['Client A', 'Client B']);
  });

  it('maps custom fields from detail/order source fields unless manually overridden', () => {
    const [row] = buildLabelRows({
      orderName: 'ERP-548',
      orderFields: { client_name: 'Client A' },
      today: '2026-06-24',
      template: {
        customFieldSchema: {
          'custom.client': { type: 'string', sourceField: 'order.client_name' },
          'custom.detail_priority': { type: 'number', sourceField: 'detail.priority' },
        },
      },
      details: [
        detail({
          detailFields: { priority: 8 },
          customFields: { 'custom.client': 'Manual client' },
        }),
      ],
    });

    expect(row.values['custom.client']).toBe('Manual client');
    expect(row.values['custom.detail_priority']).toBe(8);
  });

  it('uses a custom field constant as the label value unless detail data overrides it', () => {
    const rows = buildLabelRows({
      orderName: 'ERP-548',
      orderFields: {},
      today: '2026-06-24',
      template: {
        customFieldSchema: {
          'custom.caption': {
            type: 'string',
            label: 'Подпись',
            defaultValue: 'Собрано вручную',
          },
        },
      },
      details: [
        detail(),
        detail({
          detailId: 102,
          customFields: { 'custom.caption': 'Проверено мастером' },
        }),
      ],
    });

    expect(rows.map((row) => row.values['custom.caption'])).toEqual([
      'Собрано вручную',
      'Проверено мастером',
    ]);
  });

  it('evaluates concat and nested if/else independently of custom schema key order', () => {
    const [row] = buildLabelRows({
      orderName: 'ERP-548',
      orderFields: { client_name: 'Client A' },
      today: '2026-07-21',
      template: {
        customFieldSchema: {
          'custom.result': expressionSchema({
            type: 'concat',
            parts: [
              { type: 'field', field: 'custom.material' },
              { type: 'text', value: ' / ' },
              {
                type: 'if_else',
                when: { field: 'order.client_name', op: 'not_empty' },
                then: { type: 'field', field: 'order.client_name' },
                else: { type: 'empty' },
              },
            ],
          }),
          'custom.material': expressionSchema({ type: 'field', field: 'bazis.material' }),
        },
      },
      details: [detail({ materialName: 'МДФ 16' })],
    });

    expect(row.values['custom.result']).toBe('МДФ 16 / Client A');
  });

  it('evaluates aggregate custom fields over all details in the label order batch', () => {
    const rows = buildLabelRows({
      orderName: 'ERP-548',
      orderFields: {},
      today: '2026-07-21',
      template: {
        customFieldSchema: {
          'custom.edge_types': expressionSchema({
            type: 'aggregate',
            source: 'order.details',
            field: 'detail.edge_type_name',
            fn: 'unique_join',
            separator: ', ',
          }),
        },
      },
      details: [
        detail({ detailId: 101, detailFields: { edge_type_name: 'ПВХ 2мм' } }),
        detail({ detailId: 102, detailFields: { edge_type_name: 'ABS 1мм' } }),
        detail({ detailId: 103, detailFields: { edge_type_name: 'ПВХ 2мм' } }),
      ],
    });

    expect(rows.map((row) => row.values['custom.edge_types'])).toEqual([
      'ПВХ 2мм, ABS 1мм',
      'ПВХ 2мм, ABS 1мм',
      'ПВХ 2мм, ABS 1мм',
    ]);
  });

  it('uses manual custom overrides, including null, inside dependent formulas', () => {
    const [row] = buildLabelRows({
      orderName: 'ERP-548',
      orderFields: {},
      template: {
        customFieldSchema: {
          'custom.base': expressionSchema({ type: 'text', value: 'automatic' }),
          'custom.dependent': expressionSchema({
            type: 'concat',
            parts: [
              { type: 'text', value: 'Value=' },
              { type: 'field', field: 'custom.base' },
            ],
          }),
        },
      },
      details: [detail({ customFields: { 'custom.base': null } })],
    });

    expect(row.values['custom.base']).toBeNull();
    expect(row.values['custom.dependent']).toBe('Value=');
  });

  it('makes date and label counters available before custom formulas run', () => {
    const rows = buildLabelRows({
      orderName: 'ERP-548',
      orderFields: {},
      today: '2026-07-21',
      template: {
        customFieldSchema: {
          'custom.dynamic': expressionSchema({
            type: 'concat',
            parts: [
              { type: 'field', field: 'date.today' },
              { type: 'text', value: ' · ' },
              { type: 'field', field: 'label.counter_text' },
            ],
          }),
        },
      },
      details: [detail({ quantity: 2 })],
    });

    expect(rows.map((row) => row.values['custom.dynamic'])).toEqual([
      '2026-07-21 · Бир. № 1 / 2',
      '2026-07-21 · Бир. № 2 / 2',
    ]);
  });
});

function expressionSchema(root: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'string',
    expression: { type: 'custom_expression', version: 1, root },
  };
}

function detail(overrides: Partial<OrderLabelDataDetailDto> = {}): OrderLabelDataDetailDto {
  return {
    detailId: 101,
    orderId: 42,
    detailNumber: '1',
    detailName: 'Side',
    height: 800,
    width: 600,
    quantity: 1,
    materialName: 'МДФ 16',
    note: 'note',
    basisProject: null,
    basisData: null,
    detailFields: {},
    orderFields: {},
    bazisFields: {},
    customFields: {},
    customFieldSchemaSnapshot: {},
    version: 1,
    staleCustomFieldIds: [],
    ...overrides,
  };
}
