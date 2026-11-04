import { describe, expect, it } from 'vitest';
import { normalizeSaveOrderDto } from '../domain/order-normalizer';
import { validateSaveOrderDto } from '../domain/order-validation';
import { orderDeliveryFieldsView, orderDeliveryInsert, orderDeliveryUpdateSet } from './order-delivery-fields';

describe('order delivery / start shift fields (ERP → 1C phase 1, slice B)', () => {
  it('an absent key adds nothing to the statement (keeps the stored value); an explicit null clears', () => {
    expect(orderDeliveryUpdateSet({}, 27)).toEqual({ sql: '', values: [] });
    expect(orderDeliveryUpdateSet({ deliveryAddress: null }, 27)).toEqual({ sql: ', delivery_address = $27', values: [null] });
    expect(orderDeliveryUpdateSet({ deliveryMethod: 'courier', startShift: 2 }, 27))
      .toEqual({ sql: ', delivery_method = $27, start_shift = $28', values: ['courier', 2] });
  });

  it('INSERT fragments follow the same rule and numbering', () => {
    expect(orderDeliveryInsert({}, 34)).toEqual({ columns: '', placeholders: '', values: [] });
    expect(orderDeliveryInsert({ deliveryNotes: 'звонить', startShift: 1 }, 34))
      .toEqual({ columns: ', delivery_notes, start_shift', placeholders: ', $34, $35', values: ['звонить', 1] });
  });

  it('read view maps the columns and ignores unknown methods', () => {
    expect(orderDeliveryFieldsView({ delivery_method: 'pickup', delivery_address: 'ул. 1', delivery_notes: null, start_shift: '3' }))
      .toEqual({ deliveryMethod: 'pickup', deliveryAddress: 'ул. 1', deliveryNotes: null, startShift: 3 });
    expect(orderDeliveryFieldsView({ delivery_method: 'other' }).deliveryMethod).toBeNull();
  });

  it('the normalizer keeps absent keys absent (an older form) and trims present ones', () => {
    const base = { orderName: '1', clientId: 1, orderDate: '2026-11-05', orderStatusId: 1 };
    const absent = normalizeSaveOrderDto({ header: base, details: [], payments: [], workshops: [], requirements: [], dowelingLinks: [], deleted: {} } as never);
    for (const key of ['deliveryMethod', 'deliveryAddress', 'deliveryNotes', 'startShift']) {
      expect(Object.prototype.hasOwnProperty.call(absent.header, key)).toBe(false);
    }
    const present = normalizeSaveOrderDto({
      header: { ...base, deliveryMethod: 'courier', deliveryAddress: '  ул. Абая 1  ', deliveryNotes: '', startShift: '2' },
      details: [], payments: [], workshops: [], requirements: [], dowelingLinks: [], deleted: {},
    } as never);
    expect([present.header.deliveryMethod, present.header.deliveryAddress, present.header.deliveryNotes, present.header.startShift])
      .toEqual(['courier', 'ул. Абая 1', null, 2]);
  });

  it('validation rejects an unknown method, a shift outside 1..3 and too long texts', () => {
    const base = { orderName: '1', clientId: 1, orderDate: '2026-11-05', orderStatusId: 1 };
    const check = (extra: Record<string, unknown>) => () => validateSaveOrderDto(normalizeSaveOrderDto({
      header: { ...base, ...extra }, details: [], payments: [], workshops: [], requirements: [], dowelingLinks: [], deleted: {},
    } as never), { mode: 'create' } as never);
    const fields = (extra: Record<string, unknown>) => {
      try { check(extra)(); return []; } catch (error) { const e = error as { details?: { errors?: Array<{ field: string }> }; errors?: Array<{ field: string }> }; return (e.details?.errors ?? e.errors ?? []).map((item) => item.field); }
    };
    expect(fields({ deliveryMethod: 'drone' })).toContain('header.deliveryMethod');
    expect(fields({ startShift: 4 })).toContain('header.startShift');
    expect(fields({ startShift: 0 })).toContain('header.startShift');
    expect(fields({ deliveryAddress: 'а'.repeat(501) })).toContain('header.deliveryAddress');
    expect(fields({ deliveryNotes: 'а'.repeat(1001) })).toContain('header.deliveryNotes');
    for (const extra of [{ deliveryMethod: 'pickup', startShift: 3, deliveryAddress: 'а'.repeat(500) }, { deliveryMethod: null, startShift: null }]) {
      expect(fields(extra).filter((field) => field.startsWith('header.delivery') || field === 'header.startShift')).toEqual([]);
    }
  });
});
