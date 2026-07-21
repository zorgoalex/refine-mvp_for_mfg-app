import { describe, expect, it } from 'vitest';
import type { LabelFieldCatalogItem, LabelTemplateElement } from '../../../api/types/labelsApi.types';
import {
  customFieldRowsFromSchema,
  customFieldRowsToSchema,
  centerLabelSelection,
  claimLabelGestureCommit,
  describeLabelFieldSource,
  findSameRowHeightSuggestion,
  groupLabelElements,
  labelConditionFieldIds,
  moveLabelDragGesture,
  normalizeLabelMultiSelectionTransform,
  readLabelEditorMeta,
  readLabelIfElseCondition,
  readAndNormalizeLabelTransformedNodes,
  readLabelTypography,
  resolveLabelElementPreviewText,
  resolveLatestStateUpdate,
  selectLabelElements,
  snapElementCenters,
  ungroupLabelElements,
  withLabelEditorMeta,
  withLabelTypography,
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

  it('round-trips strict typography and nested editor metadata without losing siblings', () => {
    const initial: LabelTemplateElement = {
      ...elements[0],
      style: { locked: true, editor: { version: 1, groupId: 'g-1', boundsMode: 'auto' } },
    };
    const typography = withLabelTypography(initial, { fontSizePt: 14, fontWeight: 'bold', italic: true });
    const manual = withLabelEditorMeta(typography, { boundsMode: 'manual' });

    expect(readLabelTypography(manual)).toEqual({ version: 1, fontSizePt: 14, fontWeight: 'bold', italic: true });
    expect(readLabelEditorMeta(manual)).toEqual({ version: 1, boundsMode: 'manual', groupId: 'g-1' });
    expect(manual.style).toMatchObject({ locked: true });
  });

  it('resolves if/else preview values with field, text, current, and hidden branches', () => {
    const conditional: LabelTemplateElement = {
      ...elements[0],
      sourceField: 'detail.detail_name',
      condition: {
        type: 'if_else',
        version: 1,
        when: { field: 'detail.material_name', op: 'equals', value: 'МДФ' },
        then: { type: 'field', field: 'order.order_name' },
        else: { type: 'text', value: 'Не МДФ' },
      },
    };
    const values = new Map<string, string>([
      ['detail.material_name', 'МДФ'],
      ['detail.detail_name', 'Фасад'],
      ['order.order_name', 'Заказ 42'],
    ]);

    expect(resolveLabelElementPreviewText(conditional, values, new Map())).toBe('Заказ 42');
    values.set('detail.material_name', 'ЛДСП');
    expect(resolveLabelElementPreviewText(conditional, values, new Map())).toBe('Не МДФ');
    conditional.condition = { ...conditional.condition, else: { type: 'current' } };
    expect(resolveLabelElementPreviewText(conditional, values, new Map())).toBe('Фасад');
    conditional.condition = { ...conditional.condition, else: { type: 'hidden' } };
    expect(resolveLabelElementPreviewText(conditional, values, new Map())).toBe('');
    expect(labelConditionFieldIds(conditional.condition)).toEqual([
      'detail.material_name',
      'order.order_name',
    ]);
  });

  it.each([
    { type: 'if_else', version: 1, when: { field: 'a', op: 'exists', value: 'extra' }, then: { type: 'current' }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'a', op: 'equals' }, then: { type: 'current' }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'a', op: 'equals', value: { nested: true } }, then: { type: 'current' }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'a', op: 'exists' }, then: { type: 'current', extra: true }, else: { type: 'hidden' } },
    { type: 'if_else', version: 1, when: { field: 'a', op: 'exists' }, then: { type: 'text', value: 'x', extra: true }, else: { type: 'hidden' } },
  ])('rejects the same malformed if/else shapes as the renderer: %j', (condition) => {
    expect(readLabelIfElseCondition(condition)).toBeNull();
  });

  it('suggests a nearby same-row field height but ignores another level', () => {
    expect(findSameRowHeightSuggestion({
      elements: [
        { ...elements[0], xMm: 2, yMm: 10, widthMm: 10, heightMm: 6 },
        { ...elements[1], xMm: 20, yMm: 9.8, widthMm: 20, heightMm: 8 },
        { ...elements[1], elementKey: 'other-row', yMm: 30, heightMm: 7.8 },
      ],
      movingElementKey: 'moving',
      proposedHeightMm: 7.4,
      rowToleranceMm: 1.5,
      heightToleranceMm: 1,
    })).toEqual({ targetElementKey: 'target', heightMm: 8 });
  });

  it('expands persisted groups atomically and supports Shift toggling', () => {
    const grouped = groupLabelElements(elements, ['moving', 'target'], 'group-1');
    expect(selectLabelElements(grouped, [], 'moving', false)).toEqual(['moving', 'target']);
    expect(selectLabelElements(grouped, ['moving', 'target'], 'moving', true)).toEqual([]);
    expect(ungroupLabelElements(grouped, ['moving', 'target']).map(readLabelEditorMeta))
      .toEqual([
        { version: 1, boundsMode: 'auto', groupId: null },
        { version: 1, boundsMode: 'auto', groupId: null },
      ]);
  });

  it('centers rotated selection AABB while preserving relative geometry', () => {
    const rotated = [
      { ...elements[0], xMm: 5, yMm: 4, widthMm: 10, heightMm: 4, rotationDeg: 90 },
      { ...elements[1], xMm: 20, yMm: 8, widthMm: 8, heightMm: 6, rotationDeg: 0 },
    ];
    const centered = centerLabelSelection(rotated, ['moving', 'target'], 60, 40, 'horizontal');
    const dxA = centered[0].xMm - rotated[0].xMm;
    const dxB = centered[1].xMm - rotated[1].xMm;
    expect(dxA).toBeCloseTo(dxB, 5);
    expect(centered[0].yMm).toBe(rotated[0].yMm);
    expect(centered[1].yMm).toBe(rotated[1].yMm);
  });

  it('reads every transformed node before normalization and claims one commit only', () => {
    const log: string[] = [];
    const fakeNode = (key: string, initial: { x: number; y: number; width: number; height: number; scaleX: number; scaleY: number; rotation: number }) => {
      const state = { ...initial };
      const accessor = (name: keyof typeof state) => (value?: number) => {
        log.push(`${value === undefined ? 'read' : 'write'}:${key}:${name}`);
        if (value !== undefined) state[name] = value;
        return state[name];
      };
      return {
        x: accessor('x'),
        y: accessor('y'),
        width: accessor('width'),
        height: accessor('height'),
        scaleX: accessor('scaleX'),
        scaleY: accessor('scaleY'),
        rotation: accessor('rotation'),
        state,
      };
    };
    const first = fakeNode('moving', { x: 3, y: 4, width: 10, height: 6, scaleX: 2, scaleY: 1.5, rotation: 15 });
    const second = fakeNode('target', { x: 20, y: 7, width: 20, height: 10, scaleX: 0.5, scaleY: 0.8, rotation: 30 });
    const nodes = new Map([
      ['moving', first],
      ['target', second],
    ]);

    const snapshots = readAndNormalizeLabelTransformedNodes(elements, nodes);

    expect(snapshots).toMatchObject([
      { elementKey: 'moving', widthMm: 20, heightMm: 9, rotationDeg: 15 },
      { elementKey: 'target', widthMm: 10, heightMm: 8, rotationDeg: 30 },
    ]);
    const firstWrite = log.findIndex((entry) => entry.startsWith('write:'));
    const lastRead = log.reduce((last, entry, index) => entry.startsWith('read:') ? index : last, -1);
    expect(firstWrite).toBeGreaterThan(lastRead);
    expect(first.state).toMatchObject({ width: 20, height: 9, scaleX: 1, scaleY: 1 });
    expect(second.state).toMatchObject({ width: 10, height: 8, scaleX: 1, scaleY: 1 });

    const token = { id: 1, committed: false };
    expect(claimLabelGestureCommit(token)).toBe(true);
    expect(claimLabelGestureCommit(token)).toBe(false);
  });

  it('updates every grouped drag move and commits only the first drag end', () => {
    const gesture = {
      id: 7,
      committed: false,
      ownerStart: { x: 2, y: 2 },
      starts: new Map([
        ['moving', { x: 2, y: 2 }],
        ['target', { x: 30, y: 20 }],
      ]),
    };
    const bounds = { minX: 2, minY: 2, maxX: 50, maxY: 30 };

    expect(moveLabelDragGesture(gesture, { x: 5, y: 6 }, bounds, { width: 100, height: 80 }))
      .toEqual([
        { elementKey: 'moving', x: 5, y: 6 },
        { elementKey: 'target', x: 33, y: 24 },
      ]);
    expect(moveLabelDragGesture(gesture, { x: 10, y: 12 }, bounds, { width: 100, height: 80 }))
      .toEqual([
        { elementKey: 'moving', x: 10, y: 12 },
        { elementKey: 'target', x: 38, y: 30 },
      ]);
    expect(gesture.committed).toBe(false);
    expect(claimLabelGestureCommit(gesture)).toBe(true);
    expect(claimLabelGestureCommit(gesture)).toBe(false);
    expect(moveLabelDragGesture(gesture, { x: 20, y: 20 }, bounds, { width: 100, height: 80 })).toEqual([]);
  });

  it('normalizes a mixed QR/text transform once for the whole selection', () => {
    const mixed: LabelTemplateElement[] = [
      { ...elements[0], elementKey: 'qr', kind: 'qr', xMm: 2, yMm: 2, widthMm: 10, heightMm: 10, rotationDeg: 0 },
      { ...elements[1], elementKey: 'text', xMm: 20, yMm: 2, widthMm: 20, heightMm: 5, rotationDeg: 0 },
    ];
    const normalized = normalizeLabelMultiSelectionTransform({
      elements: mixed,
      snapshots: [
        { elementKey: 'qr', xMm: 3.2, yMm: 4.4, widthMm: 15, heightMm: 15, rotationDeg: 0 },
        { elementKey: 'text', xMm: 30.2, yMm: 4.4, widthMm: 30, heightMm: 7.5, rotationDeg: 0 },
      ],
      canvasWidthMm: 100,
      canvasHeightMm: 80,
      snapToGrid: true,
      rotationStep: 1,
    });

    expect(normalized).toMatchObject([
      { elementKey: 'qr', xMm: 3, yMm: 4, widthMm: 15, heightMm: 15 },
      { elementKey: 'text', xMm: 30, yMm: 4, widthMm: 30, heightMm: 7.5 },
    ]);
    expect(normalized[1].xMm - normalized[0].xMm).toBeCloseTo(27, 8);
    expect(normalized[0].widthMm).toBe(normalized[0].heightMm);
    expect(normalized[1].widthMm / mixed[1].widthMm).toBeCloseTo(
      normalized[0].widthMm / Number(mixed[0].widthMm),
      8,
    );
  });
});
