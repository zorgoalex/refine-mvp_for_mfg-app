import { describe, expect, it } from 'vitest';
import {
  BAZIS_COLUMN_LABELS,
  BAZIS_FIELD_CATALOG,
  DYNAMIC_LABEL_FIELDS,
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
