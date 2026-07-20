import { describe, expect, it } from 'vitest';
import type { LabelFieldCatalogItem, LabelTemplateElement } from '../../../api/types/labelsApi.types';
import {
  customFieldRowsFromSchema,
  customFieldRowsToSchema,
  describeLabelFieldSource,
  resolveLatestStateUpdate,
  snapElementCenters,
} from './labelTemplateEditorHelpers';

const elements: LabelTemplateElement[] = [
  {
    elementKey: 'moving',
    kind: 'text',
    sourceField: null,
    staticText: 'A',
    xMm: 2,
    yMm: 2,
    widthMm: 10,
    heightMm: 6,
  },
  {
    elementKey: 'target',
    kind: 'text',
    sourceField: null,
    staticText: 'B',
    xMm: 30,
    yMm: 20,
    widthMm: 20,
    heightMm: 10,
  },
];

describe('label template editor helpers', () => {
  it('snaps moving element center to the nearest peer center on both axes', () => {
    const result = snapElementCenters({
      elements,
      movingElementKey: 'moving',
      xMm: 34.2,
      yMm: 21.6,
      toleranceMm: 1,
    });

    expect(result).toEqual({
      xMm: 35,
      yMm: 22,
      guides: [
        { axis: 'vertical', positionMm: 40, targetElementKey: 'target' },
        { axis: 'horizontal', positionMm: 25, targetElementKey: 'target' },
      ],
    });
  });

  it('does not snap when peer centers are outside tolerance', () => {
    expect(snapElementCenters({
      elements,
      movingElementKey: 'moving',
      xMm: 10,
      yMm: 10,
      toleranceMm: 1,
    })).toEqual({ xMm: 10, yMm: 10, guides: [] });
  });

  it('snaps the visible centers of rotated elements', () => {
    const rotated: LabelTemplateElement[] = [
      { ...elements[0], rotationDeg: 90 },
      { ...elements[1], rotationDeg: 180 },
    ];

    expect(snapElementCenters({
      elements: rotated,
      movingElementKey: 'moving',
      xMm: 23.4,
      yMm: 10.3,
      toleranceMm: 1,
    })).toEqual({
      xMm: 23,
      yMm: 10,
      guides: [
        { axis: 'vertical', positionMm: 20, targetElementKey: 'target' },
        { axis: 'horizontal', positionMm: 15, targetElementKey: 'target' },
      ],
    });
  });

  it('serializes constant text and source mappings without hidden source fallbacks', () => {
    const schema = {
      'custom.caption': {
        type: 'string',
        label: 'Подпись',
        defaultValue: 'Собрано вручную',
      },
      'custom.client': {
        type: 'string',
        label: 'Клиент',
        sourceField: 'order.client_name',
        defaultValue: 'Клиент не указан',
      },
    };

    expect(customFieldRowsToSchema(customFieldRowsFromSchema(schema))).toEqual({
      'custom.caption': {
        type: 'string',
        label: 'Подпись',
        defaultValue: 'Собрано вручную',
      },
      'custom.client': {
        type: 'string',
        label: 'Клиент',
        sourceField: 'order.client_name',
      },
    });
  });

  it('opens legacy value-less fields as editable constant fields', () => {
    expect(customFieldRowsFromSchema({
      'custom.legacy': { type: 'string', label: 'Старое поле' },
    })[0]).toMatchObject({
      valueMode: 'constant',
      defaultValue: '',
    });
  });

  it('resolves sequential updates against the latest synchronous value', () => {
    const first = resolveLatestStateUpdate([1], (current) => [...current, 2]);
    const second = resolveLatestStateUpdate(first, (current) => [...current, 3]);

    expect(second).toEqual([1, 2, 3]);
  });

  it.each([
    [
      {
        id: 'detail.milling_type_name',
        source: 'detail',
        sourceColumn: 'milling_type_name',
        label: 'Фрезеровка',
        type: 'string',
        category: 'Деталь',
      },
      {
        entity: 'Деталь заказа',
        databasePath: 'order_details_view.milling_type_name',
      },
    ],
    [
      {
        id: 'order.client_name',
        source: 'order',
        sourceColumn: 'client_name',
        label: 'Клиент',
        type: 'string',
        category: 'Заказ',
      },
      {
        entity: 'Заказ',
        databasePath: 'orders_view.client_name',
      },
    ],
    [
      {
        id: 'date.today',
        source: 'dynamic',
        sourceColumn: null,
        label: 'Сегодня',
        type: 'date',
        category: 'Динамические',
      },
      {
        entity: 'Вычисляемое поле',
        databasePath: 'В БД не хранится',
      },
    ],
  ] satisfies Array<[LabelFieldCatalogItem, { entity: string; databasePath: string }]>)(
    'describes the database source for $id',
    (field, expected) => {
      expect(describeLabelFieldSource(field)).toEqual(expected);
    },
  );

  it('describes custom field schema and stored values separately', () => {
    expect(describeLabelFieldSource({
      id: 'custom.operator_note',
      source: 'dynamic',
      sourceColumn: null,
      label: 'Комментарий оператора',
      type: 'string',
      category: 'Кастомные',
    })).toEqual({
      entity: 'Пользовательское поле шаблона',
      databasePath: 'label_templates.custom_field_schema (источник/константа) · order_label_detail_data.custom_fields (переопределение)',
    });
  });
});
