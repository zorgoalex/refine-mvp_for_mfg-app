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
          basisData: '7 D-01 - Parsed name',
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
});

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
    bazisFields: {},
    customFields: {},
    customFieldSchemaSnapshot: {},
    version: 1,
    staleCustomFieldIds: [],
    ...overrides,
  };
}
